"use client";

import { useEffect, useState } from "react";
import { fetchApi } from "../lib/api";
import type { Entity, Observation, Relation } from "../lib/types";
import { ENTITY_COLORS } from "../lib/types";

interface EntityDetail {
  entity: Entity;
  observations: Observation[];
  relations: {
    outgoing: (Relation & { target_name: string; target_type: string })[];
    incoming: (Relation & { source_name: string; source_type: string })[];
  };
}

interface Props {
  entityId: string | null;
  projectKey: string;
  onClose: () => void;
}

export default function EntityPanel({ entityId, projectKey, onClose }: Props) {
  const [detail, setDetail] = useState<EntityDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!entityId) {
      setDetail(null);
      return;
    }
    setLoading(true);
    fetchApi<{ success: boolean } & EntityDetail>(
      `/entities?id=${entityId}&project_key=${projectKey}`
    )
      .then((d) => {
        if (d.success) setDetail(d);
      })
      .finally(() => setLoading(false));
  }, [entityId, projectKey]);

  if (!entityId) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm">
        Click an entity node to view details
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm">
        Loading...
      </div>
    );
  }

  if (!detail) return null;

  const { entity, observations, relations } = detail;
  const typeColor =
    ENTITY_COLORS[entity.entity_type as keyof typeof ENTITY_COLORS] || "#6b7280";

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-bold">{entity.name}</h2>
          <span
            className="inline-block text-xs px-2 py-0.5 rounded-full mt-1"
            style={{ backgroundColor: typeColor + "30", color: typeColor }}
          >
            {entity.entity_type}
          </span>
        </div>
        <button
          onClick={onClose}
          className="text-gray-500 hover:text-gray-300 text-lg"
        >
          &times;
        </button>
      </div>

      {/* Importance */}
      <div className="flex items-center gap-3 text-sm">
        <div>
          <span className="text-gray-500">Importance: </span>
          <span className="font-mono">{entity.importance.toFixed(2)}</span>
        </div>
        <div>
          <span className="text-gray-500">Accessed: </span>
          <span className="font-mono">{entity.access_count}x</span>
        </div>
      </div>

      {/* Summary */}
      {entity.summary && (
        <div className="text-sm text-gray-300 bg-gray-800/50 rounded-lg p-3">
          {entity.summary}
        </div>
      )}

      {/* Observations */}
      <div>
        <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-2">
          Observations ({observations.length})
        </h3>
        <div className="space-y-2">
          {observations.map((obs) => (
            <div
              key={obs.id}
              className="bg-gray-800 rounded-lg p-3 text-sm border border-gray-700"
            >
              <div className="text-gray-200">{obs.content}</div>
              <div className="text-xs text-gray-500 mt-1 flex gap-3">
                <span>Confidence: {obs.confidence}</span>
                <span>
                  {new Date(obs.valid_from * 1000).toLocaleDateString()}
                </span>
              </div>
            </div>
          ))}
          {observations.length === 0 && (
            <div className="text-sm text-gray-600">No observations</div>
          )}
        </div>
      </div>

      {/* Relations */}
      {(relations.outgoing.length > 0 || relations.incoming.length > 0) && (
        <div>
          <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-2">
            Relations
          </h3>
          <div className="space-y-1 text-sm">
            {relations.outgoing.map((r) => (
              <div key={r.id} className="flex items-center gap-2 text-gray-300">
                <span className="text-gray-500">→</span>
                <span className="text-blue-400">{r.relation_type}</span>
                <span>{r.target_name}</span>
                <span className="text-xs text-gray-600">({r.target_type})</span>
              </div>
            ))}
            {relations.incoming.map((r) => (
              <div key={r.id} className="flex items-center gap-2 text-gray-300">
                <span className="text-gray-500">←</span>
                <span className="text-green-400">{r.relation_type}</span>
                <span>{r.source_name}</span>
                <span className="text-xs text-gray-600">({r.source_type})</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
