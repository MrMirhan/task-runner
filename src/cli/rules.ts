import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { RULE_SCOPES, type RuleKey, type RuleScope } from "../core/rules.ts";
import { detectProject } from "../node/project.ts";
import {
  clearRemote, deviceInfo, loadRemote, openRulesClient, RemoteRulesClient, saveRemote, setDeviceLabel,
  type RulesClient,
} from "../node/remote.ts";
import { flag, openStore } from "./commands.ts";

const has = (args: string[], name: string) => args.includes(name);
const valueFlags = new Set(["--scope", "--ref", "--device-id", "--file", "--key", "--label", "--cwd", "--url"]);

/** Words that are not flags and not the value of a flag: the text of a rule, or an id. */
function words(args: string[]): string[] {
  return args.filter((a, i) => !a.startsWith("--") && !(i > 0 && valueFlags.has(args[i - 1])));
}

function context(args: string[]) {
  const { store, db } = openStore();
  const detected = detectProject(resolve(flag(args, "--cwd") ?? process.cwd()), (p) => store.findProjectByPath(p));
  const device = deviceInfo();
  return { db, detected, device, client: openRulesClient(db) };
}

function scopeOf(args: string[], c: ReturnType<typeof context>): RuleKey {
  const explicit = flag(args, "--scope");
  const project = has(args, "--project");
  const org = has(args, "--org");
  const device = has(args, "--device");
  const scope = (explicit ??
    (project && device ? "project_device" : project ? "project" : org ? "org" : device ? "device" : "global")) as RuleScope;
  if (!(RULE_SCOPES as readonly string[]).includes(scope)) throw new Error(`Unknown scope '${scope}'. Use ${RULE_SCOPES.join(", ")}.`);
  const ref =
    flag(args, "--ref") ?? (scope === "org" ? c.detected.org : scope === "project" || scope === "project_device" ? c.detected.project : null);
  return { scope, ref, device: flag(args, "--device-id") ?? (scope === "device" || scope === "project_device" ? c.device.id : null) };
}

const describe = (k: RuleKey, labels: Map<string, string>) =>
  k.scope === "global" ? "global"
  : k.scope === "device" ? `device ${labels.get(k.device ?? "") ?? k.device}`
  : k.scope === "org" ? `org ${k.ref}`
  : k.scope === "project" ? `project ${k.ref}`
  : `project ${k.ref} on device ${labels.get(k.device ?? "") ?? k.device}`;

async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return readFileSync(0, "utf8").trim();
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

export async function loginCommand(args: string[]): Promise<void> {
  const url = (words(args)[0] ?? flag(args, "--url") ?? "").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(url)) throw new Error("Usage: task-runner-mcp login <https://your-worker.workers.dev> [--key KEY] [--label name]");
  if (url.startsWith("http://") && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(url)) {
    throw new Error("Refusing a plain http:// server: the key would travel unencrypted. Use https://.");
  }
  const key = flag(args, "--key") ?? process.env.TASK_RUNNER_REMOTE_KEY ?? (await readSecret("Server key: "));
  if (!key) throw new Error("No key given.");

  const client = new RemoteRulesClient({ url, key });
  try {
    await client.listDevices();
  } catch (error) {
    throw new Error(`Could not sign in to ${url}: ${error instanceof Error ? error.message : error}`);
  }
  const label = flag(args, "--label");
  const device = label ? setDeviceLabel(label) : deviceInfo();
  await client.registerDevice(device);
  saveRemote({ url, key });
  console.log(`Signed in to ${url} as device "${device.label}" (${device.id}).`);
  console.log("Rules are now read from the server at the start of every session. Edit them on the web page or with `task-runner-mcp rules`.");
}

export function logoutCommand(): void {
  console.log(clearRemote() ? "Signed out. Rules come from this machine again." : "Not signed in.");
}

