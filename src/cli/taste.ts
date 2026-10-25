import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TasteInput } from "../core/store.ts";
import { formatTaste } from "../core/taste.ts";
import { openBackend } from "../node/backend.ts";
import { flag, projectFor } from "./commands.ts";

/**
 *   taste [list] [--json]                       what this folder's sessions follow
 *   taste learn --data '<json>' | < file.json   { items: TasteInput[], source? } (the panel calls this)
 *   taste forget <id>
 */
export async function tasteCommand(args: string[]): Promise<void> {
  const [first] = args;
  const sub = first && !first.startsWith("--") ? first : "list";
  const backend = openBackend();
  try {
    const { store } = backend;
    const detected = await projectFor(store, resolve(flag(args, "--cwd") ?? process.cwd()));
    if (sub === "list") {
      const rows = await store.tasteList({ project: detected.project, org: detected.org });
      if (args.includes("--json")) console.log(JSON.stringify({ project: detected.project, org: detected.org, preferences: rows }));
      else console.log(formatTaste(rows, Infinity) || "Nothing learned yet. Preferences you state in a session are picked up as you go.");
      return;
    }
    if (sub === "learn") {
      const raw = flag(args, "--data") ?? (process.stdin.isTTY ? "" : readFileSync(0, "utf8"));
      const payload = JSON.parse(raw || "{}") as { items?: TasteInput[]; source?: string };
      if (!Array.isArray(payload.items)) throw new Error("Usage: task-runner-mcp taste learn --data '{\"items\":[...]}'");
      console.log(JSON.stringify(await store.tasteLearn({ project: detected.project, org: detected.org, source: payload.source, items: payload.items })));
      return;
    }
    if (sub === "forget") {
      const id = args[1];
      if (!id || id.startsWith("--")) throw new Error("Usage: task-runner-mcp taste forget <id>");
      console.log(JSON.stringify(await store.tasteForget(id)));
      return;
    }
    throw new Error("Usage: task-runner-mcp taste [list | learn --data <json> | forget <id>]");
  } finally {
    backend.close();
  }
}
