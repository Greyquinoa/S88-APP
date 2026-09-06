import React, { useEffect, useRef, useState } from 'react';
import { HierarchyDiagram } from './HierarchyDiagram';

/**
 * UnitTypeSpirograph - Visualizes EPH → EM → CM relationships within a unit type.
 * Shows all members of a composite and their internal structure as a circular diagram.
 *
 * Props:
 *  - unitTypeName: string (displayed in header)
 *  - members: array of unit type members with compositeCmId
 *  - compositeCmTypes: global composite list
 *  - compDetails: { compositeId -> { members: [...] } }
 *  - cmtProfiles: global CM type list
 */
export default function UnitTypeSpirograph({
  unitTypeName = "Unit Type",
  members = [],
  compositeCmTypes = [],
  compDetails = {},
  cmtProfiles = [],
  unitLevelConnections = [],
  onClose
}) {
  const canvasRef = useRef(null);
  const [hoveredNodeId, setHoveredNodeId] = useState(null);
  const [infoText, setInfoText] = useState("hover a node to explore relationships");
  const [viewMode, setViewMode] = useState('spirograph'); // 'spirograph' or 'hierarchy'

  // Reset hover state when switching views
  useEffect(() => {
    setHoveredNodeId(null);
    setInfoText("hover a node to explore relationships");
  }, [viewMode]);

  const libTypeOf = (cmTypeName) =>
    cmtProfiles.find(p => p.id === cmTypeName)?.libType || '';
  const nodeTypeOf = (libType) =>
    libType === 'EquipmentPhase' ? 'EPH' : libType === 'EquipmentModule' ? 'EM' : 'CM';

  const buildHierarchyGraph = React.useCallback(() => {
    const nodes = [];
    const edges = [];

    const memberNodeType = (m) => {
      const comp = compDetails[m.compositeCmId];
      if (!comp || !comp.members) return 'CM';
      const types = new Set(comp.members.map(sm => nodeTypeOf(libTypeOf(sm.cm_type_name))));
      if (types.has('EPH')) return 'EPH';
      if (types.has('EM')) return 'EM';
      return 'CM';
    };

    // Create one node per member (like spirograph), classify by highest level
    members.forEach((m, memberIdx) => {
      if (!m.compositeCmId) return;
      const type = memberNodeType(m);
      const level = type === 'EPH' ? 'top' : type === 'EM' ? 'mid' : 'bottom';

      nodes.push({
        id: String(memberIdx),
        label: m.alias || `Member ${memberIdx}`,
        type,
        level,
        memberAlias: m.alias,
      });
    });

    // Build edges from role assignments and unit connections
    const nodeIdByAlias = new Map(members.map((m, idx) => [m.alias, String(idx)]));
    const nodeIds = new Set(nodes.map(n => n.id));
    const seenEdges = new Set();

    const addEdge = (a, b, isUnitConnection = false) => {
      if (!nodeIds.has(a) || !nodeIds.has(b) || a === b) return;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (seenEdges.has(key)) return;
      seenEdges.add(key);
      edges.push({ a, b, isUnitConnection });
    };

    // Member-to-member edges from role assignments (solid lines)
    members.forEach((m, memberIdx) => {
      (m.roleAssignments || []).forEach(role => {
        const targetNodeId = nodeIdByAlias.get(role.targetAlias);
        if (targetNodeId == null) return;
        addEdge(String(memberIdx), targetNodeId, false);
      });
    });

    // Unit-level connections (dotted lines - IO/wiring)
    (unitLevelConnections || []).forEach(conn => {
      if (conn.from_alias && conn.to_alias) {
        const fromId = nodeIdByAlias.get(conn.from_alias);
        const toId = nodeIdByAlias.get(conn.to_alias);
        if (fromId != null && toId != null) {
          addEdge(fromId, toId, true);
        }
      }
    });

    return { nodes, edges };
  }, [members, compDetails, cmtProfiles, unitLevelConnections, libTypeOf, nodeTypeOf]);

  useEffect(() => {
    if (!canvasRef.current) return;

    // Build node and edge data from the unit type members — collapsed to one
    // node per unit-type member (labeled by its alias), not per composite
    // sub-member.
    //
    // Data model (see backend routes/unitTypes.js loadUnitTypeDetail):
    //  - Each unit type "member" (row in `members`) has an alias + a composite
    //    CM type (compositeCmId). The composite itself has its own list of
    //    sub-members (comp.members), each an EPH/EM/CM instance.
    //  - roleAssignments live on the unit-type member and are CROSS-composite:
    //    sourceMemberIdx is a sub-member index within *this* member's own
    //    composite; targetAlias + targetMemberIdx point at a sub-member of a
    //    *different* unit-type member (resolved by alias). For the collapsed
    //    view we only need the member-level (alias) endpoints.
    //  - unitLevelConnections are stored separately and are unit-level
    //    interconnections between members and the __UNIT__ (unit controller).
    const nodes = [];
    const edges = [];
    const unitConnEdges = []; // Unit-level connections (highlighted separately)


    const libTypeOf = (cmTypeName) =>
      cmtProfiles.find(p => p.id === cmTypeName)?.libType || '';
    const nodeTypeOf = (libType) =>
      libType === 'EquipmentPhase' ? 'EPH' : libType === 'EquipmentModule' ? 'EM' : 'CM';

    // Classify a unit-type member's overall node type by the "highest" S88
    // level present among its composite's sub-members (EPH > EM > CM).
    const memberNodeType = (m) => {
      const comp = compDetails[m.compositeCmId];
      if (!comp || !comp.members) return 'CM';
      const types = new Set(comp.members.map(sm => nodeTypeOf(libTypeOf(sm.cm_type_name))));
      if (types.has('EPH')) return 'EPH';
      if (types.has('EM')) return 'EM';
      return 'CM';
    };

    members.forEach((m, memberIdx) => {
      if (!m.compositeCmId) return;
      nodes.push({
        id: String(memberIdx),
        label: m.alias || `Member ${memberIdx}`,
        type: memberNodeType(m),
        memberAlias: m.alias || `Member ${memberIdx}`,
      });
    });

    // alias -> node id, so a role's targetAlias can be resolved
    const nodeIdByAlias = new Map(members.map((m, idx) => [m.alias, String(idx)]));

    const nodeIds = new Set(nodes.map(n => n.id));
    const seenEdges = new Set();
    const addEdge = (a, b) => {
      if (!nodeIds.has(a) || !nodeIds.has(b) || a === b) return;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (seenEdges.has(key)) return;
      seenEdges.add(key);
      edges.push({ a, b });
    };

    // Member-to-member edges from role assignments (collapsed — sub-member
    // indices are dropped, only the owning aliases matter here).
    members.forEach((m, memberIdx) => {
      (m.roleAssignments || []).forEach(role => {
        const targetNodeId = nodeIdByAlias.get(role.targetAlias);
        if (targetNodeId == null) return;
        addEdge(String(memberIdx), targetNodeId);
      });
    });

    // Unit-level connections — member-to-member interconnections (separate from role assignments)
    (unitLevelConnections || []).forEach(conn => {
      if (conn.from_alias && conn.to_alias) {
        const fromId = nodeIdByAlias.get(conn.from_alias);
        const toId = nodeIdByAlias.get(conn.to_alias);
        if (fromId != null && toId != null) {
          unitConnEdges.push({ from: fromId, to: toId, label: `${conn.from_var_name}→${conn.to_var_name}` });
        }
      }
    });

    // Draw the spirograph only if we have nodes
    if (nodes.length > 0) {
      drawSpirograph(canvasRef.current, nodes, edges, unitConnEdges, hoveredNodeId, setHoveredNodeId, setInfoText);
    }
  }, [members, compDetails, cmtProfiles, unitLevelConnections, hoveredNodeId, viewMode]);

  // Canvas mouse move handler for hover detection
  const handleCanvasMouseMove = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
    const my = (e.clientY - rect.top) * (canvas.height / rect.height);

    // Detect hover (simplified: check distance from canvas center and ring)
    // For a more accurate implementation, we'd need to recalculate node positions
    // and check point-in-circle collision
  };

  const handleCanvasMouseLeave = () => {
    setHoveredNodeId(null);
    setInfoText("hover a node to explore relationships");
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#fff' }}>
      {/* Header */}
      <div style={{
        padding: '12px 16px',
        borderBottom: '0.5px solid var(--color-border-tertiary)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        background: 'var(--color-background-secondary)'
      }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
            S88 {viewMode === 'spirograph' ? 'Spirograph' : 'Hierarchy'} View
          </h2>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2 }}>
            {unitTypeName} — EPH → EM → CM relationships across all members
          </div>
        </div>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <div style={{
            display: 'flex',
            gap: '6px',
            background: 'rgba(0, 0, 0, 0.05)',
            padding: '4px 8px',
            borderRadius: '6px'
          }}>
            {['spirograph', 'hierarchy'].map(mode => (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                style={{
                  background: viewMode === mode ? 'white' : 'transparent',
                  border: 'none',
                  padding: '4px 10px',
                  borderRadius: '4px',
                  fontSize: '12px',
                  fontWeight: 500,
                  cursor: 'pointer',
                  color: 'var(--color-text-primary)',
                  boxShadow: viewMode === mode ? '0 1px 2px rgba(0,0,0,.05)' : 'none',
                  textTransform: 'capitalize'
                }}
              >
                {mode}
              </button>
            ))}
          </div>
          {onClose && (
            <button
              onClick={onClose}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                fontSize: 18,
                color: 'var(--color-text-secondary)',
                padding: '4px 8px',
              }}
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Canvas area */}
      <div style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        position: 'relative',
        background: 'linear-gradient(135deg,#e8e4ff 0%,#f0f4ff 30%,#e4f5ee 60%,#fff5f0 100%)',
        padding: '20px'
      }}>
        {members.length === 0 || !Object.keys(compDetails).some(id => compDetails[id]?.members?.length) ? (
          <div style={{ textAlign: 'center', color: 'var(--color-text-secondary)' }}>
            <div style={{ fontSize: 32, marginBottom: 12, opacity: 0.5 }}>↬</div>
            <p style={{ fontSize: 13, margin: 0 }}>No members with composite data.</p>
            <p style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 4 }}>
              Add composite CM types as members to see their structure.
            </p>
          </div>
        ) : viewMode === 'spirograph' ? (
          <>
            <canvas
              ref={canvasRef}
              onMouseMove={handleCanvasMouseMove}
              onMouseLeave={handleCanvasMouseLeave}
              style={{
                width: '100%',
                height: '100%',
                cursor: 'default',
              }}
            />
            {/* Info badge */}
            <div style={{
              position: 'absolute',
              bottom: '20px',
              left: '50%',
              transform: 'translateX(-50%)',
              fontSize: '12px',
              color: 'var(--color-text-secondary)',
              background: 'rgba(255,255,255,.85)',
              backdropFilter: 'blur(12px)',
              border: '1px solid rgba(255,255,255,.9)',
              padding: '8px 16px',
              borderRadius: '20px',
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
              boxShadow: '0 2px 12px rgba(80,60,180,.08)',
            }}>
              {infoText}
            </div>
            {/* Legend */}
            <div style={{
              position: 'absolute',
              top: '20px',
              right: '20px',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
              background: 'rgba(255,255,255,.85)',
              backdropFilter: 'blur(12px)',
              border: '1px solid rgba(255,255,255,.9)',
              borderRadius: '10px',
              padding: '10px 12px',
              boxShadow: '0 2px 12px rgba(80,60,180,.08)',
            }}>
              {[
                { color: '#5B4FD6', label: 'EPH – equipment phase' },
                { color: '#0A8F6A', label: 'EM – equipment module' },
                { color: '#C04B1A', label: 'CM – control module' },
                { color: '#E91E63', label: 'Unit connection' },
              ].map((item, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--color-text-secondary)', fontWeight: 500 }}>
                  {i < 3 ? (
                    <div style={{ width: '9px', height: '9px', borderRadius: '2px', background: item.color }} />
                  ) : (
                    <div style={{ width: '9px', height: '2px', background: item.color }} />
                  )}
                  {item.label}
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <HierarchyDiagram
              nodes={buildHierarchyGraph().nodes}
              edges={buildHierarchyGraph().edges}
              levelStyles={{
                top:    { label: 'EQUIPMENT PHASE', color: '#5B4FD6', colorLight: '#7B70EF', fill: 'rgba(91,79,214,0.12)', shape: 'square',  radiusScale: 1.2 },
                mid:    { label: 'EQUIPMENT MODULE',       color: '#0A8F6A', colorLight: '#12B887', fill: 'rgba(10,143,106,0.12)', shape: 'circle',  radiusScale: 1 },
                bottom: { label: 'CONTROL MODULE',     color: '#C04B1A', colorLight: '#E06030', fill: 'rgba(192,75,26,0.12)', shape: 'diamond', radiusScale: 0.8 },
              }}
              emptyMessage="No hierarchy data to display."
            />
            {/* Legend */}
            <div style={{
              position: 'absolute',
              top: '20px',
              right: '20px',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
              background: 'rgba(255,255,255,.85)',
              backdropFilter: 'blur(12px)',
              border: '1px solid rgba(255,255,255,.9)',
              borderRadius: '10px',
              padding: '10px 12px',
              boxShadow: '0 2px 12px rgba(80,60,180,.08)',
            }}>
              {[
                { color: '#5B4FD6', label: 'EPH – equipment phase', shape: 'square' },
                { color: '#0A8F6A', label: 'EM – equipment module', shape: 'circle' },
                { color: '#C04B1A', label: 'CM – control module', shape: 'diamond' },
              ].map((item, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--color-text-secondary)', fontWeight: 500 }}>
                  {item.shape === 'square' && <div style={{ width: '9px', height: '9px', background: item.color, borderRadius: '2px' }} />}
                  {item.shape === 'circle' && <div style={{ width: '9px', height: '9px', background: item.color, borderRadius: '50%' }} />}
                  {item.shape === 'diamond' && <div style={{ width: '9px', height: '9px', background: item.color, transform: 'rotate(45deg)' }} />}
                  {item.label}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Draw the spirograph canvas with nodes arranged in a circle.
 * Unit-level connections are highlighted in a distinct color (magenta/pink).
 */
function drawSpirograph(canvas, nodes, edges, unitConnEdges, hoveredNodeId, setHoveredNodeId, setInfoText) {
  if (!canvas || !canvas.parentElement) return;

  // Full-bleed: canvas fills its parent rectangle exactly (no card, no cap).
  // Force recalculation by using getComputedStyle if needed
  const W = canvas.parentElement.clientWidth || 800;
  const H = canvas.parentElement.clientHeight || 800;

  if (W === 0 || H === 0) {
    // Container not yet sized, try again soon
    requestAnimationFrame(() => drawSpirograph(canvas, nodes, edges, unitConnEdges, hoveredNodeId, setHoveredNodeId, setInfoText));
    return;
  }
  canvas.width = W;
  canvas.height = H;
  const sz = Math.min(W, H); // reference scale for radii/fonts, so layout stays proportional

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Polyfill for roundRect if not supported
  if (!ctx.roundRect) {
    ctx.roundRect = function(x, y, w, h, r) {
      if (w < 2 * r) r = w / 2;
      if (h < 2 * r) r = h / 2;
      this.beginPath();
      this.moveTo(x+r, y);
      this.arcTo(x+w, y, x+w, y+h, r);
      this.arcTo(x+w, y+h, x, y+h, r);
      this.arcTo(x, y+h, x, y, r);
      this.arcTo(x, y, x+w, y, r);
      this.closePath();
      return this;
    };
  }

  const R = sz * 0.37;  // radius to node ring
  const NR = sz * 0.026; // node size
  const cx = W / 2;
  const cy = H / 2;

  // Color scheme matching the original
  const col = {
    EPH: ['#5B4FD6', '#7B70EF', 'rgba(91,79,214,.12)'],
    EM:  ['#0A8F6A', '#12B887', 'rgba(10,143,106,.12)'],
    CM:  ['#C04B1A', '#E06030', 'rgba(192,75,26,.12)'],
  };

  // Layout nodes around the circle
  const N = nodes.length;
  const gap = N > 24 ? 0.007 : 0.015;
  const slice = (2 * Math.PI - gap * N) / N;
  let angle = -Math.PI / 2;
  nodes.forEach(n => {
    n.angle = angle + slice / 2;
    n.x = cx + R * Math.cos(n.angle);
    n.y = cy + R * Math.sin(n.angle);
    angle += slice + gap;
  });

  const byId = id => nodes.find(n => n.id === id);

  function drawAll() {
    ctx.clearRect(0, 0, W, H);

    // Circle ring (guide)
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(180,170,240,.18)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 7]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw regular role-assignment edges
    edges.forEach(e => {
      const na = byId(e.a);
      const nb = byId(e.b);
      if (!na || !nb) return;

      const c1x = cx + (na.x - cx) * 0.22;
      const c1y = cy + (na.y - cy) * 0.22;
      const c2x = cx + (nb.x - cx) * 0.22;
      const c2y = cy + (nb.y - cy) * 0.22;

      const hl = hoveredNodeId && (e.a === hoveredNodeId || e.b === hoveredNodeId);

      ctx.beginPath();
      ctx.moveTo(na.x, na.y);
      ctx.bezierCurveTo(c1x, c1y, c2x, c2y, nb.x, nb.y);
      ctx.strokeStyle = hl ? col[na.type][0] : col[na.type][0] + '22';
      ctx.lineWidth = hl ? 2 : 0.8;
      ctx.stroke();
    });

    // Draw unit-level connection edges in distinct magenta color (curved, dashed)
    unitConnEdges.forEach(e => {
      const na = byId(e.from);
      const nb = byId(e.to);
      if (!na || !nb) return;

      // Use same curved path as role assignments
      const c1x = cx + (na.x - cx) * 0.22;
      const c1y = cy + (na.y - cy) * 0.22;
      const c2x = cx + (nb.x - cx) * 0.22;
      const c2y = cy + (nb.y - cy) * 0.22;

      const unitConnColor = '#E91E63'; // Magenta for unit connections
      const hl = hoveredNodeId && (e.from === hoveredNodeId || e.to === hoveredNodeId);

      // Draw curved dashed line for unit connections
      ctx.beginPath();
      ctx.moveTo(na.x, na.y);
      ctx.bezierCurveTo(c1x, c1y, c2x, c2y, nb.x, nb.y);
      ctx.strokeStyle = hl ? unitConnColor : unitConnColor + '44';
      ctx.lineWidth = hl ? 2.5 : 1.2;
      ctx.setLineDash([5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    });

    // Draw nodes (members only)
    nodes.forEach(n => {
      let connectedIds = [];
      if (hoveredNodeId) {
        connectedIds = edges
          .filter(e => e.a === hoveredNodeId || e.b === hoveredNodeId)
          .map(e => e.a === hoveredNodeId ? e.b : e.a);
        // Also include unit-level connections
        const unitConns = unitConnEdges.filter(e => e.from === n.id || e.to === n.id);
        if (unitConns.length > 0 && hoveredNodeId === n.id) {
          const unitConnectedIds = unitConns.map(e => e.from === n.id ? e.to : e.from);
          connectedIds = [...connectedIds, ...unitConnectedIds];
        }
      }
      const hl = hoveredNodeId && (n.id === hoveredNodeId || connectedIds.includes(n.id));

      const [c, s, bg] = col[n.type];
      const r = n.type === 'EPH' ? NR * 1.18 : n.type === 'EM' ? NR : NR * 0.8;

      if (hl) {
        ctx.save();
        ctx.shadowColor = c;
        ctx.shadowBlur = 14;
      }

      ctx.fillStyle = hl ? c : bg;
      ctx.strokeStyle = hl ? s : c + '88';
      ctx.lineWidth = hl ? 2 : 1;
      ctx.beginPath();

      if (n.type === 'EPH') {
        ctx.roundRect(n.x - r, n.y - r, r * 2, r * 2, 4);
      } else if (n.type === 'EM') {
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      } else {
        // CM: diamond
        ctx.moveTo(n.x, n.y - r);
        ctx.lineTo(n.x + r, n.y);
        ctx.lineTo(n.x, n.y + r);
        ctx.lineTo(n.x - r, n.y);
        ctx.closePath();
      }

      ctx.fill();
      ctx.stroke();
      if (hl) ctx.restore();

      // Label — offset far enough past the node's own radius that rotated
      // text never overlaps the shape, even for long aliases.
      // Labels always stay horizontal (no rotation) — offset sideways from
      // the node based on which half of the circle it's on, so text reads
      // outward without ever tilting or overlapping the node's own shape.
      const fontSize = sz * 0.0165;
      ctx.font = `${hl ? 600 : 400} ${fontSize}px Outfit,sans-serif`;
      const margin = fontSize * 0.5;
      const cosA = Math.cos(n.angle);
      const sinA = Math.sin(n.angle);
      const onRight = cosA >= 0;

      // Push out along the node's angle to clear it vertically, then offset
      // horizontally to the side the node sits on.
      const lr = R + r + fontSize * 0.9;
      const lx = cx + lr * cosA + (onRight ? margin : -margin);
      const ly = cy + lr * sinA;

      ctx.fillStyle = hl ? s : '#9090b8';
      ctx.font = `${hl ? 600 : 400} ${fontSize}px Outfit,sans-serif`;
      ctx.textAlign = onRight ? 'left' : 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(n.label, lx, ly);
    });
  }

  // Mouse move handler
  canvas.onmousemove = e => {
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (W / rect.width);
    const my = (e.clientY - rect.top) * (H / rect.height);

    let found = null;
    let minDist = Infinity;

    // Check hover on member nodes
    nodes.forEach(n => {
      const d = Math.hypot(n.x - mx, n.y - my);
      if (d < NR * 2.3 && d < minDist) {
        minDist = d;
        found = n.id;
      }
    });

    if (found !== hoveredNodeId) {
      setHoveredNodeId(found);
      if (found) {
        const n = byId(found);
        if (n) {
          // Role assignment connections
          const roleConnNames = edges
            .filter(e => e.a === found || e.b === found)
            .map(e => byId(e.a === found ? e.b : e.a))
            .filter(Boolean)
            .map(n => n.label);
          // Unit-level connections (shown differently in info)
          const unitConnNames = unitConnEdges
            .filter(e => e.from === found || e.to === found)
            .map(e => {
              const other = byId(e.from === found ? e.to : e.from);
              return other ? `${other.label}(unit-level)` : '';
            })
            .filter(Boolean);
          const allConns = [...roleConnNames, ...unitConnNames];
          setInfoText(
            `${n.label} (${n.type}) → ${
              allConns.join(', ') || 'no connections'
            }`
          );
        }
      } else {
        setInfoText('hover a node to explore relationships');
      }
    }
  };

  canvas.onmouseleave = () => {
    setHoveredNodeId(null);
    setInfoText('hover a node to explore relationships');
  };

  // Draw
  drawAll();
}
