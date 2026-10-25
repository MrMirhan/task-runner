"use client";

import { useEffect, useState } from "react";
import { fetchApi, deleteApi } from "../lib/api";
import type { TaskGroup, TaskItem, TaskStatus } from "../lib/types";

interface Props {
  projectKey: string;
}

const STATUS_CONFIG: Record<TaskStatus, { color: string; bg: string; label: string }> = {
  pending: { color: "#9ca3af", bg: "#9ca3af20", label: "Pending" },
  running: { color: "#3b82f6", bg: "#3b82f620", label: "Running" },
  completed: { color: "#10b981", bg: "#10b98120", label: "Completed" },
  failed: { color: "#ef4444", bg: "#ef444420", label: "Failed" },
  timeout: { color: "#f59e0b", bg: "#f59e0b20", label: "Timeout" },
};

function formatDuration(ms: number | null): string {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function formatTime(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function TasksView({ projectKey }: Props) {
  const [groups, setGroups] = useState<TaskGroup[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [expandedTask, setExpandedTask] = useState<string | null>(null);
  const [taskDetail, setTaskDetail] = useState<Record<string, { result?: string; error?: string }>>({});
  const [loading, setLoading] = useState(true);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  function loadGroups() {
    setLoading(true);
    fetchApi<{ success: boolean; groups: TaskGroup[] }>(
      `/tasks/groups?project_key=${projectKey}`
    )
      .then((d) => {
        if (d.success) {
          setGroups(d.groups);
          if (d.groups.length > 0 && !selectedGroup) {
            setSelectedGroup(d.groups[0].task_group);
          }
        }
      })
      .finally(() => setLoading(false));
  }

  // Fetch task groups
  useEffect(() => {
    if (!projectKey) return;
    loadGroups();
  }, [projectKey]);

  // Fetch tasks for selected group
  useEffect(() => {
    if (!projectKey || !selectedGroup) return;
    fetchApi<{ success: boolean; tasks: TaskItem[] }>(
      `/tasks/status?project_key=${projectKey}&task_group=${encodeURIComponent(selectedGroup)}`
    ).then((d) => {
      if (d.success) setTasks(d.tasks);
    });
  }, [projectKey, selectedGroup]);

  // Fetch task result/error on expand
  function handleExpand(taskId: string) {
    if (expandedTask === taskId) {
      setExpandedTask(null);
      return;
    }
    setExpandedTask(taskId);
    if (!taskDetail[taskId]) {
      fetchApi<{ success: boolean; result?: string; error?: string }>(
        `/tasks/result?project_key=${projectKey}&task_id=${taskId}`
      ).then((d) => {
        if (d.success) {
          setTaskDetail((prev) => ({
            ...prev,
            [taskId]: { result: d.result ?? undefined, error: d.error ?? undefined },
          }));
        }
      });
    }
  }

  async function handleDeleteGroup() {
    if (!selectedGroup) return;
    await deleteApi(`/tasks?project_key=${projectKey}&task_group=${encodeURIComponent(selectedGroup)}`);
    setSelectedGroup(null);
    setDeleteConfirm(null);
    loadGroups();
  }

  if (loading) {
    return (
      <div className="text-gray-500 text-sm text-center py-8">Loading...</div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="text-center py-12">
        <div className="text-gray-500 text-sm">No task groups yet</div>
        <div className="text-gray-600 text-xs mt-2 max-w-md mx-auto">
          Tasks appear here when agents use <code className="text-gray-400 bg-gray-900 px-1 rounded">create_project</code> to
          break work into steps. Each task group tracks progress, status, and results.
        </div>
      </div>
    );
  }

  const currentGroup = groups.find((g) => g.task_group === selectedGroup);

  return (
    <div className="flex flex-col h-full">
      {/* Group selector */}
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <label className="text-xs text-gray-500 uppercase tracking-wide">
          Task Group
        </label>
        <select
          value={selectedGroup || ""}
          onChange={(e) => {
            setSelectedGroup(e.target.value);
            setExpandedTask(null);
          }}
          className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-white min-w-[200px]"
        >
          {groups.map((g) => (
            <option key={g.task_group} value={g.task_group}>
              {g.task_group} ({g.completed}/{g.total})
            </option>
          ))}
        </select>
        {currentGroup && (
          <div className="flex gap-2 text-xs items-center">
            <span className="text-green-400">{currentGroup.completed} done</span>
            {currentGroup.failed > 0 && (
              <span className="text-red-400">{currentGroup.failed} failed</span>
            )}
            {currentGroup.running > 0 && (
              <span className="text-blue-400">{currentGroup.running} running</span>
            )}
            {currentGroup.pending > 0 && (
              <span className="text-gray-400">{currentGroup.pending} pending</span>
            )}
            <span className="text-gray-800">|</span>
            {deleteConfirm === selectedGroup ? (
              <div className="flex gap-1">
                <button
                  onClick={handleDeleteGroup}
                  className="px-2 py-0.5 text-xs text-red-400 border border-red-800 rounded"
                >
                  Confirm delete
                </button>
                <button
                  onClick={() => setDeleteConfirm(null)}
                  className="px-2 py-0.5 text-xs text-gray-500 border border-gray-700 rounded"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setDeleteConfirm(selectedGroup)}
                className="px-2 py-0.5 text-xs text-gray-500 hover:text-red-400 border border-gray-800 hover:border-red-800 rounded transition-colors"
              >
                Delete group
              </button>
            )}
          </div>
        )}
      </div>

      {/* Progress bar */}
      {currentGroup && currentGroup.total > 0 && (
        <div className="h-1.5 bg-gray-900 rounded-full mb-3 overflow-hidden flex">
          {currentGroup.completed > 0 && (
            <div
              className="h-full bg-green-500"
              style={{ width: `${(currentGroup.completed / currentGroup.total) * 100}%` }}
            />
          )}
          {currentGroup.failed > 0 && (
            <div
              className="h-full bg-red-500"
              style={{ width: `${(currentGroup.failed / currentGroup.total) * 100}%` }}
            />
          )}
          {currentGroup.running > 0 && (
            <div
              className="h-full bg-blue-500"
              style={{ width: `${(currentGroup.running / currentGroup.total) * 100}%` }}
            />
          )}
        </div>
      )}

      {/* Task list */}
      <div className="space-y-1 overflow-y-auto flex-1">
        {tasks.map((t) => {
          const cfg = STATUS_CONFIG[t.status] || STATUS_CONFIG.pending;
          const isExpanded = expandedTask === t.id;
          const detail = taskDetail[t.id];

          return (
            <div key={t.id}>
              <button
                onClick={() => handleExpand(t.id)}
                className={`w-full text-left bg-gray-900 border rounded-lg p-3 transition-colors hover:border-gray-600 ${
                  isExpanded ? "border-gray-600" : "border-gray-800"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className="text-xs px-1.5 py-0.5 rounded font-medium shrink-0"
                    style={{ backgroundColor: cfg.bg, color: cfg.color }}
                  >
                    {cfg.label}
                  </span>
                  <span className="text-sm font-medium truncate flex-1">
                    {t.title}
                  </span>
                  <span className="text-xs text-gray-600 shrink-0">
                    {formatDuration(t.execution_time_ms)}
                  </span>
                  <svg
                    className={`w-4 h-4 text-gray-500 transition-transform shrink-0 ${
                      isExpanded ? "rotate-180" : ""
                    }`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
                <div className="flex items-center gap-3 mt-1 text-xs text-gray-600">
                  <span>Created: {formatTime(t.created_at)}</span>
                  {t.started_at && <span>Started: {formatTime(t.started_at)}</span>}
                  {t.completed_at && <span>Done: {formatTime(t.completed_at)}</span>}
                </div>
              </button>

              {isExpanded && (
                <div className="ml-4 mt-1 mb-2 space-y-2">
                  {detail?.result && (
                    <div className="bg-gray-950 border border-gray-800 rounded p-3">
                      <div className="text-xs text-green-400 font-medium mb-1">
                        Result
                      </div>
                      <pre className="text-xs text-gray-300 whitespace-pre-wrap max-h-64 overflow-y-auto">
                        {detail.result}
                      </pre>
                    </div>
                  )}
                  {detail?.error && (
                    <div className="bg-gray-950 border border-red-900/50 rounded p-3">
                      <div className="text-xs text-red-400 font-medium mb-1">
                        Error
                      </div>
                      <pre className="text-xs text-red-300 whitespace-pre-wrap max-h-32 overflow-y-auto">
                        {detail.error}
                      </pre>
                    </div>
                  )}
                  {!detail?.result && !detail?.error && (
                    <div className="text-xs text-gray-600 px-3 py-2">
                      {t.status === "pending"
                        ? "Task hasn't started yet"
                        : t.status === "running"
                        ? "Task is currently running..."
                        : "Loading..."}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
