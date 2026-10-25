"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import type { GraphData } from "../lib/types";
import { entityColor } from "../lib/types";
import { useTheme } from "../lib/theme";

type ForceGraphComponent = ComponentType<any>;

interface GraphNode {
  id: string;
  name: string;
  entity_type: string;
  importance: number;
  observation_count: number;
  color: string;
  x?: number;
  y?: number;
}

interface GraphLink {
  source: string;
  target: string;
  relation_type: string;
  weight: number;
}

interface Props {
  data: GraphData | null;
  highlightIds: Set<string>;
  selectedId: string | null;
  onSelectEntity: (id: string) => void;
}

const TYPE_LABELS: Record<string, string> = {
  preference: "Preferences",
  decision: "Decisions",
  pattern: "Patterns",
  file: "Files",
  concept: "Concepts",
  tool: "Tools",
  pitfall: "Pitfalls",
  convention: "Conventions",
};

const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";

interface Palette {
  bg: string;
  fg: string;
  muted: string;
  line: string;
  raised: string;
}

const DEFAULT_PALETTE: Palette = { bg: "#0b0f14", fg: "#e8edf3", muted: "#a9b4c2", line: "#2f3b4a", raised: "#1b2430" };

function readPalette(): Palette {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    bg: read("--bg", DEFAULT_PALETTE.bg),
    fg: read("--fg", DEFAULT_PALETTE.fg),
    muted: read("--muted", DEFAULT_PALETTE.muted),
    line: read("--line", DEFAULT_PALETTE.line),
    raised: read("--raised", DEFAULT_PALETTE.raised),
  };
}

const nodeSize = (importance: number) => 5 + (importance || 0.5) * 14;

