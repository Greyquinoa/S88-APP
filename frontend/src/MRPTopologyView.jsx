import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  useReactFlow,
  EdgeLabelRenderer,
  MarkerType,
  Handle,
  Position,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "dagre";
import "./MRPTopologyView.css";

// ─── Layout constants ─────────────────────────────────────────────────────────

const NODE_W     = 190;
const HEADER_H   = 34;
const PORT_ROW_H = 24;
const BODY_PAD   = 8;
const DAGRE_SEP  = { rankSep: 140, nodeSep: 50 };

// Dynamic node height based on port count
function nodeHeight(portCount) {
  const rows = Math.max(Math.ceil((portCount || 0) / 2), 1);
  return HEADER_H + BODY_PAD + rows * PORT_ROW_H + BODY_PAD;
}

// Y-center of a port row inside the node (for handle placement)
function portHandleY(rowIdx) {
  return HEADER_H + BODY_PAD + rowIdx * PORT_ROW_H + PORT_ROW_H / 2;
}

// ─── Device category ─────────────────────────────────────────────────────────

function getDeviceCategory(dev) {
  if (!dev) return "device";
  if (dev.deviceType === "cpu") return "fieldbus";
  if (dev.isSwitch || /scal|switch|sw\d/i.test(dev.alias || "")) return "switch";
  return "device";
}

const CATEGORY_COLORS = {
  fieldbus: { bg: "#1e40af", border: "#1e3a8a", text: "#fff", badge: "#3b82f6" },
  switch:   { bg: "#c2410c", border: "#9a3412", text: "#fff", badge: "#f97316" },
  device:   { bg: "#374151", border: "#1f2937", text: "#fff", badge: "#6b7280" },
};

// ─── Custom Node — per-port handles ──────────────────────────────────────────

