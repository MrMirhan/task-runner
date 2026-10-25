export type Tab = 'session' | 'taste' | 'tasks' | 'notes' | 'graph' | 'search' | 'time' | 'rules'

export type TaskRow = {
  id: string
  title: string
  status: string
  error: string | null
}

export type TaskSummary = {
  task_group: string
  total: number
  pending: number
  running: number
  completed: number
  failed: number
}

export type EntityRow = {
  id: string
  name: string
  entity_type: string
  summary: string | null
  importance: number
  project_key: string
}

export type Snapshot = {
  project: string
  branch: string | null
  stats: {
    entities: number
    relations: number
    observations: number
    entries: number
    tasks: number
    orphan_entities: number
  }
  tasks: { summary: TaskSummary; items: TaskRow[] } | null
  notes: Array<{ id: string; type: string; title: string; created_at: number }>
  entities: EntityRow[]
}

export type Detail = {
  name: string
  type: string
  summary: string | null
  facts: string[]
  relations: string[]
}

export type SearchState = {
  query: string
  entities: Array<{ name: string; entity_type: string; facts: string[] }>
  notes: string[]
}

export type WorklogView = {
  label: string
  totals: { you_s: number; agent_s: number; wall_s: number; tasks: number }
  rows: Array<{
    project: string
    label: string
    kind: string
    you_s: number
    agent_s: number
    wall_s: number
  }>
  days: Array<{ day: string; you_s: number; agent_s: number }>
}

export type RulesView = {
  parts: Array<{ label: string; chars: number }>
  chars: number
  source: string
  pending: Array<{
    id: string
    where: string
    mode: string
    author: string
    reason: string | null
    text: string
  }>
}

export type SessionView = {
  project: string
  branch: string | null
  location: string
  you_s: number
  agent_s: number
  wall_s: number
  started_at: number | null
  prompts: number
  edits: number
  first_prompt: string | null
  scopes: Array<{ project_key: string; branch: string; secs: number }>
  entities: Array<{ name: string; entity_type: string; is_new: boolean; new_facts: number; at: number }>
  notes: Array<{ id: string; type: string; title: string; created_at: number }>
}

export type TastePreference = {
  id: string
  scope: 'global' | 'org' | 'project'
  ref: string
  area: string
  rule: string
  confidence: number
  hits: number
  replaced: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'task-runner': {
      snapshot: Snapshot | null
      tab: Tab
      detail: Detail | null
      search: SearchState | null
      worklog: WorklogView | null
      rules: RulesView | null
      session: SessionView | null
      commits: string[]
      taste: TastePreference[] | null
      tasteMode: 'on' | 'off' | null
      tasteNote: string[]
      autoOpened: boolean
    }
  }
}
