"use client";

import { useEffect, useMemo, useState } from "react";
import { deleteApi, errorMessage, fetchApi, qs } from "../lib/api";
import { formatDate } from "../lib/format";
import type { Preference } from "../lib/types";

interface Props {
  refreshKey: number;
}

function scopeLabel(p: Preference): string {
  if (p.scope === "global") return "Everywhere";
  return p.scope === "org" ? `Organization · ${p.ref}` : `Project · ${p.ref}`;
}

function firmness(confidence: number): { label: string; color: string } {
  if (confidence >= 0.85) return { label: "Firm", color: "text-ok" };
  if (confidence >= 0.65) return { label: "Settling", color: "text-info" };
  return { label: "New", color: "text-warn" };
}

export default function TasteView({ refreshKey }: Props) {
  const [prefs, setPrefs] = useState<Preference[] | null>(null);
  const [filter, setFilter] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchApi<{ preferences: Preference[] }>("/taste")
      .then((d) => {
        if (!live) return;
        setPrefs(d.preferences);
        setError(null);
      })
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [refreshKey]);

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const shown = (prefs ?? []).filter(
      (p) => !needle || p.rule.toLowerCase().includes(needle) || p.area.includes(needle) || p.ref.toLowerCase().includes(needle),
    );
    const order = (p: Preference) => (p.scope === "global" ? 0 : p.scope === "org" ? 1 : 2);
    const map = new Map<string, Preference[]>();
    for (const p of [...shown].sort((a, b) => order(a) - order(b) || a.ref.localeCompare(b.ref))) {
      const label = scopeLabel(p);
      map.set(label, [...(map.get(label) ?? []), p]);
    }
    return [...map.entries()];
  }, [prefs, filter]);

  async function forget(id: string) {
    try {
      await deleteApi(`/taste${qs({ id })}`);
      setPrefs((cur) => (cur ?? []).filter((p) => p.id !== id));
      setConfirmId(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  if (!prefs) {
    return error ? (
      <p className="py-8 text-center text-sm text-bad" role="alert">
        {error}
      </p>
    ) : (
      <p className="py-8 text-center text-sm text-muted">Loading…</p>
    );
  }

  if (prefs.length === 0) {
    return (
      <div className="py-12 text-center">
        <p className="text-sm text-muted">No preferences learned yet.</p>
        <p className="mx-auto mt-2 max-w-md text-xs text-muted">
          Taste learns how you want things done from what you say in Claude Code sessions. Each preference is added to
          every new session.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="flex-1 text-sm text-muted">
          {prefs.length} {prefs.length === 1 ? "preference" : "preferences"} learned from what you said. Each one is
          added to new sessions; saying it again makes it firmer.
        </p>
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter"
          aria-label="Filter preferences"
          className="field w-full sm:w-56"
        />
      </div>

      {error && (
        <p className="text-sm text-bad" role="alert">
          {error}
        </p>
      )}

      {groups.length === 0 && <p className="py-6 text-center text-sm text-muted">No preference matches the filter.</p>}

      {groups.map(([label, items]) => (
        <section key={label} aria-label={label} className="space-y-2">
          <h3 className="text-xs uppercase tracking-wide text-muted">
            {label} <span className="normal-case tracking-normal">({items.length})</span>
          </h3>
          <ul className="space-y-2">
            {items.map((p) => {
              const firm = firmness(p.confidence);
              return (
                <li key={p.id} className="card p-3">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <p className="text-sm">{p.rule}</p>
                      {p.replaced && <p className="text-xs text-muted line-through">{p.replaced}</p>}
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                        <span className="status text-link">{p.area}</span>
                        <span className={`status ${firm.color}`}>{firm.label}</span>
                        <span
                          className="inline-flex h-1.5 w-16 overflow-hidden rounded-full bg-raised"
                          role="meter"
                          aria-label="Confidence"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={Math.round(p.confidence * 100)}
                        >
                          <span className="h-full bg-ok" style={{ width: `${Math.round(p.confidence * 100)}%` }} />
                        </span>
                        <span>
                          said {p.hits === 1 ? "once" : `${p.hits} times`}
                        </span>
                        <span>updated {formatDate(p.updated_at)}</span>
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      {confirmId === p.id ? (
                        <>
                          <button type="button" onClick={() => forget(p.id)} className="btn btn-sm btn-danger">
                            Forget
                          </button>
                          <button type="button" onClick={() => setConfirmId(null)} className="btn btn-sm">
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmId(p.id)}
                          className="btn btn-sm"
                          aria-label={`Forget: ${p.rule}`}
                        >
                          Forget
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
