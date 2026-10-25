import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerOptions } from "@modelcontextprotocol/sdk/server/index.js";
import { SERVER_NAME, SERVER_VERSION } from "../core/constants.ts";
import { registerTools, type ToolContext } from "./tools.ts";

export const INSTRUCTIONS = [
  "Persistent memory (knowledge graph plus notes) and a task runner. The project is detected from the working directory; set_context is only for overrides.",
  "Start work with recall(query) to find earlier decisions, pitfalls and conventions.",
  "While working, remember(name, observations) durable facts (one atomic fact per item; an existing name is extended) and link(from, to) related entities; save_memory is for session notes. Fix wrong facts with correct_fact instead of adding contradictions.",
  "Use scope 'global' for facts about the user that hold in every project.",
  "For multi-step work: create_task_group, then repeat get_next_task, do it, complete_task.",
].join("\n");

export function createServer(ctx: ToolContext, options: Omit<ServerOptions, "instructions"> = {}): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { ...options, instructions: INSTRUCTIONS },
  );
  registerTools(server, ctx);
  return server;
}
