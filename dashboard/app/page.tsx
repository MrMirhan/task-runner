"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getAuth, clearAuth } from "./lib/auth";
import { fetchApi } from "./lib/api";
import type { GraphData, GraphStats, Entity, MemoryEntry, TaskGroup } from "./lib/types";
import ProjectSelector from "./components/ProjectSelector";
import StatsCards from "./components/StatsCards";
import SearchBar from "./components/SearchBar";
import GraphView from "./components/GraphView";
import EntityPanel from "./components/EntityPanel";
import EntryList from "./components/EntryList";
import TasksView from "./components/TasksView";
import ThemeToggle from "./components/ThemeToggle";

type Tab = "graph" | "entries" | "tasks";
type Scope = "all" | { branch: string } | { pr: string };

export default function Home() {
  const router = useRouter();
  const [projectKey, setProjectKey] = useState<string | null>(null);
  const [stats, setStats] = useState<GraphStats | null>(null);
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [selectedEntity, setSelectedEntity] = useState<string | null>(null);
  const [highlightIds, setHighlightIds] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<Tab>("graph");
  const [scope, setScope] = useState<Scope>("all");
  const [availableScopes, setAvailableScopes] = useState<string[]>([]);
  const [taskGroups, setTaskGroups] = useState<TaskGroup[]>([]);

  useEffect(() => {
    const auth = getAuth();
    if (!auth.token) {
      router.push("/login");
    }
  }, [router]);

  // Load stats + graph + scopes + task groups when project changes
  useEffect(() => {
    if (!projectKey) return;

    fetchApi<{ success: boolean } & GraphStats>(
      `/graph/stats?project_key=${projectKey}`
    ).then((d) => {
      if (d.success) setStats(d);
    });

    fetchApi<{ success: boolean } & GraphData>(
      `/graph/all?project_key=${projectKey}`
    ).then((d) => {
      if (d.success) setGraphData(d);
    });

    // Fetch all entries to discover available scopes
    fetchApi<{ entries: MemoryEntry[] }>(
      `/context?project=${projectKey}&all=true&limit=100`
    ).then((d) => {
      const scopes = new Set<string>();
      for (const e of d.entries) {
        if (e.scope !== "project" && e.scope_ref) {
          scopes.add(`${e.scope}:${e.scope_ref}`);
        }
      }
      setAvailableScopes(Array.from(scopes).sort());
    });

    // Fetch task groups
    fetchApi<{ success: boolean; groups: TaskGroup[] }>(
      `/tasks/groups?project_key=${projectKey}`
    ).then((d) => {
      if (d.success) setTaskGroups(d.groups);
    });

    setSelectedEntity(null);
    setHighlightIds(new Set());
    setScope("all");
  }, [projectKey]);

  const handleSearch = useCallback(
    (query: string) => {
      if (!query || !projectKey) {
        setHighlightIds(new Set());
        return;
      }

      fetchApi<{
        success: boolean;
        entities: Entity[];
      }>(`/recall?q=${encodeURIComponent(query)}&project_key=${projectKey}`).then(
        (d) => {
          if (d.success) {
            setHighlightIds(new Set(d.entities.map((e) => e.id)));
          }
        }
      );
    },
    [projectKey]
  );

  function handleLogout() {
    clearAuth();
    router.push("/login");
  }

  function parseScopeValue(val: string): Scope {
    if (val === "all") return "all";
    const [type, ref] = val.split(":", 2);
    if (type === "branch") return { branch: ref };
    if (type === "pr") return { pr: ref };
    return "all";
  }

  const auth = typeof window !== "undefined" ? getAuth() : null;

  const tabs: { key: Tab; label: string; show: boolean }[] = [
    { key: "graph", label: "Graph View", show: true },
    { key: "entries", label: "Memory Entries", show: true },
    { key: "tasks", label: "Tasks", show: true },
  ];

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <header className="flex items-center gap-4 px-4 py-3 border-b border-gray-800 bg-gray-900/50 backdrop-blur shrink-0">
        <h1 className="text-base font-bold text-white whitespace-nowrap">
          Task Runner
        </h1>
        <ProjectSelector selected={projectKey} onSelect={setProjectKey} />
        {projectKey && (
          <div className="flex-1">
            <SearchBar onSearch={handleSearch} />
          </div>
        )}
        <div className="flex items-center gap-2 ml-auto shrink-0">
          <ThemeToggle />
          {auth?.mode === "admin" && (
            <button
              onClick={() => router.push("/admin")}
              className="px-2 py-1 text-xs text-gray-400 hover:text-white border border-gray-700 rounded transition-colors"
            >
              Admin
            </button>
          )}
          <button
            onClick={handleLogout}
            className="px-2 py-1 text-xs text-gray-400 hover:text-white border border-gray-700 rounded transition-colors"
          >
            Logout
          </button>
        </div>
      </header>

      {!projectKey ? (
        <div className="flex-1 flex items-center justify-center text-gray-500">
          Select a project to explore
        </div>
      ) : (
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Stats */}
          <div className="px-4 py-3 shrink-0">
            <StatsCards stats={stats} taskGroups={taskGroups} />
          </div>

          {/* Scope selector + Tabs row */}
          <div className="px-4 flex items-center gap-4 shrink-0">
            {/* Tabs */}
            <div className="flex gap-1">
              {tabs.filter((t) => t.show).map((t) => (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className={`px-3 py-1.5 text-sm rounded-t-lg transition-colors ${
                    tab === t.key
                      ? "bg-gray-800 text-white"
                      : "text-gray-500 hover:text-gray-300"
                  }`}
                >
                  {t.label}
                  {t.key === "tasks" && taskGroups.length > 0 && (
                    <span className="ml-1 text-xs text-gray-600">
                      ({taskGroups.reduce((s, g) => s + g.total, 0)})
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* Scope selector (only for entries/graph tabs) */}
            {tab !== "tasks" && availableScopes.length > 0 && (
              <div className="flex items-center gap-2 ml-auto">
                <span className="text-xs text-gray-600">Scope:</span>
                <div className="flex gap-1">
                  <button
                    onClick={() => setScope("all")}
                    className={`px-2 py-0.5 text-xs rounded-full transition-colors ${
                      scope === "all"
                        ? "bg-gray-700 text-white"
                        : "text-gray-500 hover:text-gray-300 border border-gray-800"
                    }`}
                  >
                    All
                  </button>
                  {availableScopes.map((s) => {
                    const isActive =
                      scope !== "all" &&
                      (("branch" in scope && s === `branch:${scope.branch}`) ||
                        ("pr" in scope && s === `pr:${scope.pr}`));
                    return (
                      <button
                        key={s}
                        onClick={() => setScope(parseScopeValue(s))}
                        className={`px-2 py-0.5 text-xs rounded-full transition-colors ${
                          isActive
                            ? "bg-blue-600/30 text-blue-400 border border-blue-600/50"
                            : "text-gray-500 hover:text-gray-300 border border-gray-800"
                        }`}
                      >
                        {s}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Content */}
          <div className="flex-1 flex overflow-hidden mx-4 mb-4 bg-gray-800 rounded-b-lg rounded-tr-lg border border-gray-700">
            {tab === "graph" ? (
              <>
                <div className="flex-1 min-w-0">
                  <GraphView
                    data={graphData}
                    highlightIds={highlightIds}
                    onSelectEntity={setSelectedEntity}
                  />
                </div>
                <div className="w-[380px] border-l border-gray-700 shrink-0">
                  <EntityPanel
                    entityId={selectedEntity}
                    projectKey={projectKey}
                    onClose={() => setSelectedEntity(null)}
                  />
                </div>
              </>
            ) : tab === "entries" ? (
              <div className="flex-1 p-4 overflow-y-auto">
                <EntryList projectKey={projectKey} scope={scope} />
              </div>
            ) : (
              <div className="flex-1 p-4 overflow-y-auto">
                <TasksView projectKey={projectKey} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
