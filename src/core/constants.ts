export const SERVER_NAME = "task-runner";
export const SERVER_VERSION = "1.1.0";

export const ENTITY_TYPES = [
  "preference",
  "decision",
  "pattern",
  "file",
  "concept",
  "tool",
  "pitfall",
  "convention",
] as const;

export const RELATION_TYPES = [
  "uses",
  "depends_on",
  "conflicts_with",
  "part_of",
  "prefers_over",
  "decided_against",
  "relates_to",
  "supersedes",
] as const;

export const ENTRY_TYPES = [
  "task_completed",
  "decision",
  "note",
  "change",
  "issue",
  "discovery",
] as const;

export const SCOPES = ["project", "branch", "pr"] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];
export type RelationType = (typeof RELATION_TYPES)[number];
export type EntryType = (typeof ENTRY_TYPES)[number];
export type Scope = (typeof SCOPES)[number];

export const GLOBAL_PROJECT = "_global";

/** Starting importance by type: rules and hazards outrank incidental facts in digests and recall. */
export const DEFAULT_IMPORTANCE: Record<EntityType, number> = {
  pitfall: 0.8,
  convention: 0.75,
  decision: 0.7,
  preference: 0.7,
  pattern: 0.6,
  tool: 0.5,
  concept: 0.45,
  file: 0.4,
};

export const MAX_FACT_LENGTH = 1000;
export const MAX_RESULT_SIZE = 51_200;
export const MAX_CONTEXT_ENTRIES = 100;
export const DEFAULT_CONTEXT_ENTRIES = 25;
export const MAX_SEARCH_RESULTS = 50;
export const MAX_RECALL_RESULTS = 20;
export const IMPORTANCE_HALF_LIFE_DAYS = 30;
export const STALE_RUNNING_SECONDS = 30 * 60;