export default function GraphView({ data, highlightIds, selectedId, onSelectEntity }: Props) {
  const { theme } = useTheme();
  const [ForceGraph, setForceGraph] = useState<ForceGraphComponent | null>(null);
  const [palette, setPalette] = useState<Palette>(DEFAULT_PALETTE);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hoverId, setHoverId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<any>(undefined);
  const nodeCache = useRef(new Map<string, GraphNode>());

  useEffect(() => {
    let live = true;
    import("react-force-graph-2d").then((m) => {
      if (live) setForceGraph(() => m.default as ForceGraphComponent);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    setPalette(readPalette());
  }, [theme]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: Math.floor(entry.contentRect.width), height: Math.floor(entry.contentRect.height) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Node objects are reused across reloads so the layout does not jump.
  const graph = useMemo(() => {
    const cache = nodeCache.current;
    const seen = new Set<string>();
    const nodes: GraphNode[] = (data?.entities ?? []).map((e) => {
      seen.add(e.id);
      const fields = {
        id: e.id,
        name: e.name,
        entity_type: e.entity_type,
        importance: e.importance,
        observation_count: e.observation_count,
        color: entityColor(e.entity_type),
      };
      const existing = cache.get(e.id);
      if (existing) return Object.assign(existing, fields);
      const node: GraphNode = fields;
      cache.set(e.id, node);
      return node;
    });
    for (const id of cache.keys()) if (!seen.has(id)) cache.delete(id);

    const links: GraphLink[] = (data?.relations ?? [])
      .filter((r) => seen.has(r.source_id) && seen.has(r.target_id))
      .map((r) => ({ source: r.source_id, target: r.target_id, relation_type: r.relation_type, weight: r.weight }));
    return { nodes, links };
  }, [data]);

  const ready = ForceGraph !== null && size.width > 0 && size.height > 0 && graph.nodes.length > 0;
  useEffect(() => {
    const fg = graphRef.current;
    if (!ready || !fg) return;
    fg.d3Force("charge")?.strength(-260).distanceMax(450);
    fg.d3Force("link")?.distance(100);
    // Keeps unlinked nodes from drifting away from the cluster.
    fg.d3Force("gravity", (alpha: number) => {
      for (const n of graph.nodes) {
        if (n.x === undefined || n.y === undefined) continue;
        const v = n as GraphNode & { vx?: number; vy?: number };
        v.vx = (v.vx ?? 0) - n.x * 0.08 * alpha;
        v.vy = (v.vy ?? 0) - n.y * 0.08 * alpha;
      }
    });
    fg.d3ReheatSimulation();
  }, [ready, graph]);

  const fitView = useCallback(() => {
    const fg = graphRef.current;
    if (!fg) return;
    const xs = graph.nodes.map((n) => n.x).filter((v): v is number => v !== undefined && isFinite(v));
    const ys = graph.nodes.map((n) => n.y).filter((v): v is number => v !== undefined && isFinite(v));
    if (xs.length === 0) return;
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    // zoomToFit has no zoom ceiling, so a lone node would fill the screen.
    if (Math.max(spanX, spanY) < 80) {
      fg.centerAt((Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...ys) + Math.min(...ys)) / 2, 300);
      fg.zoom(1.5, 300);
    } else {
      fg.zoomToFit(300, 48);
    }
  }, [graph]);

  const drawNode = useCallback(
    (node: GraphNode, ctx: CanvasRenderingContext2D, scale: number) => {
      const { x, y } = node;
      if (x === undefined || y === undefined || !isFinite(x) || !isFinite(y)) return;
      const r = nodeSize(node.importance);
      const active = highlightIds.size === 0 || highlightIds.has(node.id);
      const hovered = hoverId === node.id;
      const selected = selectedId === node.id;

      ctx.globalAlpha = active ? 1 : 0.18;

      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.fillStyle = node.color;
      ctx.fill();
      ctx.lineWidth = selected || hovered ? 2 : 0.75;
      ctx.strokeStyle = selected || hovered ? palette.fg : palette.line;
      ctx.stroke();

      if (highlightIds.size > 0 && active) {
        ctx.beginPath();
        ctx.arc(x, y, r + 4, 0, 2 * Math.PI);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = node.color;
        ctx.stroke();
      }

      if (node.observation_count > 0) {
        const bx = x + r * 0.7;
        const by = y - r * 0.7;
        ctx.beginPath();
        ctx.arc(bx, by, 5.5, 0, 2 * Math.PI);
        ctx.fillStyle = palette.raised;
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = node.color;
        ctx.stroke();
        ctx.font = `${7 / Math.max(scale, 0.6)}px ${FONT}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = palette.fg;
        ctx.fillText(String(node.observation_count), bx, by);
      }

      const fontSize = 12 / scale;
      ctx.font = `${fontSize}px ${FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillStyle = palette.fg;
      ctx.fillText(node.name, x, y + r + 3 / scale);
      if (hovered) {
        ctx.font = `${10 / scale}px ${FONT}`;
        ctx.fillStyle = palette.muted;
        ctx.fillText(node.entity_type, x, y + r + 3 / scale + fontSize + 2 / scale);
      }

      ctx.globalAlpha = 1;
    },
    [highlightIds, hoverId, selectedId, palette],
  );

  const drawLink = useCallback(
    (link: any, ctx: CanvasRenderingContext2D, scale: number) => {
      const start = link.source;
      const end = link.target;
      if (!start || !end || typeof start.x !== "number" || typeof end.x !== "number") return;
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const dist = Math.hypot(dx, dy);
      if (dist === 0) return;

      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.strokeStyle = palette.line;
      ctx.lineWidth = Math.min(3, Math.max(0.75, (link.weight || 1) * 0.8));
      ctx.stroke();

      // Arrow stops at the target node's edge.
      const angle = Math.atan2(dy, dx);
      const tip = Math.max(0, dist - nodeSize(end.importance) - 2);
      const ax = start.x + Math.cos(angle) * tip;
      const ay = start.y + Math.sin(angle) * tip;
      const len = 6;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax - len * Math.cos(angle - Math.PI / 6), ay - len * Math.sin(angle - Math.PI / 6));
      ctx.lineTo(ax - len * Math.cos(angle + Math.PI / 6), ay - len * Math.sin(angle + Math.PI / 6));
      ctx.closePath();
      ctx.fillStyle = palette.muted;
      ctx.fill();

      if (dist > 70) {
        ctx.save();
        ctx.translate(start.x + dx / 2, start.y + dy / 2);
        let textAngle = angle;
        if (textAngle > Math.PI / 2 || textAngle < -Math.PI / 2) textAngle += Math.PI;
        ctx.rotate(textAngle);
        ctx.font = `${9 / scale}px ${FONT}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillStyle = palette.muted;
        ctx.fillText(String(link.relation_type).replace(/_/g, " "), 0, -2 / scale);
        ctx.restore();
      }
    },
    [palette],
  );

  const paintPointerArea = useCallback((node: GraphNode, color: string, ctx: CanvasRenderingContext2D) => {
    if (node.x === undefined || node.y === undefined || !isFinite(node.x) || !isFinite(node.y)) return;
    ctx.beginPath();
    ctx.arc(node.x, node.y, nodeSize(node.importance) + 4, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
  }, []);

  const entities = data?.entities ?? [];
  const typeCounts: Record<string, number> = {};
  for (const e of entities) typeCounts[e.entity_type] = (typeCounts[e.entity_type] ?? 0) + 1;

  return (
    <div className="flex h-full min-h-[320px] w-full flex-col" style={{ background: palette.bg }}>
      {entities.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-line bg-surface px-3 py-2 text-xs">
          {Object.entries(typeCounts).map(([type, count]) => (
            <span key={type} className="flex items-center gap-1.5 text-muted">
              <span className="pill-dot" style={{ backgroundColor: entityColor(type) }} aria-hidden />
              {TYPE_LABELS[type] ?? type} ({count})
            </span>
          ))}
          <span className="ml-auto">
            <label htmlFor="entity-jump" className="sr-only">
              Open an entity
            </label>
            <select
              id="entity-jump"
              value={selectedId ?? ""}
              onChange={(e) => e.target.value && onSelectEntity(e.target.value)}
              className="field !w-auto !px-1.5 !py-1 !text-xs"
            >
              <option value="">Open an entity…</option>
              {entities.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} ({e.entity_type})
                </option>
              ))}
            </select>
          </span>
        </div>
      )}
      <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden">
        {!data ? (
          <Message>Loading graph…</Message>
        ) : entities.length === 0 ? (
          <Message>No entities in this project yet. They appear when an agent calls the remember tool.</Message>
        ) : (
          ForceGraph &&
          ready && (
            <ForceGraph
              ref={graphRef}
              graphData={graph}
              width={size.width}
              height={size.height}
              backgroundColor={palette.bg}
              nodeCanvasObject={drawNode}
              nodePointerAreaPaint={paintPointerArea}
              linkCanvasObject={drawLink}
              linkCanvasObjectMode={() => "replace"}
              onNodeClick={(node: GraphNode) => onSelectEntity(node.id)}
              onNodeHover={(node: GraphNode | null) => setHoverId(node ? node.id : null)}
              onEngineStop={fitView}
              cooldownTicks={200}
              d3AlphaDecay={0.03}
              d3VelocityDecay={0.35}
            />
          )
        )}
      </div>
    </div>
  );
}

function Message({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted">{children}</div>;
}
