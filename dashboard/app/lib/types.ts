// Shapes returned by the JSON API (src/cli/rest.ts). Timestamps are unix seconds.

export const GLOBAL_PROJECT = "_global";

export type EntityType =
  | "preference"
  | "decision"
  | "pattern"
  | "file"
  | "concept"
  | "tool"
  | "pitfall"
  | "convention";

export interface Project {
  key: string;
  project_path: string | null;
  project_name: string | null;
  created_at: number;
  updated_at: number;
}

export interface Entity {
  id: string;
  project_key: string;
  name: string;
  entity_type: EntityType;
  summary: string | null;
  properties: string | null;
  importance: number;
  access_count: number;
  last_accessed: number;
  created_at: number;
  updated_at: number;
}

/** Entity as listed by GET /graph/all. */
export interface GraphEntity extends Entity {
  observation_count: number;
}

export interface GraphRelation {
  id: string;
  source_id: string;
  target_id: string;
  relation_type: string;
  weight: number;
  context: string | null;
  source_name: string;
  source_type: string;
  target_name: string;
  target_type: string;
}

export interface GraphData {
  entities: GraphEntity[];
  relations: GraphRelation[];
  entity_count: number;
  relation_count: number;
}

export interface GraphStats {
  entities: number;
  relations: number;
  observations: number;
  orphan_entities: number;
  entries: number;
  tasks: number;
  entity_types: Array<{ entity_type: string; cnt: number }>;
  top_entities: Array<{
    name: string;
    entity_type: string;
    importance: number;
    access_count: number;
    last_accessed: number;
  }>;
}

export interface Observation {
  id: string;
  content: string;
  confidence: number;
  created_at: number;
}

export interface OutgoingRelation {
  id: string;
  relation_type: string;
  weight: number;
  context: string | null;
  target_name: string;
  target_type: string;
}

export interface IncomingRelation {
  id: string;
  relation_type: string;
  weight: number;
  context: string | null;
  source_name: string;
  source_type: string;
}

/** GET /entities?id=... */
export interface EntityDetail {
  entity: Entity;
  observations: Observation[];
  relations: {
    outgoing: OutgoingRelation[];
    incoming: IncomingRelation[];
  };
}

export interface MemoryEntry {
  id: string;
  project_key: string;
  scope: "project" | "branch" | "pr";
  scope_ref: string | null;
  type: string;
  title: string;
  content: string;
  tags: string | null;
  session_id: string | null;
  created_at: number;
}

export interface ScopeFilter {
  scope: "branch" | "pr";
  ref: string;
}

export type TaskStatus = "pending" | "running" | "completed" | "failed";

/** One row of GET /tasks/status. Content and result come from /tasks/result. */
export interface TaskItem {
  id: string;
  title: string;
  status: TaskStatus;
  started_at: number | null;
  completed_at: number | null;
  execution_time_ms: number | null;
  result_size: number | null;
  error: string | null;
}

export interface TaskGroup {
  task_group: string;
  total: number;
  completed: number;
  failed: number;
  pending: number;
  running: number;
  created_at: number;
}

export interface TaskResult {
  task_id: string;
  task_group: string;
  title: string;
  status: TaskStatus;
  result: string | null;
  error: string | null;
}

export const ENTITY_COLORS: Record<EntityType, string> = {
  preference: "#a78bfa",
  decision: "#f59e0b",
  pattern: "#10b981",
  file: "#94a3b8",
  concept: "#3b82f6",
  tool: "#ef4444",
  pitfall: "#f97316",
  convention: "#06b6d4",
};

export function entityColor(type: string): string {
  return ENTITY_COLORS[type as EntityType] ?? "#94a3b8";
}

export function projectLabel(project: Project, all: Project[]): string {
  if (project.key === GLOBAL_PROJECT) return "Global (all projects)";
  const name = project.project_name || project.key;
  const clash = all.some((p) => p.key !== project.key && (p.project_name || p.key) === name);
  return clash ? `${name} (${project.key})` : name;
}
