"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { Entity, Relation, EntityType, GraphData } from "../lib/types";
import { ENTITY_COLORS } from "../lib/types";

const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), {
  ssr: false,
});

interface GraphNode {
  id: string;
  name: string;
  entity_type: EntityType;
  importance: number;
  observation_count: number;
  color: string;
  highlighted?: boolean;
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
  onSelectEntity: (id: string) => void;
}

const ENTITY_TYPE_LABELS: Record<string, string> = {
  preference: "Preferences",
  decision: "Decisions",
  pattern: "Patterns",
  file: "Files",
  concept: "Concepts",
  tool: "Tools",
  pitfall: "Pitfalls",
  convention: "Conventions",
};

export default function GraphView({ data, highlightIds, onSelectEntity }: Props) {
  const [graphData, setGraphData] = useState<{
    nodes: GraphNode[];
    links: GraphLink[];
  }>({ nodes: [], links: [] });
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 500 });
  const [hoverNode, setHoverNode] = useState<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setDimensions({ width, height: Math.max(height, 400) });
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (!data) return;

    const nodes: GraphNode[] = data.entities.map((e: Entity) => ({
      id: e.id,
      name: e.name,
      entity_type: e.entity_type,
      importance: e.importance,
      observation_count: e.observation_count,
      color: ENTITY_COLORS[e.entity_type] || "#6b7280",
      highlighted: highlightIds.size === 0 || highlightIds.has(e.id),
    }));

    const nodeIds = new Set(nodes.map((n) => n.id));
    const links: GraphLink[] = data.relations
      .filter(
        (r: Relation) => nodeIds.has(r.source_id) && nodeIds.has(r.target_id)
      )
      .map((r: Relation) => ({
        source: r.source_id,
        target: r.target_id,
        relation_type: r.relation_type,
        weight: r.weight,
      }));

    setGraphData({ nodes, links });
  }, [data, highlightIds]);

  const nodeCanvasObject = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (node: any, ctx: CanvasRenderingContext2D) => {
      const x = node.x as number;
      const y = node.y as number;
      if (!isFinite(x) || !isFinite(y)) return;
      const size = 5 + (node.importance || 0.5) * 14;
      const isHighlighted = node.highlighted !== false;
      const isHovered = hoverNode === node.id;
      const alpha = isHighlighted ? 1 : 0.15;

      ctx.globalAlpha = alpha;

      // Glow effect for hovered/highlighted nodes
      if (isHovered || (isHighlighted && highlightIds.size > 0 && highlightIds.has(node.id))) {
        ctx.beginPath();
        ctx.arc(x, y, size + 6, 0, 2 * Math.PI);
        const gradient = ctx.createRadialGradient(x, y, size, x, y, size + 6);
        gradient.addColorStop(0, node.color + "60");
        gradient.addColorStop(1, node.color + "00");
        ctx.fillStyle = gradient;
        ctx.fill();
      }

      // Node circle with gradient fill
      ctx.beginPath();
      ctx.arc(x, y, size, 0, 2 * Math.PI);
      const grad = ctx.createRadialGradient(x - size * 0.3, y - size * 0.3, 0, x, y, size);
      grad.addColorStop(0, node.color + "ff");
      grad.addColorStop(1, node.color + "aa");
      ctx.fillStyle = grad;
      ctx.fill();

      // Border
      ctx.strokeStyle = isHovered ? "rgba(255,255,255,0.8)" : "rgba(255,255,255,0.2)";
      ctx.lineWidth = isHovered ? 1.5 : 0.5;
      ctx.stroke();

      // Observation count badge
      if (node.observation_count > 0) {
        const badgeX = x + size * 0.7;
        const badgeY = y - size * 0.7;
        const badgeR = 5;
        ctx.beginPath();
        ctx.arc(badgeX, badgeY, badgeR, 0, 2 * Math.PI);
        ctx.fillStyle = "#1e293b";
        ctx.fill();
        ctx.strokeStyle = node.color;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.font = "7px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#fff";
        ctx.fillText(String(node.observation_count), badgeX, badgeY);
      }

      // Label
      const fontSize = Math.max(10, Math.min(13, size * 0.9));
      ctx.font = `${fontSize}px Inter, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillStyle = isHovered ? "#ffffff" : "rgba(255,255,255,0.85)";
      ctx.fillText(node.name, x, y + size + 3);

      // Type label (smaller, below name)
      if (isHovered) {
        ctx.font = "9px Inter, system-ui, sans-serif";
        ctx.fillStyle = node.color + "cc";
        ctx.fillText(node.entity_type, x, y + size + 3 + fontSize + 2);
      }

      ctx.globalAlpha = 1;
    },
    [hoverNode, highlightIds]
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const linkCanvasObject = useCallback((link: any, ctx: CanvasRenderingContext2D) => {
    const start = link.source;
    const end = link.target;
    if (!start || !end || typeof start.x !== "number") return;

    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist === 0) return;

    // Draw link line
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.strokeStyle = "rgba(100, 116, 139, 0.3)";
    ctx.lineWidth = Math.max(0.5, (link.weight || 1) * 0.8);
    ctx.stroke();

    // Arrow
    const arrowLen = 5;
    const arrowPos = 0.85;
    const ax = start.x + dx * arrowPos;
    const ay = start.y + dy * arrowPos;
    const angle = Math.atan2(dy, dx);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(
      ax - arrowLen * Math.cos(angle - Math.PI / 6),
      ay - arrowLen * Math.sin(angle - Math.PI / 6)
    );
    ctx.lineTo(
      ax - arrowLen * Math.cos(angle + Math.PI / 6),
      ay - arrowLen * Math.sin(angle + Math.PI / 6)
    );
    ctx.fillStyle = "rgba(100, 116, 139, 0.5)";
    ctx.fill();

    // Relation label at midpoint
    if (dist > 60) {
      const mx = start.x + dx * 0.5;
      const my = start.y + dy * 0.5;
      ctx.font = "8px Inter, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "rgba(148, 163, 184, 0.6)";
      // Rotate text to align with link
      ctx.save();
      ctx.translate(mx, my);
      let textAngle = angle;
      if (textAngle > Math.PI / 2 || textAngle < -Math.PI / 2) {
        textAngle += Math.PI;
      }
      ctx.rotate(textAngle);
      ctx.fillText(link.relation_type.replace(/_/g, " "), 0, -5);
      ctx.restore();
    }
  }, []);

  if (!data || data.entities.length === 0) {
    return (
      <div
        ref={containerRef}
        className="flex items-center justify-center h-full text-gray-500 text-sm"
      >
        {data ? "No entities found. Use remember() to add knowledge." : "Loading graph..."}
      </div>
    );
  }

  // Entity type legend
  const typeCounts: Record<string, number> = {};
  for (const e of data.entities) {
    typeCounts[e.entity_type] = (typeCounts[e.entity_type] || 0) + 1;
  }

  return (
    <div ref={containerRef} className="w-full h-full min-h-[400px] relative">
      {/* Legend */}
      <div className="absolute top-2 left-2 z-10 bg-gray-900/80 backdrop-blur rounded-lg p-2 space-y-1">
        {Object.entries(typeCounts).map(([type, count]) => (
          <div key={type} className="flex items-center gap-2 text-xs">
            <span
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{ backgroundColor: ENTITY_COLORS[type as EntityType] || "#6b7280" }}
            />
            <span className="text-gray-400">
              {ENTITY_TYPE_LABELS[type] || type} ({count})
            </span>
          </div>
        ))}
      </div>

      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <ForceGraph2D
        graphData={graphData}
        width={dimensions.width}
        height={dimensions.height}
        nodeCanvasObject={nodeCanvasObject as any}
        nodePointerAreaPaint={((node: any, color: string, ctx: CanvasRenderingContext2D) => {
          if (!isFinite(node.x) || !isFinite(node.y)) return;
          const size = 5 + (node.importance || 0.5) * 14;
          ctx.beginPath();
          ctx.arc(node.x, node.y, size + 4, 0, 2 * Math.PI);
          ctx.fillStyle = color;
          ctx.fill();
        }) as any}
        linkCanvasObject={linkCanvasObject as any}
        linkCanvasObjectMode={() => "replace"}
        onNodeClick={((node: any) => onSelectEntity(node.id)) as any}
        onNodeHover={((node: any) => setHoverNode(node?.id || null)) as any}
        backgroundColor="#030712"
        cooldownTicks={100}
        d3AlphaDecay={0.02}
        d3VelocityDecay={0.3}
      />
    </div>
  );
}
