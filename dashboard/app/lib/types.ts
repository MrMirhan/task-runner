export interface Entity {
  id: string;
  name: string;
  entity_type: EntityType;
  summary: string | null;
  importance: number;
  access_count: number;
  last_accessed: number;
  created_at: number;
  properties: string | null;
  observation_count: number;
}

export type EntityType =
  | "preference"
  | "decision"
  | "pattern"
  | "file"
  | "concept"
  | "tool"
  | "pitfall"
  | "convention";

export interface Relation {
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

export interface Observation {
  id: string;
  content: string;
  confidence: number;
  valid_from: number;
  created_at: number;
}

export interface Project {
  key: string;
  project_path: string | null;
  project_name: string | null;
  created_at: number;
  updated_at: number;
}

export interface GraphData {
  entities: Entity[];
  relations: Relation[];
  entity_count: number;
  relation_count: number;
}

export interface GraphStats {
  entities: number;
  entity_types: Array<{ entity_type: string; cnt: number }>;
  relations: number;
  observations: number;
  entries: number;
  top_entities: Array<{
    name: string;
    entity_type: string;
    importance: number;
    access_count: number;
  }>;
}

export interface MemoryEntry {
  id: string;
  project_key: string;
  scope: string;
  scope_ref: string | null;
  type: string;
  title: string;
  content: string;
  tags: string | null;
  created_at: number;
}

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "timeout";

export interface TaskItem {
  id: string;
  task_group: string;
  index_num: number;
  title: string;
  content: string;
  status: TaskStatus;
  result: string | null;
  error: string | null;
  system_prompt: string | null;
  started_at: number | null;
  completed_at: number | null;
  execution_time_ms: number | null;
  result_size: number | null;
  created_at: number;
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

export interface TaskSummary {
  project_name: string;
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
  total_execution_time_ms: number;
}

export const ENTITY_COLORS: Record<EntityType, string> = {
  preference: "#8b5cf6",
  decision: "#f59e0b",
  pattern: "#10b981",
  file: "#6b7280",
  concept: "#3b82f6",
  tool: "#ef4444",
  pitfall: "#f97316",
  convention: "#06b6d4",
};
