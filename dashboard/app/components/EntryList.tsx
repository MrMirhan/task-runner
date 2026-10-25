"use client";

import { useEffect, useState } from "react";
import { fetchApi, postApi, putApi, deleteApi } from "../lib/api";
import type { MemoryEntry } from "../lib/types";

interface Props {
  projectKey: string;
  scope?: "all" | { branch: string } | { pr: string };
}

const TYPE_COLORS: Record<string, string> = {
  task_completed: "#10b981",
  decision: "#f59e0b",
  note: "#6b7280",
  change: "#3b82f6",
  issue: "#ef4444",
  discovery: "#8b5cf6",
};

const SCOPE_COLORS: Record<string, string> = {
  project: "#6b7280",
  branch: "#3b82f6",
  pr: "#8b5cf6",
};

const ENTRY_TYPES = [
  "note", "decision", "change", "issue", "discovery", "task_completed",
];

export default function EntryList({ projectKey, scope = "all" }: Props) {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [formData, setFormData] = useState({ type: "note", title: "", content: "", scope: "project", scope_ref: "" });

  function loadEntries() {
    let url = `/context?project=${projectKey}&limit=100`;
    if (scope === "all") {
      url += "&all=true";
    } else if ("branch" in scope) {
      url += `&branch=${encodeURIComponent(scope.branch)}`;
    } else if ("pr" in scope) {
      url += `&pr=${encodeURIComponent(scope.pr)}`;
    }

    setLoading(true);
    fetchApi<{ entries: MemoryEntry[] }>(url)
      .then((d) => setEntries(d.entries))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    if (!projectKey) return;
    loadEntries();
  }, [projectKey, scope]);

  async function handleCreate() {
    await postApi("/memory", {
      project_key: projectKey,
      type: formData.type,
      title: formData.title,
      content: formData.content,
      scope: formData.scope,
      scope_ref: formData.scope_ref || null,
    });
    setFormData({ type: "note", title: "", content: "", scope: "project", scope_ref: "" });
    setShowCreate(false);
    loadEntries();
  }

  async function handleDelete(id: string) {
    await deleteApi(`/memory?id=${id}`);
    setDeleteConfirm(null);
    loadEntries();
  }

  async function handleUpdate(entry: MemoryEntry) {
    await putApi("/memory", {
      id: entry.id,
      title: formData.title,
      content: formData.content,
      type: formData.type,
    });
    setEditingId(null);
    loadEntries();
  }

  function startEdit(e: MemoryEntry) {
    setEditingId(e.id);
    setFormData({ type: e.type, title: e.title, content: e.content, scope: e.scope, scope_ref: e.scope_ref || "" });
  }

  if (loading) {
    return (
      <div className="text-gray-500 text-sm text-center py-8">Loading...</div>
    );
  }

  // Group by scope
  const grouped: Record<string, MemoryEntry[]> = {};
  for (const e of entries) {
    const key = e.scope === "project" ? "project" : `${e.scope}: ${e.scope_ref}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(e);
  }

  const scopeKeys = Object.keys(grouped).sort((a, b) => {
    if (a === "project") return -1;
    if (b === "project") return 1;
    return a.localeCompare(b);
  });

  return (
    <div className="space-y-4 overflow-y-auto">
      {/* Create button */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-500">{entries.length} entries</span>
        <button
          onClick={() => { setShowCreate(!showCreate); setEditingId(null); }}
          className="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors"
        >
          + New Entry
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="bg-gray-900 border border-gray-700 rounded-lg p-4 space-y-3">
          <div className="flex gap-3">
            <select
              value={formData.type}
              onChange={(e) => setFormData({ ...formData, type: e.target.value })}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-white"
            >
              {ENTRY_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <select
              value={formData.scope}
              onChange={(e) => setFormData({ ...formData, scope: e.target.value })}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-white"
            >
              <option value="project">project</option>
              <option value="branch">branch</option>
              <option value="pr">pr</option>
            </select>
            {formData.scope !== "project" && (
              <input
                value={formData.scope_ref}
                onChange={(e) => setFormData({ ...formData, scope_ref: e.target.value })}
                placeholder={formData.scope === "branch" ? "branch name" : "PR number"}
                className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-white flex-1"
              />
            )}
          </div>
          <input
            value={formData.title}
            onChange={(e) => setFormData({ ...formData, title: e.target.value })}
            placeholder="Title"
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white"
          />
          <textarea
            value={formData.content}
            onChange={(e) => setFormData({ ...formData, content: e.target.value })}
            placeholder="Content"
            rows={3}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white resize-y"
          />
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => setShowCreate(false)}
              className="px-3 py-1 text-xs text-gray-400 hover:text-white border border-gray-700 rounded transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={!formData.title || !formData.content}
              className="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded transition-colors"
            >
              Save
            </button>
          </div>
        </div>
      )}

      {entries.length === 0 && !showCreate && (
        <div className="text-gray-500 text-sm text-center py-8">
          No memory entries yet
        </div>
      )}

      {scopeKeys.map((scopeKey) => (
        <div key={scopeKey}>
          <div className="flex items-center gap-2 mb-2 sticky top-0 bg-gray-800 py-1 z-10">
            <span
              className="text-xs px-2 py-0.5 rounded-full font-medium"
              style={{
                backgroundColor:
                  (SCOPE_COLORS[scopeKey === "project" ? "project" : scopeKey.startsWith("branch") ? "branch" : "pr"] || "#6b7280") + "20",
                color:
                  SCOPE_COLORS[scopeKey === "project" ? "project" : scopeKey.startsWith("branch") ? "branch" : "pr"] || "#6b7280",
              }}
            >
              {scopeKey === "project" ? "Project scope" : scopeKey}
            </span>
            <span className="text-xs text-gray-600">
              {grouped[scopeKey].length} entries
            </span>
          </div>
          <div className="space-y-2">
            {grouped[scopeKey].map((e) => (
              <div
                key={e.id}
                className="bg-gray-900 border border-gray-800 rounded-lg p-3 group"
              >
                {editingId === e.id ? (
                  // Edit mode
                  <div className="space-y-2">
                    <div className="flex gap-2">
                      <select
                        value={formData.type}
                        onChange={(ev) => setFormData({ ...formData, type: ev.target.value })}
                        className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white"
                      >
                        {ENTRY_TYPES.map((t) => (
                          <option key={t} value={t}>{t}</option>
                        ))}
                      </select>
                    </div>
                    <input
                      value={formData.title}
                      onChange={(ev) => setFormData({ ...formData, title: ev.target.value })}
                      className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-white"
                    />
                    <textarea
                      value={formData.content}
                      onChange={(ev) => setFormData({ ...formData, content: ev.target.value })}
                      rows={3}
                      className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-white resize-y"
                    />
                    <div className="flex gap-2 justify-end">
                      <button
                        onClick={() => setEditingId(null)}
                        className="px-2 py-0.5 text-xs text-gray-400 hover:text-white border border-gray-700 rounded"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => handleUpdate(e)}
                        className="px-2 py-0.5 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded"
                      >
                        Save
                      </button>
                    </div>
                  </div>
                ) : (
                  // View mode
                  <>
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className="text-xs px-1.5 py-0.5 rounded"
                        style={{
                          backgroundColor:
                            (TYPE_COLORS[e.type] || "#6b7280") + "20",
                          color: TYPE_COLORS[e.type] || "#6b7280",
                        }}
                      >
                        {e.type}
                      </span>
                      <span className="text-xs text-gray-600 ml-auto">
                        {new Date(e.created_at * 1000).toLocaleDateString()}
                      </span>
                      {/* Action buttons */}
                      <div className="hidden group-hover:flex gap-1">
                        <button
                          onClick={() => startEdit(e)}
                          className="text-xs px-1.5 py-0.5 text-gray-500 hover:text-blue-400 border border-gray-800 hover:border-blue-800 rounded transition-colors"
                        >
                          Edit
                        </button>
                        {deleteConfirm === e.id ? (
                          <button
                            onClick={() => handleDelete(e.id)}
                            className="text-xs px-1.5 py-0.5 text-red-400 border border-red-800 rounded"
                          >
                            Confirm
                          </button>
                        ) : (
                          <button
                            onClick={() => setDeleteConfirm(e.id)}
                            className="text-xs px-1.5 py-0.5 text-gray-500 hover:text-red-400 border border-gray-800 hover:border-red-800 rounded transition-colors"
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="text-sm font-medium">{e.title}</div>
                    <div className="text-xs text-gray-400 mt-1 line-clamp-2">
                      {e.content}
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

