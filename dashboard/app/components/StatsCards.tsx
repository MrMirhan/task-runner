"use client";

import type { GraphStats, TaskGroup } from "../lib/types";

interface Props {
  stats: GraphStats | null;
  taskGroups?: TaskGroup[];
}

const cards = [
  { key: "entities" as const, label: "Entities", color: "text-blue-400" },
  { key: "relations" as const, label: "Relations", color: "text-green-400" },
  { key: "observations" as const, label: "Observations", color: "text-purple-400" },
  { key: "entries" as const, label: "Memory Entries", color: "text-amber-400" },
];

export default function StatsCards({ stats, taskGroups }: Props) {
  // Aggregate task counts across all groups
  const taskTotal = taskGroups?.reduce((s, g) => s + g.total, 0) ?? 0;
  const taskCompleted = taskGroups?.reduce((s, g) => s + g.completed, 0) ?? 0;
  const taskFailed = taskGroups?.reduce((s, g) => s + g.failed, 0) ?? 0;

  return (
    <div className={`grid gap-3 ${taskTotal > 0 ? "grid-cols-5" : "grid-cols-4"}`}>
      {cards.map((c) => (
        <div
          key={c.key}
          className="bg-gray-900 border border-gray-800 rounded-lg p-4"
        >
          <div className="text-xs text-gray-500 uppercase tracking-wide">
            {c.label}
          </div>
          <div className={`text-2xl font-bold mt-1 ${c.color}`}>
            {stats ? stats[c.key] : "—"}
          </div>
        </div>
      ))}
      {taskTotal > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <div className="text-xs text-gray-500 uppercase tracking-wide">
            Tasks
          </div>
          <div className="text-2xl font-bold mt-1 text-cyan-400">
            {taskCompleted}/{taskTotal}
          </div>
          <div className="flex gap-2 mt-1 text-xs">
            {taskFailed > 0 && (
              <span className="text-red-400">{taskFailed} failed</span>
            )}
            {taskGroups && taskGroups.length > 0 && (
              <span className="text-gray-600">{taskGroups.length} groups</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
