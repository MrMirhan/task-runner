"use client";

import { useEffect, useState } from "react";
import { errorMessage, fetchApi, postApi, qs } from "../lib/api";
import { formatDate } from "../lib/format";
import type { EntityDetail } from "../lib/types";
import { entityColor } from "../lib/types";

interface Props {
  entityId: string | null;
  refreshKey: number;
  onClose: () => void;
  onForgotten: () => void;
}

function parseProperties(raw: string | null): Array<[string, string]> | string | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.entries(value).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]);
    }
  } catch {
    // not JSON: show as text
  }
  return raw;
}

export default function EntityPanel({ entityId, refreshKey, onClose, onForgotten }: Props) {
  const [detail, setDetail] = useState<EntityDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState(false);

  useEffect(() => {
    setError(null);
    if (!entityId) {
      setDetail(null);
      return;
    }
    let live = true;
    setLoading(true);
    fetchApi<EntityDetail>(`/entities${qs({ id: entityId })}`)
      .then((d) => live && setDetail(d))
      .catch((e) => {
        if (!live) return;
        setDetail(null);
        setError(errorMessage(e));
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [entityId, refreshKey]);

  async function forget() {
    if (!detail) return;
    const { name, entity_type, project_key } = detail.entity;
    const ok = window.confirm(
      `Forget "${name}" (${entity_type})?\n\nThe entity, its facts and its relations are removed from the graph and from recall.`,
    );
    if (!ok) return;
    setForgetting(true);
    setError(null);
    try {
      await postApi("/entities/forget", { project_key, name, entity_type });
      onForgotten();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setForgetting(false);
    }
  }

  if (!entityId) {
    return <Placeholder>Select an entity in the graph to see its facts and relations.</Placeholder>;
  }
  if (!detail) {
    return error ? (
      <div className="p-4 text-sm text-bad" role="alert">
        {error}
      </div>
    ) : (
      <Placeholder>{loading ? "Loading…" : ""}</Placeholder>
    );
  }

  const { entity, observations, relations } = detail;
  const properties = parseProperties(entity.properties);

  return (
    <div className="h-full space-y-4 overflow-y-auto p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="break-words text-lg font-bold">{entity.name}</h2>
          <span className="pill mt-1">
            <span className="pill-dot" style={{ backgroundColor: entityColor(entity.entity_type) }} aria-hidden />
            {entity.entity_type}
          </span>
        </div>
        <button type="button" onClick={onClose} className="btn btn-sm" aria-label="Close entity panel">
          Close
        </button>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
        <span>
          Importance <span className="font-mono text-fg">{entity.importance.toFixed(2)}</span>
        </span>
        <span>
          Recalled <span className="font-mono text-fg">{entity.access_count}x</span>
        </span>
        <span>
          Created <span className="text-fg">{formatDate(entity.created_at)}</span>
        </span>
      </div>

      {entity.summary && <p className="rounded-lg bg-raised p-3 text-sm">{entity.summary}</p>}

      {typeof properties === "string" && <p className="break-words text-xs text-muted">{properties}</p>}
      {Array.isArray(properties) && properties.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {properties.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="break-words">{v}</dd>
            </div>
          ))}
        </dl>
      )}

      <section aria-labelledby="facts-title">
        <h3 id="facts-title" className="section-title">
          Facts ({observations.length})
        </h3>
        {observations.length === 0 ? (
          <p className="text-sm text-muted">No facts recorded.</p>
        ) : (
          <ul className="space-y-2">
            {observations.map((obs) => (
              <li key={obs.id} className="card p-3 text-sm">
                <p className="break-words">{obs.content}</p>
                <p className="mt-1 text-xs text-muted">
                  {formatDate(obs.created_at)}
                  {obs.confidence < 1 && <span className="ml-3">Confidence {obs.confidence}</span>}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {(relations.outgoing.length > 0 || relations.incoming.length > 0) && (
        <section aria-labelledby="relations-title">
          <h3 id="relations-title" className="section-title">
            Relations
          </h3>
          <ul className="space-y-1 text-sm">
            {relations.outgoing.map((r) => (
              <li key={r.id} className="flex flex-wrap items-baseline gap-x-2">
                <span aria-label="outgoing" className="text-muted">
                  →
                </span>
                <span className="text-link">{r.relation_type.replace(/_/g, " ")}</span>
                <span>{r.target_name}</span>
                <span className="text-xs text-muted">({r.target_type})</span>
              </li>
            ))}
            {relations.incoming.map((r) => (
              <li key={r.id} className="flex flex-wrap items-baseline gap-x-2">
                <span aria-label="incoming" className="text-muted">
                  ←
                </span>
                <span className="text-ok">{r.relation_type.replace(/_/g, " ")}</span>
                <span>{r.source_name}</span>
                <span className="text-xs text-muted">({r.source_type})</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {error && (
        <p className="text-sm text-bad" role="alert">
          {error}
        </p>
      )}

      <div className="border-t border-line pt-4">
        <button type="button" onClick={forget} disabled={forgetting} className="btn btn-danger">
          {forgetting ? "Forgetting…" : "Forget"}
        </button>
      </div>
    </div>
  );
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted">{children}</div>;
}
