#!/usr/bin/env node
import { SERVER_VERSION } from "../core/constants.ts";

// node:sqlite still prints an experimental-feature warning; keep stderr clean for MCP clients.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning.message;
  if (text.includes("SQLite")) return;
  return (emitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

function nodeIsTooOld(): string | null {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major > 22 || (major === 22 && minor >= 13)) return null;
  return `task-runner-mcp needs Node.js 22.13 or newer (found ${process.versions.node}).`;
}

const HELP = `task-runner-mcp ${SERVER_VERSION}
Persistent memory (knowledge graph + notes) and a task runner for AI coding agents.

Usage: task-runner-mcp [command]

  serve                      Run the MCP server on stdio (default when piped)
  hook session-start         Print the SessionStart hook output for Claude Code
  snapshot [--cwd d] [--query q | --entity name]
  session --id <session id> [--cwd d]          this session's time and what it saved
                             JSON view of a project's tasks, notes and graph
  worklog [--week|--today|--last-week|--month|--from D --to D] [--project k|.] [--exclude a*,b] [--format text|md|csv|json] [--detail]
                             Time per project and task: you vs the agent
  worklog pending | exported <project> <branch> | scan
  rules [show|list|set|edit|pending|approve|reject|devices]
                             Rules injected at session start: global, device, org, project
  login <url> | logout       Keep rules on a Task Runner server (Cloudflare Worker)
  forget <name> [--type t]   Retire an entity in the current project
  note <text> [--type t]     Save a note for the current project
  dashboard [--port 4747]    Browse memory in a local web UI
  export [--project k] [--format json|markdown] [--out path]
  import <file.json>
  projects [list | merge <from> <into> --yes | delete <key> --yes]
  doctor                     Check the installation
  version

Environment:
  TASK_RUNNER_DB       database file (default ~/.task-runner/memory.db)
  TASK_RUNNER_HOME     directory for the default database
  TASK_RUNNER_PROJECT  force the project key
`;

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  const tooOld = nodeIsTooOld();
  if (tooOld) {
    // A session hook must still print valid JSON so the session starts.
    if (command === "hook") process.stdout.write(`${JSON.stringify({ systemMessage: tooOld })}\n`);
    else console.error(tooOld);
    process.exit(command === "hook" ? 0 : 1);
  }

  switch (command ?? (process.stdin.isTTY ? "help" : "serve")) {
    case "serve": {
      const { serve } = await import("./serve.ts");
      await serve();
      return;
    }
    case "hook": {
      if (args[0] !== "session-start") {
        console.error("Usage: task-runner-mcp hook session-start");
        process.exit(1);
      }
      await (await import("./commands.ts")).hookSessionStart();
      return;
    }
    case "snapshot":
      return await (await import("./commands.ts")).snapshot(args);
    case "session":
      return await (await import("./worklog.ts")).sessionCommand(args);
    case "dashboard": {
      const { dashboard } = await import("./dashboard.ts");
      await dashboard(args);
      return;
    }
    case "worklog": {
      const { worklogCommand } = await import("./worklog.ts");
      try {
        await worklogCommand(args);
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
      }
      return;
    }
    case "login":
    case "logout":
    case "rules": {
      const mod = await import("./rules.ts");
      try {
        if (command === "login") await mod.loginCommand(args);
        else if (command === "logout") mod.logoutCommand();
        else await mod.rulesCommand(args);
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
      }
      return;
    }
    case "forget":
      return await (await import("./commands.ts")).forgetCommand(args);
    case "note":
      return await (await import("./commands.ts")).noteCommand(args);
    case "export":
      return await (await import("./commands.ts")).exportCommand(args);
    case "import":
      return await (await import("./commands.ts")).importCommand(args);
    case "projects":
      return await (await import("./commands.ts")).projectsCommand(args);
    case "doctor":
      return await (await import("./commands.ts")).doctor();
    case "version":
    case "--version":
    case "-v":
      console.log(SERVER_VERSION);
      return;
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    default:
      console.error(`Unknown command '${command}'.\n\n${HELP}`);
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
