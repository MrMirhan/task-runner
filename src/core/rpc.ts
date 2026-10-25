import { StoreError } from "./errors.ts";
import type { RulesStore } from "./rules.ts";
import type { Store } from "./store.ts";

/** Store methods a client may call over the wire. Everything else (internals, migrations) stays inside. */
export const STORE_METHODS = [
  "setContext", "findProjectByPath", "findProjectByPathPrefix", "projectPaths", "listProjects", "deleteProject", "mergeProjects",
  "saveEntry", "getContext", "updateEntry", "deleteEntry", "searchEntries",
  "upsertEntity", "addFacts", "correctFact", "link", "unlink", "deleteRelation", "forget", "getEntity", "describe",
  "findEntityById", "neighbors", "recall", "graphAll", "graphStats", "entityNames", "consolidate", "digest", "snapshot",
  "createTasks", "nextTask", "completeTask", "failTask", "taskStatus", "taskSummary", "taskResult", "latestGroup",
  "listTaskGroups", "clearTasks",
  "worklogFileStates", "worklogSetting", "setWorklogSetting", "clearWorklog", "dropWorklogFiles", "replaceWorklogFile", "worklogRows",
  "worklogActivity", "worklogPending", "worklogMarkExported", "worklogSession", "changedSince", "tasteList", "tasteLearn", "tasteForget", "totals",
  "exportAll", "importAll",
] as const;

export const RULES_METHODS = [
  "listDocs", "getDoc", "setDoc", "deleteDoc", "revisions", "resolve", "propose", "getProposal", "listProposals",
  "approve", "reject", "pendingCount", "registerDevice", "renameDevice", "listDevices",
] as const;

export interface RpcCall {
  target: "store" | "rules";
  method: string;
  args: unknown[];
}

export type RpcResult = { result: unknown } | { error: string; code: string };

export function handleRpc(store: Store, rules: RulesStore, call: RpcCall): { status: number; body: RpcResult } {
  const allowed: readonly string[] = call?.target === "rules" ? RULES_METHODS : STORE_METHODS;
  const target = (call?.target === "rules" ? rules : store) as unknown as Record<string, (...a: unknown[]) => unknown>;
  if (!call || (call.target !== "store" && call.target !== "rules") || !allowed.includes(call.method)) {
    return { status: 400, body: { error: `Unknown call ${call?.target}.${call?.method}`, code: "invalid" } };
  }
  try {
    const result = target[call.method].apply(target, Array.isArray(call.args) ? call.args : []);
    return { status: 200, body: { result: result === undefined ? null : result } };
  } catch (error) {
    if (error instanceof StoreError) {
      return { status: error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : 400, body: { error: error.message, code: error.code } };
    }
    return { status: 500, body: { error: error instanceof Error ? error.message : "Internal error", code: "internal" } };
  }
}