export async function rulesCommand(args: string[]): Promise<void> {
  const sub = words(args)[0] && !args[0]?.startsWith("--") ? args[0] : "show";
  const rest = args[0] === sub ? args.slice(1) : args;
  const c = context(args);
  try {
    const devices = await c.client.listDevices().catch(() => []);
    const labels = new Map(devices.map((d) => [d.id, d.label]));
    const where = c.client.mode === "remote" ? `server ${loadRemote()?.url}` : "this machine";

    switch (sub) {
      case "show": {
        const r = await c.client.resolve({ project: c.detected.project, org: c.detected.org, device: c.device.id });
        if (has(rest, "--json")) {
          console.log(JSON.stringify({ project: c.detected.project, org: c.detected.org, device: c.device, source: where, ...r }));
          return;
        }
        console.log(`Rules for project ${c.detected.project}, org ${c.detected.org ?? "(none)"}, device ${c.device.label} (from ${where}):\n`);
        console.log(r.text || "(no rules yet. Add some with `task-runner-mcp rules set \"...\"` or on the web page.)");
        if (r.pending) console.log(`\n${r.pending} proposal(s) wait for approval: task-runner-mcp rules pending`);
        return;
      }
      case "list": {
        const docs = await c.client.listDocs();
        if (docs.length === 0) console.log("No rule documents yet.");
        for (const d of docs) {
          console.log(`# ${describe(d, labels)}  (v${d.version}, ${d.body.length} chars)\n${d.body}\n`);
        }
        return;
      }
      case "set":
      case "edit": {
        const key = scopeOf(rest, c);
        const docs = await c.client.listDocs();
        const current = docs.find((d) => d.scope === key.scope && d.ref === (key.ref ?? "") && d.device === (key.device ?? ""))?.body ?? "";
        let body: string;
        if (sub === "edit") {
          const dir = mkdtempSync(join(tmpdir(), "tr-rules-"));
          const file = join(dir, "rules.md");
          writeFileSync(file, current);
          const editor = process.env.VISUAL || process.env.EDITOR || "vi";
          execFileSync(editor, [file], { stdio: "inherit" });
          body = readFileSync(file, "utf8");
          rmSync(dir, { recursive: true, force: true });
        } else {
          const file = flag(rest, "--file");
          const typed = words(rest).join(" ");
          const piped = !file && !typed && !process.stdin.isTTY ? readFileSync(0, "utf8") : "";
          const text = file ? readFileSync(file, "utf8") : typed || piped;
          if (!text.trim() && !has(rest, "--clear")) throw new Error("Give the rule text, --file <path>, or --clear to remove the document.");
          body = has(rest, "--append") && current ? `${current}\n${text}` : has(rest, "--clear") ? "" : text;
        }
        const result = (await c.client.setDoc(key, body)) as { version?: number; removed?: boolean };
        console.log(result.removed ? `Removed the ${describe(key, labels)} rules.` : `Saved the ${describe(key, labels)} rules (v${result.version}).`);
        return;
      }
      case "pending": {
        const proposals = await c.client.listProposals("pending");
        if (has(rest, "--json")) {
          console.log(JSON.stringify(proposals.map((p) => ({ ...p, where: describe(p, labels) }))));
          return;
        }
        if (proposals.length === 0) console.log("No proposals are waiting.");
        for (const p of proposals) {
          console.log(`${p.id}  ${describe(p, labels)}  [${p.mode}] by ${p.author}${p.reason ? `\n  why: ${p.reason}` : ""}\n  ${p.text.replace(/\n/g, "\n  ")}\n`);
        }
        return;
      }
      case "approve": {
        const id = words(rest)[0];
        if (!id) throw new Error("Usage: task-runner-mcp rules approve <id> [--edit]");
        let edited: string | undefined;
        if (has(rest, "--edit")) {
          const p = (await c.client.listProposals("pending")).find((x) => x.id === id);
          if (!p) throw new Error(`Proposal '${id}' is not pending`);
          const dir = mkdtempSync(join(tmpdir(), "tr-rules-"));
          const file = join(dir, "proposal.md");
          writeFileSync(file, p.text);
          execFileSync(process.env.VISUAL || process.env.EDITOR || "vi", [file], { stdio: "inherit" });
          edited = readFileSync(file, "utf8");
          rmSync(dir, { recursive: true, force: true });
        }
        console.log(JSON.stringify(await c.client.approve(id, edited)));
        return;
      }
      case "reject": {
        const id = words(rest)[0];
        if (!id) throw new Error("Usage: task-runner-mcp rules reject <id>");
        console.log(JSON.stringify(await c.client.reject(id)));
        return;
      }
      case "devices":
        for (const d of devices) console.log(`${d.id}\t${d.label}\t${d.platform ?? ""}${d.id === c.device.id ? "\t(this device)" : ""}`);
        if (devices.length === 0) console.log("No devices registered.");
        return;
      case "rename-device": {
        const label = words(rest).join(" ");
        if (!label) throw new Error("Usage: task-runner-mcp rules rename-device <label>");
        setDeviceLabel(label);
        await c.client.registerDevice(deviceInfo());
        console.log(JSON.stringify(await c.client.renameDevice(c.device.id, label)));
        return;
      }
      default:
        throw new Error("Usage: task-runner-mcp rules [show | list | set | edit | pending | approve <id> | reject <id> | devices | rename-device <label>]");
    }
  } finally {
    c.db.close();
  }
}

export type { RulesClient };
