"use client";

import { useCallback, useEffect, useState } from "react";
import { errorMessage, fetchApi, fetchApiSignal, qs } from "./lib/api";
import { SessionProvider, useSession } from "./lib/session";
import { confirmDiscard } from "./lib/unsaved";
import type { GraphData, GraphEntity, GraphStats, MemoryEntry, Project, Proposal, ScopeFilter, TaskGroup } from "./lib/types";
import { GLOBAL_PROJECT } from "./lib/types";
import ProjectSelector from "./components/ProjectSelector";
import StatsCards from "./components/StatsCards";
import SearchBar from "./components/SearchBar";
import GraphView from "./components/GraphView";
import EntityPanel from "./components/EntityPanel";
import EntryList from "./components/EntryList";
import TasksView from "./components/TasksView";
import TimeView from "./components/TimeView";
import HeaderActions from "./components/HeaderActions";
import RulesView from "./components/rules/RulesView";
import SignIn from "./components/SignIn";

type Tab = "graph" | "entries" | "tasks" | "time" | "rules";

const PROJECT_KEY = "task-runner-project";

function savedProject(): string | null {
  try {
    return localStorage.getItem(PROJECT_KEY);
  } catch {
    return null;
  }
}

function pickProject(projects: Project[], current: string | null): string | null {
  if (current && projects.some((p) => p.key === current)) return current;
  const saved = savedProject();
  if (saved && projects.some((p) => p.key === saved)) return saved;
  return (projects.find((p) => p.key !== GLOBAL_PROJECT) ?? projects[0])?.key ?? null;
}

function scopeId(s: ScopeFilter): string {
  return `${s.scope}:${s.ref}`;
}

export default function Home() {
  return (
    <SessionProvider>
      <Gate />
    </SessionProvider>
  );
}

function Gate() {
  const { phase, health, error, retry } = useSession();

  if (phase === "loading") {
    return (
      <div className="flex min-h-dvh flex-col">
        <Notice title="Loading…" />
      </div>
    );
  }
  if (phase === "error") {
    return (
      <div className="flex min-h-dvh flex-col">
        <Notice title="Cannot reach the server">
          <p role="alert">{error}</p>
          <button type="button" onClick={retry} className="btn btn-primary mt-4">
            Try again
          </button>
        </Notice>
      </div>
    );
  }
  if (phase === "signin") return <SignIn />;
  return health?.features.includes("memory") ? <LocalApp /> : <RemoteApp />;
}

