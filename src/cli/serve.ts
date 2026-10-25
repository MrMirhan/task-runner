import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "../mcp/server.ts";
import { SessionHolder } from "../mcp/session.ts";
import { openStore, projectFor } from "./commands.ts";

export async function serve(): Promise<void> {
  const { store, db } = openStore();
  const cwd = process.env.TASK_RUNNER_CWD || process.cwd();

  const session = new SessionHolder(() => {
    const detected = projectFor(store, cwd);
    return { project: detected.project, project_path: detected.project_path, branch: detected.branch, pr: null };
  });

  const server = createServer({
    store,
    session,
    fileExists: (root, relative) => existsSync(resolve(root, relative)),
  });

  const close = () => {
    try {
      db.close();
    } catch {
      // already closed
    }
  };
  process.on("exit", close);
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));

  await server.connect(new StdioServerTransport());
}
