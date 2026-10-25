"use client";

import { useEffect, useState } from "react";
import { deleteApi, errorMessage, fetchApi, qs } from "../lib/api";
import { formatDateTime, formatDuration } from "../lib/format";
import type { TaskGroup, TaskItem, TaskResult, TaskStatus } from "../lib/types";

interface Props {
  projectKey: string;
  refreshKey: number;
  onChange: () => void;
}

const STATUS: Record<TaskStatus, { color: string; label: string }> = {
  pending: { color: "text-muted", label: "Pending" },
  running: { color: "text-info", label: "Running" },
  completed: { color: "text-ok", label: "Completed" },
  failed: { color: "text-bad", label: "Failed" },
};

export default function TasksView({ projectKey, refreshKey, onChange }: Props) {
  const [groups, setGroups] = useState<TaskGroup[] | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskResult | "loading" | { failed: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchApi<{ groups: TaskGroup[] }>(`/tasks/groups${qs({ project_key: projectKey })}`)
      .then((d) => {
        if (!live) return;
        setGroups(d.groups);
        setSelectedGroup((cur) => (cur && d.groups.some((g) => g.task_group === cur) ? cur : (d.groups[0]?.task_group ?? null)));
        setError(null);
      })
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [projectKey, refreshKey]);

  useEffect(() => {
    if (!selectedGroup) {
      setTasks([]);
      return;
    }
    let live = true;
    fetchApi<{ tasks: TaskItem[] }>(`/tasks/status${qs({ project_key: projectKey, task_group: selectedGroup })}`)
      .then((d) => live && setTasks(d.tasks))
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [projectKey, selectedGroup, refreshKey]);

  useEffect(() => {
    if (!selectedGroup || !expanded) {
      setDetail(null);
      return;
    }
    let live = true;
    setDetail("loading");
    fetchApi<TaskResult>(`/tasks/result${qs({ project_key: projectKey, task_id: expanded, task_group: selectedGroup })}`)
      .then((d) => live && setDetail(d))
      .catch((e) => live && setDetail({ failed: errorMessage(e) }));
    return () => {
      live = false;
    };
  }, [projectKey, selectedGroup, expanded, refreshKey]);

  async function deleteGroup() {
    if (!selectedGroup) return;
    try {
      await deleteApi(`/tasks${qs({ project_key: projectKey, task_group: selectedGroup })}`);
      setConfirmDelete(false);
      setExpanded(null);
      onChange();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  if (!groups) {
    return error ? (
      <p className="py-8 text-center text-sm text-bad" role="alert">
        {error}
      </p>
    ) : (
      <p className="py-8 text-center text-sm text-muted">Loading…</p>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="py-12 text-center">
        <p className="text-sm text-muted">No tasks yet.</p>
        <p className="mx-auto mt-2 max-w-md text-xs text-muted">
          Tasks appear here when an agent calls <code className="rounded bg-raised px-1">create_project</code> to split
          work into steps. Each group tracks progress, status and results.
        </p>
      </div>
    );
  }

  const current = groups.find((g) => g.task_group === selectedGroup);
  const pct = (n: number) => (current && current.total > 0 ? (n / current.total) * 100 : 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="task-group" className="text-xs uppercase tracking-wide text-muted">
          Task group
        </label>
        <select
          id="task-group"
          value={selectedGroup ?? ""}
          onChange={(e) => {
            setSelectedGroup(e.target.value);
            setExpanded(null);
            setConfirmDelete(false);
          }}
          className="field w-auto min-w-[12rem]"
        >
          {groups.map((g) => (
            <option key={g.task_group} value={g.task_group}>
              {g.task_group} ({g.completed}/{g.total})
            </option>
          ))}
        </select>
        {current && (
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span className="text-ok">{current.completed} done</span>
            {current.failed > 0 && <span className="text-bad">{current.failed} failed</span>}
            {current.running > 0 && <span className="text-info">{current.running} running</span>}
            {current.pending > 0 && <span className="text-muted">{current.pending} pending</span>}
            {confirmDelete ? (
              <>
                <button type="button" onClick={deleteGroup} className="btn btn-sm btn-danger">
                  Confirm delete group
                </button>
                <button type="button" onClick={() => setConfirmDelete(false)} className="btn btn-sm">
                  Cancel
                </button>
              </>
            ) : (
              <button type="button" onClick={() => setConfirmDelete(true)} className="btn btn-sm btn-danger">
                Delete group
              </button>
            )}
          </div>
        )}
      </div>

      {error && (
        <p className="text-sm text-bad" role="alert">
          {error}
        </p>
      )}

      {current && current.total > 0 && (
        <div
          className="flex h-2 overflow-hidden rounded-full bg-raised"
          role="progressbar"
          aria-label="Task group progress"
          aria-valuemin={0}
          aria-valuemax={current.total}
          aria-valuenow={current.completed}
          aria-valuetext={`${current.completed} of ${current.total} completed`}
        >
          <div className="h-full bg-ok" style={{ width: `${pct(current.completed)}%` }} />
          <div className="h-full bg-bad" style={{ width: `${pct(current.failed)}%` }} />
          <div className="h-full bg-info" style={{ width: `${pct(current.running)}%` }} />
        </div>
      )}

      <ul className="space-y-2">
        {tasks.map((t) => {
          const cfg = STATUS[t.status] ?? STATUS.pending;
          const open = expanded === t.id;
          const loaded = open && detail && detail !== "loading" && !("failed" in detail) ? detail : null;
          const result = loaded?.result;
          const taskError = loaded?.error ?? t.error;
          return (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => setExpanded(open ? null : t.id)}
                aria-expanded={open}
                className={`card w-full p-3 text-left hover:bg-raised ${open ? "!border-muted" : ""}`}
              >
                <span className="flex items-center gap-2">
                  <span className={`status shrink-0 ${cfg.color}`}>{cfg.label}</span>
                  <span className="flex-1 truncate text-sm font-medium">{t.title}</span>
                  <span className="shrink-0 text-xs text-muted">{formatDuration(t.execution_time_ms)}</span>
                  <svg
                    className={`h-4 w-4 shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    aria-hidden
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </span>
                {(t.started_at || t.completed_at) && (
                  <span className="mt-1 flex gap-3 text-xs text-muted">
                    {t.started_at && <span>Started {formatDateTime(t.started_at)}</span>}
                    {t.completed_at && <span>Finished {formatDateTime(t.completed_at)}</span>}
                  </span>
                )}
              </button>

              {open && (
                <div className="ml-4 mt-1 space-y-2">
                  {result && (
                    <div className="card p-3">
                      <div className="mb-1 text-xs font-medium text-ok">Result</div>
                      <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-xs">{result}</pre>
                    </div>
                  )}
                  {taskError && (
                    <div className="card p-3">
                      <div className="mb-1 text-xs font-medium text-bad">Error</div>
                      <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-xs text-bad">
                        {taskError}
                      </pre>
                    </div>
                  )}
                  {!result && !taskError && (
                    <p className="px-1 py-1 text-xs text-muted">
                      {detail === "loading"
                        ? "Loading…"
                        : detail && "failed" in detail
                          ? detail.failed
                          : t.status === "pending"
                            ? "This task has not started yet."
                            : t.status === "running"
                              ? "This task is running."
                              : "No result recorded."}
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