function DeviceNode({ data, selected }) {
  const { dev, connectedPortSubslots, isRingMember, onPortClick } = data;
  const category = getDeviceCategory(dev);
  const colors   = CATEGORY_COLORS[category];
  const ports    = dev?.ports || [];

  // Even-index ports on left, odd-index ports on right
  const leftPorts  = ports.filter((_, i) => i % 2 === 0);
  const rightPorts = ports.filter((_, i) => i % 2 === 1);
  const h = nodeHeight(ports.length);
  const catLabel = { fieldbus: "Fieldbus", switch: "Switch", device: "Device" }[category];

  return (
    <div
      className={[
        "mrp-node",
        `mrp-node--${category}`,
        selected      ? "mrp-node--selected" : "",
        isRingMember  ? "mrp-node--ring"     : "",
      ].filter(Boolean).join(" ")}
      style={{ width: NODE_W, height: h, "--node-border": colors.border }}
    >
      {/* Header */}
      <div
        className="mrp-node__header"
        style={{ background: colors.bg, color: colors.text, height: HEADER_H }}
      >
        <span className="mrp-node__name">{dev?.alias || "—"}</span>
        <span className="mrp-node__badge" style={{ background: colors.badge }}>{catLabel}</span>
      </div>

      {/* Port body */}
      <div className="mrp-node__body" style={{ paddingTop: BODY_PAD, paddingBottom: BODY_PAD }}>
        <div className="mrp-node__ports mrp-node__ports--left">
          {leftPorts.map(p => {
            const on = connectedPortSubslots?.has(p.subslot);
            return (
              <div
                key={p.subslot}
                className={`mrp-node__port ${on ? "mrp-node__port--on" : "mrp-node__port--off"}`}
                style={{ height: PORT_ROW_H, lineHeight: `${PORT_ROW_H}px` }}
                title={p.label || `Port ${p.subslot}`}
                onClick={() => onPortClick?.(dev.alias, p.subslot)}
              >
                <span className="mrp-node__port-dot" />
                <span className="mrp-node__port-label">
                  {(p.label || `P${p.subslot}`).replace(/\s*RJ45\s*/i, "").trim()}
                </span>
              </div>
            );
          })}
        </div>

        <div className="mrp-node__ports mrp-node__ports--right">
          {rightPorts.map(p => {
            const on = connectedPortSubslots?.has(p.subslot);
            return (
              <div
                key={p.subslot}
                className={`mrp-node__port mrp-node__port--rhs ${on ? "mrp-node__port--on" : "mrp-node__port--off"}`}
                style={{ height: PORT_ROW_H, lineHeight: `${PORT_ROW_H}px` }}
                title={p.label || `Port ${p.subslot}`}
                onClick={() => onPortClick?.(dev.alias, p.subslot)}
              >
                <span className="mrp-node__port-label">
                  {(p.label || `P${p.subslot}`).replace(/\s*RJ45\s*/i, "").trim()}
                </span>
                <span className="mrp-node__port-dot" />
              </div>
            );
          })}
        </div>
      </div>

      {isRingMember && <div className="mrp-node__ring-indicator" />}

      {/* ── Per-port handles — source (visible dot) + target (invisible) per port ── */}
      {leftPorts.map((p, i) => {
        const on = connectedPortSubslots?.has(p.subslot);
        const y  = portHandleY(i);
        const base = { top: y, left: 0, borderRadius: "50%", transform: "translate(-50%, -50%)" };
        return (
          <React.Fragment key={p.subslot}>
            <Handle type="source" position={Position.Left} id={`src-${p.subslot}`} isConnectable={false}
              style={{ ...base, width: 10, height: 10, background: on ? "#16a34a" : "#9ca3af", border: "2px solid #fff" }} />
            <Handle type="target" position={Position.Left} id={`tgt-${p.subslot}`} isConnectable={false}
              style={{ ...base, width: 14, height: 14, background: "transparent", border: "none" }} />
          </React.Fragment>
        );
      })}
      {rightPorts.map((p, i) => {
        const on = connectedPortSubslots?.has(p.subslot);
        const y  = portHandleY(i);
        const base = { top: y, right: 0, borderRadius: "50%", transform: "translate(50%, -50%)" };
        return (
          <React.Fragment key={p.subslot}>
            <Handle type="source" position={Position.Right} id={`src-${p.subslot}`} isConnectable={false}
              style={{ ...base, width: 10, height: 10, background: on ? "#16a34a" : "#9ca3af", border: "2px solid #fff" }} />
            <Handle type="target" position={Position.Right} id={`tgt-${p.subslot}`} isConnectable={false}
              style={{ ...base, width: 14, height: 14, background: "transparent", border: "none" }} />
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ─── Custom Edge — horizontal-first orthogonal routing ───────────────────────

function OrthoEdge({ id, sourceX, sourceY, targetX, targetY, data, markerEnd }) {
  const [hovered, setHovered] = useState(false);

  // Horizontal-first orthogonal path: exit port horizontally, jog vertically, arrive horizontally
  const midX = (sourceX + targetX) / 2;
  const path = `M ${sourceX},${sourceY} L ${midX},${sourceY} L ${midX},${targetY} L ${targetX},${targetY}`;

  const tooltipX = midX;
  const tooltipY = (sourceY + targetY) / 2;

  const isRing      = data?.isRing;
  const isHighlight = data?.highlighted;
  const isFaded     = data?.faded;

  const strokeColor = isRing
    ? (isHighlight ? "#f59e0b" : "#f97316")
    : (isHighlight ? "#2563eb" : "#64748b");
  const strokeW = isHighlight ? 3 : isRing ? 2 : 1.5;
  const opacity = isFaded ? 0.1 : 1;

  return (
    <>
      {/* Wide transparent hit area */}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={14}
        style={{ cursor: "pointer" }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
      {/* Visible line */}
      <path
        id={id}
        d={path}
        fill="none"
        stroke={strokeColor}
        strokeWidth={strokeW}
        strokeDasharray={isRing ? "6 3" : "none"}
        style={{ opacity, transition: "opacity 0.15s, stroke 0.15s" }}
        markerEnd={markerEnd}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />

      {/* Hover tooltip */}
      {hovered && data?.label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position:  "absolute",
              transform: `translate(-50%, -100%) translate(${tooltipX}px,${tooltipY - 8}px)`,
              pointerEvents: "none",
            }}
            className="mrp-edge-tooltip"
          >
            {data.label.split("\n").map((line, i) => <div key={i}>{line}</div>)}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

// ─── Dagre layout — uses per-node dimensions ─────────────────────────────────

function applyDagreLayout(nodes, edges) {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", ranksep: DAGRE_SEP.rankSep, nodesep: DAGRE_SEP.nodeSep });

  nodes.forEach(n => {
    const h = n.height || nodeHeight((n.data?.dev?.ports || []).length);
    g.setNode(n.id, { width: NODE_W, height: h });
  });
  edges.forEach(e => g.setEdge(e.source, e.target));

  dagre.layout(g);

  return nodes.map(n => {
    const pos = g.node(n.id);
    const h   = n.height || nodeHeight((n.data?.dev?.ports || []).length);
    return { ...n, position: { x: pos.x - NODE_W / 2, y: pos.y - h / 2 } };
  });
}

// Circular layout for ring view
function applyCircularLayout(nodes) {
  const count  = nodes.length;
  const radius = Math.max(220, count * 65);
  const cx = radius + NODE_W / 2;
  const cy = radius + 60;

  return nodes.map((n, i) => {
    const angle = (2 * Math.PI * i) / count - Math.PI / 2;
    const h = n.height || nodeHeight((n.data?.dev?.ports || []).length);
    return {
      ...n,
      position: {
        x: cx + radius * Math.cos(angle) - NODE_W / 2,
        y: cy + radius * Math.sin(angle) - h / 2,
      },
    };
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function physAlias(alias) {
  return alias ? alias.replace(/#\d+$/, "") : alias;
}

function isRingMember(physicalAlias, roles) {
  for (const [key, val] of roles) {
    if (physAlias(key) === physicalAlias && (val.role ?? 0) !== 0) return true;
  }
  return false;
}

// ─── Build RF nodes & edges ───────────────────────────────────────────────────

function buildGraph(devices, links, roles) {
  // Collect connected port subslots per physical device
  const connectedPorts = new Map();
  for (const [key, val] of links) {
    if (!val.toDevice) continue;
    const [rawFrom, ssStr] = key.split(":");
    const from = physAlias(rawFrom);
    const to   = physAlias(val.toDevice);

    if (!connectedPorts.has(from)) connectedPorts.set(from, new Set());
    connectedPorts.get(from).add(parseInt(ssStr, 10));

    if (!connectedPorts.has(to)) connectedPorts.set(to, new Set());
    connectedPorts.get(to).add(val.toPortSubslot);
  }

  const rfNodes = devices.map(dev => {
    const ring = isRingMember(dev.alias, roles);
    const h    = nodeHeight((dev.ports || []).length);
    return {
      id:     dev.alias,
      type:   "device",
      data:   {
        dev,
        isRingMember:          ring,
        connectedPortSubslots: connectedPorts.get(dev.alias) || new Set(),
        highlighted: false,
        faded:       false,
      },
      position: { x: 0, y: 0 },
      width:  NODE_W,
      height: h,
      style:  { width: NODE_W, height: h },
    };
  });

  // Build edges — one per unique physical port pair
  const edgeSet  = new Set();
  const rfEdges  = [];

  for (const [key, val] of links) {
    if (!val.toDevice) continue;
    const [rawFrom, ssStr] = key.split(":");
    const fromAlias = physAlias(rawFrom);
    const toAlias   = physAlias(val.toDevice);
    const fromPort  = parseInt(ssStr, 10);
    const toPort    = val.toPortSubslot;

    if (!devices.find(d => d.alias === fromAlias)) continue;
    if (!devices.find(d => d.alias === toAlias))   continue;

    // Deduplicate by sorted port pair (A:p1–B:p2 same as B:p2–A:p1)
    const edgeKey = [`${fromAlias}:${fromPort}`, `${toAlias}:${toPort}`].sort().join("--");
    if (edgeSet.has(edgeKey)) continue;
    edgeSet.add(edgeKey);

    const fromDev = devices.find(d => d.alias === fromAlias);
    const toDev   = devices.find(d => d.alias === toAlias);
    const fromPortLabel = fromDev?.ports?.find(p => p.subslot === fromPort)?.label || `Port ${fromPort}`;
    const toPortLabel   = toDev?.ports?.find(p => p.subslot === toPort)?.label   || `Port ${toPort}`;

    const ring = isRingMember(fromAlias, roles) && isRingMember(toAlias, roles);

    rfEdges.push({
      id:           `e-${fromAlias}:${fromPort}-${toAlias}:${toPort}`,
      source:       fromAlias,
      target:       toAlias,
      sourceHandle: `src-${fromPort}`,
      targetHandle: `tgt-${toPort}`,
      type:         "ortho",
      data: {
        isRing:       ring,
        highlighted:  false,
        faded:        false,
        label: `Source: ${fromAlias} ${fromPortLabel}\nDestination: ${toAlias} ${toPortLabel}`,
      },
      markerEnd: { type: MarkerType.Arrow, width: 10, height: 10 },
    });
  }

  return { rfNodes, rfEdges };
}

// ─── Topology Canvas ──────────────────────────────────────────────────────────

const nodeTypes = { device: DeviceNode };
const edgeTypes = { ortho: OrthoEdge };

function TopologyCanvas({ devices, links, roles, domainName }) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [layout,   setLayout]   = useState("hierarchy");
  const [selected, setSelected] = useState(null);
  const { fitView } = useReactFlow();

  const ringAliases = useMemo(
    () => new Set([...roles.entries()].filter(([, r]) => r.role !== 0).map(([a]) => physAlias(a))),
    [roles],
  );
  const hasRing = ringAliases.size > 0;

  useEffect(() => {
    const { rfNodes, rfEdges } = buildGraph(devices, links, roles);
    if (rfNodes.length === 0) return;

    let positioned;
    if (layout === "ring" && hasRing) {
      const ringNodes    = rfNodes.filter(n => ringAliases.has(n.id));
      const nonRingNodes = rfNodes.filter(n => !ringAliases.has(n.id));
      const circled      = applyCircularLayout(ringNodes);
      const maxRingY     = circled.reduce((m, n) => Math.max(m, n.position.y + (n.height || 90)), 0);
      const extra        = nonRingNodes.length > 0
        ? applyDagreLayout(nonRingNodes, rfEdges).map(n => ({
            ...n, position: { ...n.position, y: n.position.y + maxRingY + 80 },
          }))
        : [];
      positioned = [...circled, ...extra];
    } else {
      positioned = applyDagreLayout(rfNodes, rfEdges);
    }

    // Highlight / fade based on selection
    const finalNodes = positioned.map(n => {
      const isSel   = selected === n.id;
      const isConn  = selected
        ? rfEdges.some(e => (e.source === selected || e.target === selected) && (e.source === n.id || e.target === n.id))
        : false;
      return {
        ...n,
        selected: isSel,
        data: {
          ...n.data,
          highlighted: isSel || isConn,
          faded: selected != null && !isSel && !isConn,
        },
      };
    });

    const finalEdges = rfEdges.map(e => {
      const touches = selected === e.source || selected === e.target || selected === e.id;
      return {
        ...e,
        data: { ...e.data, highlighted: touches, faded: selected != null && !touches },
      };
    });

    setNodes(finalNodes);
    setEdges(finalEdges);
    setTimeout(() => fitView({ padding: 0.12 }), 80);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices, links, roles, domainName, layout, selected]);

  const onNodeClick = useCallback((_, n) => setSelected(p => p === n.id ? null : n.id), []);
  const onEdgeClick = useCallback((_, e) => setSelected(p => p === e.id ? null : e.id), []);
  const onPaneClick = useCallback(() => setSelected(null), []);

  const onPortClick = useCallback((alias, portSubslot) => {
    const key  = `${alias}:${portSubslot}`;
    const link = links.get(key);
    if (link?.toDevice) {
      const toAlias = physAlias(link.toDevice);
      const fwd = `e-${alias}:${portSubslot}-${toAlias}:${link.toPortSubslot}`;
      const rev = `e-${toAlias}:${link.toPortSubslot}-${alias}:${portSubslot}`;
      setSelected(p => {
        const match = edges.find(e => e.id === fwd || e.id === rev);
        const matchId = match?.id ?? null;
        return p === matchId ? null : matchId;
      });
    }
  }, [links, edges]);

  const nodesWithCb = useMemo(
    () => nodes.map(n => ({ ...n, data: { ...n.data, onPortClick } })),
    [nodes, onPortClick],
  );

  return (
    <div className="mrp-topology">
      {/* Toolbar */}
      <div className="mrp-topology__toolbar">
        <div className="mrp-topology__toolbar-left">
          <span className="mrp-topology__title">Network Topology</span>
          {hasRing && (
            <span className="mrp-topology__ring-badge">MRP Ring · {ringAliases.size} devices</span>
          )}
        </div>
        <div className="mrp-topology__toolbar-right">
          <button
            className={`mrp-toolbar-btn${layout === "hierarchy" ? " mrp-toolbar-btn--active" : ""}`}
            onClick={() => setLayout("hierarchy")}
          >Hierarchy</button>
          {hasRing && (
            <button
              className={`mrp-toolbar-btn${layout === "ring" ? " mrp-toolbar-btn--active" : ""}`}
              onClick={() => setLayout("ring")}
            >Ring View</button>
          )}
          <button className="mrp-toolbar-btn" onClick={() => fitView({ padding: 0.12 })}>
            Fit View
          </button>
        </div>
      </div>

      {/* Legend */}
      <div className="mrp-topology__legend">
        {[
          { cat: "fieldbus", label: "Fieldbus" },
          { cat: "switch",   label: "Managed Switch" },
          { cat: "device",   label: "End Device" },
        ].map(({ cat, label }) => (
          <div key={cat} className="mrp-legend-item">
            <span className="mrp-legend-dot" style={{ background: CATEGORY_COLORS[cat].bg }} />
            <span>{label}</span>
          </div>
        ))}
        <div className="mrp-legend-item">
          <span className="mrp-legend-line mrp-legend-line--ring" />
          <span>MRP Ring</span>
        </div>
        <div className="mrp-legend-item">
          <span className="mrp-legend-line" />
          <span>Link</span>
        </div>
        {selected && (
          <button className="mrp-legend-clear" onClick={() => setSelected(null)}>
            ✕ Clear selection
          </button>
        )}
      </div>

      {/* Canvas */}
      <div className="mrp-topology__canvas">
        <ReactFlow
          nodes={nodesWithCb}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          onEdgeClick={onEdgeClick}
          onPaneClick={onPaneClick}
          fitView
          fitViewOptions={{ padding: 0.12 }}
          minZoom={0.15}
          maxZoom={3}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="#e2e8f0" gap={24} />
          <Controls showInteractive={false} />
          <MiniMap
            nodeColor={n => CATEGORY_COLORS[getDeviceCategory(n.data?.dev)]?.bg ?? "#64748b"}
            pannable
            zoomable
          />
        </ReactFlow>
      </div>
    </div>
  );
}

// ─── Public export ────────────────────────────────────────────────────────────

export default function MRPTopologyView({ devices, links, roles, domainName }) {
  if (!devices || devices.length === 0) {
    return (
      <div className="mrp-topology mrp-topology--empty">
        <p>No devices to display. Configure port connections first.</p>
      </div>
    );
  }
  return (
    <ReactFlowProvider>
      <TopologyCanvas devices={devices} links={links} roles={roles} domainName={domainName} />
    </ReactFlowProvider>
  );
}
