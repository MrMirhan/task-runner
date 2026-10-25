"use client";

import { useEffect, useState } from "react";
import { deleteApi, errorMessage, fetchApi, postApi, putApi, qs } from "../lib/api";
import { formatDate } from "../lib/format";
import type { MemoryEntry, ScopeFilter } from "../lib/types";

interface Props {
  projectKey: string;
  scope: ScopeFilter | null;
  refreshKey: number;
  onChange: () => void;
}

const ENTRY_TYPES = ["note", "decision", "change", "issue", "discovery", "task_completed"];
const TYPE_COLORS: Record<string, string> = {
  task_completed: "#10b981",
  decision: "#f59e0b",
  note: "#94a3b8",
  change: "#3b82f6",
  issue: "#ef4444",
  discovery: "#a78bfa",
};
const PAGE_LIMIT = 100;
const LONG_CONTENT = 220;

interface Form {
  type: string;
  title: string;
  content: string;
  scope: "project" | "branch" | "pr";
  scope_ref: string;
}

const EMPTY_FORM: Form = { type: "note", title: "", content: "", scope: "project", scope_ref: "" };

export default function EntryList({ projectKey, scope, refreshKey, onChange }: Props) {
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    const query = scope
      ? qs({ project: projectKey, limit: PAGE_LIMIT, [scope.scope]: scope.ref })
      : qs({ project: projectKey, limit: PAGE_LIMIT, all: true });
    fetchApi<{ entries: MemoryEntry[] }>(`/context${query}`)
      .then((d) => {
        if (!live) return;
        setEntries(d.entries);
        setError(null);
      })
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [projectKey, scope, refreshKey]);

  async function run(action: () => Promise<unknown>, after: () => void) {
    setBusy(true);
    setError(null);
    try {
      await action();
      after();
      onChange();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const create = () =>
    run(
      () =>
        postApi("/memory", {
          project_key: projectKey,
          type: form.type,
          title: form.title.trim(),
          content: form.content.trim(),
          scope: form.scope,
          scope_ref: form.scope === "project" ? null : form.scope_ref.trim(),
        }),
      () => {
        setForm(EMPTY_FORM);
        setShowCreate(false);
      },
    );

  const update = (id: string) =>
    run(
      () => putApi("/memory", { id, type: form.type, title: form.title.trim(), content: form.content.trim() }),
      () => setEditingId(null),
    );

  const remove = (id: string) =>
    run(
      () => deleteApi(`/memory${qs({ id })}`),
      () => setConfirmingId(null),
    );

  function startEdit(entry: MemoryEntry) {
    setEditingId(entry.id);
    setShowCreate(false);
    setConfirmingId(null);
    setForm({ ...EMPTY_FORM, type: entry.type, title: entry.title, content: entry.content });
  }

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  if (!entries) {
    return error ? (
      <p className="py-8 text-center text-sm text-bad" role="alert">
        {error}
      </p>
    ) : (
      <p className="py-8 text-center text-sm text-muted">Loading…</p>
    );
  }

  const groups = new Map<string, MemoryEntry[]>();
  for (const e of entries) {
    const key = e.scope === "project" ? "project" : `${e.scope}: ${e.scope_ref}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const groupKeys = [...groups.keys()].sort((a, b) =>
    a === "project" ? -1 : b === "project" ? 1 : a.localeCompare(b),
  );

  const formValid =
    form.title.trim() !== "" && form.content.trim() !== "" && (form.scope === "project" || form.scope_ref.trim() !== "");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted">
          {entries.length} {entries.length === 1 ? "note" : "notes"}
          {entries.length >= PAGE_LIMIT && ` (latest ${PAGE_LIMIT})`}
        </span>
        <button
          type="button"
          onClick={() => {
            setShowCreate(!showCreate);
            setEditingId(null);
            setForm(EMPTY_FORM);
          }}
          aria-expanded={showCreate}
          className="btn btn-primary"
        >
          New note
        </button>
      </div>

      {error && (
        <p className="text-sm text-bad" role="alert">
          {error}
        </p>
      )}

      {showCreate && (
        <form
          className="card space-y-3 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (formValid) create();
          }}
          aria-label="New note"
        >
          <div className="flex flex-wrap gap-3">
            <div>
              <label htmlFor="new-type" className="mb-1 block text-xs text-muted">
                Type
              </label>
              <select
                id="new-type"
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value })}
                className="field w-auto"
              >
                {ENTRY_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="new-scope" className="mb-1 block text-xs text-muted">
                Scope
              </label>
              <select
                id="new-scope"
                value={form.scope}
                onChange={(e) => setForm({ ...form, scope: e.target.value as Form["scope"] })}
                className="field w-auto"
              >
                <option value="project">project</option>
                <option value="branch">branch</option>
                <option value="pr">pr</option>
              </select>
            </div>
            {form.scope !== "project" && (
              <div className="min-w-40 flex-1">
                <label htmlFor="new-scope-ref" className="mb-1 block text-xs text-muted">
                  {form.scope === "branch" ? "Branch name" : "PR number"}
                </label>
                <input
                  id="new-scope-ref"
                  value={form.scope_ref}
                  onChange={(e) => setForm({ ...form, scope_ref: e.target.value })}
                  className="field"
                />
              </div>
            )}
          </div>
          <div>
            <label htmlFor="new-title" className="mb-1 block text-xs text-muted">
              Title
            </label>
            <input
              id="new-title"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              className="field"
            />
          </div>
          <div>
            <label htmlFor="new-content" className="mb-1 block text-xs text-muted">
              Content
            </label>
            <textarea
              id="new-content"
              value={form.content}
              onChange={(e) => setForm({ ...form, content: e.target.value })}
              rows={4}
              className="field resize-y"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setShowCreate(false)} className="btn">
              Cancel
            </button>
            <button type="submit" disabled={!formValid || busy} className="btn btn-primary">
              Save
            </button>
          </div>
        </form>
      )}

      {entries.length === 0 && !showCreate && (
        <p className="py-8 text-center text-sm text-muted">
          No notes{scope ? " in this scope" : " yet"}. Agents add them with the save_memory tool.
        </p>
      )}

      {groupKeys.map((groupKey) => {
        const list = groups.get(groupKey) ?? [];
        return (
          <section key={groupKey} aria-label={groupKey === "project" ? "Project scope" : groupKey}>
            <div className="mb-2 flex items-center gap-2">
              <span className="pill">{groupKey === "project" ? "Project scope" : groupKey}</span>
              <span className="text-xs text-muted">{list.length}</span>
            </div>
            <ul className="space-y-2">
              {list.map((e) => {
                const long = e.content.length > LONG_CONTENT;
                const open = expanded.has(e.id);
                return (
                  <li key={e.id} className="card p-3">
                    {editingId === e.id ? (
                      <div className="space-y-2">
                        <div>
                          <label htmlFor={`type-${e.id}`} className="mb-1 block text-xs text-muted">
                            Type
                          </label>
                          <select
                            id={`type-${e.id}`}
                            value={form.type}
                            onChange={(ev) => setForm({ ...form, type: ev.target.value })}
                            className="field w-auto"
                          >
                            {ENTRY_TYPES.map((t) => (
                              <option key={t} value={t}>
                                {t}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label htmlFor={`title-${e.id}`} className="mb-1 block text-xs text-muted">
                            Title
                          </label>
                          <input
                            id={`title-${e.id}`}
                            value={form.title}
                            onChange={(ev) => setForm({ ...form, title: ev.target.value })}
                            className="field"
                          />
                        </div>
                        <div>
                          <label htmlFor={`content-${e.id}`} className="mb-1 block text-xs text-muted">
                            Content
                          </label>
                          <textarea
                            id={`content-${e.id}`}
                            value={form.content}
                            onChange={(ev) => setForm({ ...form, content: ev.target.value })}
                            rows={4}
                            className="field resize-y"
                          />
                        </div>
                        <div className="flex justify-end gap-2">
                          <button type="button" onClick={() => setEditingId(null)} className="btn btn-sm">
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={() => update(e.id)}
                            disabled={!form.title.trim() || !form.content.trim() || busy}
                            className="btn btn-sm btn-primary"
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="mb-1 flex flex-wrap items-center gap-2">
                          <span className="pill">
                            <span
                              className="pill-dot"
                              style={{ backgroundColor: TYPE_COLORS[e.type] ?? "#94a3b8" }}
                              aria-hidden
                            />
                            {e.type}
                          </span>
                          <span className="text-xs text-muted">{formatDate(e.created_at)}</span>
                          <div className="ml-auto flex gap-1">
                            <button type="button" onClick={() => startEdit(e)} className="btn btn-sm">
                              Edit
                            </button>
                            {confirmingId === e.id ? (
                              <>
                                <button
                                  type="button"
                                  onClick={() => remove(e.id)}
                                  disabled={busy}
                                  className="btn btn-sm btn-danger"
                                >
                                  Confirm delete
                                </button>
                                <button type="button" onClick={() => setConfirmingId(null)} className="btn btn-sm">
                                  Cancel
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setConfirmingId(e.id)}
                                className="btn btn-sm btn-danger"
                              >
                                Delete
                              </button>
                            )}
                          </div>
                        </div>
                        <h3 className="text-sm font-medium">{e.title}</h3>
                        <p
                          className={`mt-1 whitespace-pre-wrap break-words text-sm text-muted ${
                            long && !open ? "line-clamp-3" : ""
                          }`}
                        >
                          {e.content}
                        </p>
                        {long && (
                          <button
                            type="button"
                            onClick={() => toggleExpanded(e.id)}
                            aria-expanded={open}
                            className="mt-1 text-xs text-link underline"
                          >
                            {open ? "Show less" : "Show more"}
                          </button>
                        )}
                        {e.tags && <p className="mt-1 text-xs text-subtle">Tags: {e.tags}</p>}
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