/** The remote server stores rules and devices only: no projects, graph, notes or tasks. */
function RemoteApp() {
  const [reloadKey, setReloadKey] = useState(0);
  return (
    <div className="flex min-h-dvh flex-col md:h-dvh">
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-surface px-4 py-3">
        <h1 className="whitespace-nowrap text-base font-bold">Task Runner</h1>
        <span className="text-sm text-muted">Rules</span>
        <HeaderActions onRefresh={() => setReloadKey((k) => k + 1)} />
      </header>
      <main className="flex flex-1 flex-col md:min-h-0">
        <div className="flex flex-1 flex-col px-4 pb-4 pt-3 md:min-h-0">
          <div className="card flex min-h-[480px] flex-1 overflow-hidden md:min-h-0">
            <div className="relative min-w-0 flex-1 p-4 md:overflow-y-auto">
              <RulesView refreshKey={reloadKey} />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function LocalApp() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [projectKey, setProjectKey] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [stats, setStats] = useState<GraphStats | null>(null);
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [taskGroups, setTaskGroups] = useState<TaskGroup[]>([]);
  const [scopes, setScopes] = useState<ScopeFilter[]>([]);
  const [dataError, setDataError] = useState<string | null>(null);

  const [tab, setTab] = useState<Tab>("graph");
  const [scope, setScope] = useState<ScopeFilter | null>(null);
  const [selectedEntity, setSelectedEntity] = useState<string | null>(null);
  const [highlightIds, setHighlightIds] = useState<Set<string>>(new Set());
  const [searchStatus, setSearchStatus] = useState<string | null>(null);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const [pendingRules, setPendingRules] = useState(0);
  useEffect(() => {
    const ctl = new AbortController();
    fetchApiSignal<{ proposals: Proposal[] }>("/rules/proposals?status=pending", ctl.signal)
      .then((d) => setPendingRules(d.proposals.length))
      .catch(() => undefined);
    return () => ctl.abort();
  }, [reloadKey]);

  function selectTab(next: Tab) {
    if (tab === "rules" && next !== "rules" && !confirmDiscard()) return;
    setTab(next);
  }

  useEffect(() => {
    let live = true;
    fetchApi<{ projects: Project[] }>("/projects")
      .then((d) => {
        if (!live) return;
        const sorted = [...d.projects].sort((a, b) => b.updated_at - a.updated_at);
        setProjects(sorted);
        setLoadError(null);
        setProjectKey((cur) => pickProject(sorted, cur));
      })
      .catch((e) => live && setLoadError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [reloadKey]);

  useEffect(() => {
    if (!projectKey) return;
    let live = true;
    Promise.all([
      fetchApi<GraphStats>(`/graph/stats${qs({ project_key: projectKey })}`),
      fetchApi<GraphData>(`/graph/all${qs({ project_key: projectKey })}`),
      fetchApi<{ entries: MemoryEntry[] }>(`/context${qs({ project: projectKey, all: true, limit: 100 })}`),
      fetchApi<{ groups: TaskGroup[] }>(`/tasks/groups${qs({ project_key: projectKey })}`),
    ])
      .then(([s, g, c, t]) => {
        if (!live) return;
        setStats(s);
        setGraphData(g);
        setTaskGroups(t.groups);
        const found = new Map<string, ScopeFilter>();
        for (const e of c.entries) {
          if (e.scope !== "project" && e.scope_ref) {
            const f: ScopeFilter = { scope: e.scope, ref: e.scope_ref };
            found.set(scopeId(f), f);
          }
        }
        setScopes([...found.values()].sort((a, b) => scopeId(a).localeCompare(scopeId(b))));
        setDataError(null);
      })
      .catch((e) => live && setDataError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [projectKey, reloadKey]);

  useEffect(() => {
    setStats(null);
    setGraphData(null);
    setTaskGroups([]);
    setScopes([]);
    setScope(null);
    setSelectedEntity(null);
    setHighlightIds(new Set());
    setSearchStatus(null);
  }, [projectKey]);

  function selectProject(key: string) {
    setProjectKey(key);
    try {
      localStorage.setItem(PROJECT_KEY, key);
    } catch {
      // storage can be blocked; the choice just won't persist
    }
  }

  const search = useCallback(
    (query: string) => {
      setTab("graph");
      if (!query || !projectKey) {
        setHighlightIds(new Set());
        setSearchStatus(null);
        return;
      }
      fetchApi<{ entities: Pick<GraphEntity, "id">[] }>(`/recall${qs({ q: query, project_key: projectKey, limit: 20 })}`)
        .then((d) => {
          const inGraph = new Set((graphData?.entities ?? []).map((e) => e.id));
          const hits = d.entities.filter((e) => inGraph.has(e.id));
          setHighlightIds(new Set(hits.map((e) => e.id)));
          setSearchStatus(hits.length === 0 ? "No matches" : `${hits.length} ${hits.length === 1 ? "match" : "matches"}`);
        })
        .catch((e) => setSearchStatus(errorMessage(e)));
    },
    [projectKey, graphData],
  );

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: "graph", label: "Graph" },
    { key: "entries", label: "Notes" },
    { key: "tasks", label: "Tasks" },
    { key: "time", label: "Time" },
    { key: "rules", label: "Rules" },
  ];

  const tabGroup = (
    <div className="flex flex-wrap gap-1" role="group" aria-label="View">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => selectTab(t.key)}
          aria-pressed={tab === t.key}
          className={`btn ${tab === t.key ? "!border-link !text-link" : ""}`}
        >
          {t.label}
          {t.key === "tasks" && taskGroups.length > 0 && (
            <span className="text-xs text-muted">({taskGroups.reduce((s, g) => s + g.total, 0)})</span>
          )}
          {t.key === "rules" && pendingRules > 0 && (
            <span className="rounded-full bg-[var(--accent-bg)] px-1.5 text-xs font-medium text-white">
              {pendingRules}
              <span className="sr-only"> pending {pendingRules === 1 ? "proposal" : "proposals"}</span>
            </span>
          )}
        </button>
      ))}
    </div>
  );

  let body: React.ReactNode;
  if (tab === "rules") {
    body = (
      <div className="flex flex-1 flex-col gap-3 px-4 pb-4 pt-3 md:min-h-0">
        {tabGroup}
        <div className="card flex min-h-[480px] flex-1 overflow-hidden md:min-h-0">
          <div className="relative min-w-0 flex-1 p-4 md:overflow-y-auto">
            <RulesView refreshKey={reloadKey} onPendingChange={setPendingRules} />
          </div>
        </div>
      </div>
    );
  } else if (loadError) {
    body = (
      <div className="flex flex-1 flex-col px-4 pt-3">
        {tabGroup}
        <Notice title="Cannot load projects">
          <p role="alert">{loadError}</p>
          <button type="button" onClick={reload} className="btn btn-primary mt-4">
            Try again
          </button>
        </Notice>
      </div>
    );
  } else if (!projects) {
    body = <Notice title="Loading…" />;
  } else if (projects.length === 0) {
    body = (
      <div className="flex flex-1 flex-col px-4 pt-3">
        {tabGroup}
        <Notice>
          <p>No memory yet. Start a Claude Code session with the task-runner plugin or call the remember tool.</p>
          <button type="button" onClick={reload} className="btn mt-4">
            Check again
          </button>
        </Notice>
      </div>
    );
  } else if (projectKey) {
    body = (
      <div className="flex flex-1 flex-col gap-3 px-4 pb-4 pt-3 md:min-h-0">
        {tab !== "time" && <StatsCards stats={stats} taskGroups={taskGroups} />}

        {tab !== "time" && dataError && (
          <p className="text-sm text-bad" role="alert">
            {dataError}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {tabGroup}

          {tab === "entries" && scopes.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Scope filter">
              <span className="text-xs text-muted">Scope</span>
              <button
                type="button"
                onClick={() => setScope(null)}
                aria-pressed={scope === null}
                className={`btn btn-sm ${scope === null ? "!border-link !text-link" : ""}`}
              >
                All
              </button>
              {scopes.map((s) => {
                const active = scope !== null && scopeId(scope) === scopeId(s);
                return (
                  <button
                    key={scopeId(s)}
                    type="button"
                    onClick={() => setScope(s)}
                    aria-pressed={active}
                    className={`btn btn-sm ${active ? "!border-link !text-link" : ""}`}
                  >
                    {scopeId(s)}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="card flex min-h-[480px] flex-1 overflow-hidden md:min-h-0">
          {tab === "graph" ? (
            <div className="flex min-w-0 flex-1 flex-col md:flex-row">
              <div className="min-h-[360px] min-w-0 flex-1">
                <GraphView
                  data={graphData}
                  highlightIds={highlightIds}
                  selectedId={selectedEntity}
                  onSelectEntity={setSelectedEntity}
                />
              </div>
              <aside
                aria-label="Entity details"
                className="max-h-[50vh] shrink-0 border-t border-line md:max-h-none md:w-[380px] md:border-l md:border-t-0"
              >
                <EntityPanel
                  entityId={selectedEntity}
                  refreshKey={reloadKey}
                  onClose={() => setSelectedEntity(null)}
                  onForgotten={() => {
                    setSelectedEntity(null);
                    setHighlightIds(new Set());
                    setSearchStatus(null);
                    reload();
                  }}
                />
              </aside>
            </div>
          ) : tab === "entries" ? (
            <div className="min-w-0 flex-1 p-4 md:overflow-y-auto">
              <EntryList key={projectKey} projectKey={projectKey} scope={scope} refreshKey={reloadKey} onChange={reload} />
            </div>
          ) : tab === "time" ? (
            <div className="min-w-0 flex-1 p-4 md:overflow-y-auto">
              <TimeView projects={projects} refreshKey={reloadKey} />
            </div>
          ) : (
            <div className="min-w-0 flex-1 p-4 md:overflow-y-auto">
              <TasksView key={projectKey} projectKey={projectKey} refreshKey={reloadKey} onChange={reload} />
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col md:h-dvh">
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-surface px-4 py-3">
        <h1 className="whitespace-nowrap text-base font-bold">Task Runner</h1>
        {tab !== "rules" && <ProjectSelector projects={projects ?? []} selected={projectKey} onSelect={selectProject} />}
        {tab !== "rules" && projectKey && <SearchBar key={projectKey} onSearch={search} status={searchStatus} />}
        <HeaderActions onRefresh={reload} />
      </header>
      <main className="flex flex-1 flex-col md:min-h-0">{body}</main>
    </div>
  );
}

function Notice({ title, children }: { title?: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-md text-center text-sm text-muted">
        {title && <h2 className="mb-2 text-base font-semibold text-fg">{title}</h2>}
        {children}
      </div>
    </div>
  );
}
