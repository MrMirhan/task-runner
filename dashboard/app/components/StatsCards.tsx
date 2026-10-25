"use client";

import type { GraphStats, TaskGroup } from "../lib/types";

interface Props {
  stats: GraphStats | null;
  taskGroups: TaskGroup[];
}

const cards = [
  { key: "entities" as const, label: "Entities", color: "text-info" },
  { key: "relations" as const, label: "Relations", color: "text-ok" },
  { key: "observations" as const, label: "Facts", color: "text-fg" },
  { key: "entries" as const, label: "Notes", color: "text-warn" },
];

export default function StatsCards({ stats, taskGroups }: Props) {
  const taskTotal = taskGroups.reduce((s, g) => s + g.total, 0);
  const taskCompleted = taskGroups.reduce((s, g) => s + g.completed, 0);
  const taskFailed = taskGroups.reduce((s, g) => s + g.failed, 0);

  return (
    <dl className="grid grid-cols-2 gap-3 md:grid-cols-5">
      {cards.map((c) => (
        <div key={c.key} className="card px-4 py-3">
          <dt className="text-xs uppercase tracking-wide text-muted">{c.label}</dt>
          <dd className={`mt-1 text-2xl font-bold ${c.color}`}>{stats ? stats[c.key] : "—"}</dd>
        </div>
      ))}
      <div className="card px-4 py-3">
        <dt className="text-xs uppercase tracking-wide text-muted">Tasks</dt>
        <dd className="mt-1 text-2xl font-bold">
          {taskTotal > 0 ? `${taskCompleted}/${taskTotal}` : "—"}
          {taskFailed > 0 && <span className="ml-2 text-xs font-medium text-bad">{taskFailed} failed</span>}
        </dd>
      </div>
    </dl>
  );
}
