import React, { useEffect, useRef, useState } from 'react';

export const HierarchyDiagram = ({
  nodes = [],
  edges = [],
  levelStyles = {},
  emptyMessage = 'No data to visualize.'
}) => {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const [hoveredNode, setHoveredNode] = useState(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const handleResize = () => {
      if (containerRef.current) {
        const { clientWidth, clientHeight } = containerRef.current;
        setDimensions({ width: clientWidth, height: clientHeight });
      }
    };
    handleResize();
    const observer = new ResizeObserver(handleResize);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const positioned = nodes.map(n => ({ ...n }));
  const byId = (id) => positioned.find(n => n.id === id);

  useEffect(() => {
    if (!canvasRef.current || dimensions.width === 0 || positioned.length === 0) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const sz = Math.min(dimensions.width, dimensions.height);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = dimensions.width * dpr;
    canvas.height = dimensions.height * dpr;
    ctx.scale(dpr, dpr);

    const NR = Math.max(sz * 0.015, 6);
    const rowY = {
      top: dimensions.height * 0.24,
      mid: dimensions.height * 0.48,
      bottom: dimensions.height * 0.72
    };

    const marginX = Math.max(dimensions.width * 0.08, 40);
    const rowWidth = dimensions.width - marginX * 2;

    (['top', 'mid', 'bottom']).forEach(level => {
      const rowNodes = positioned.filter(n => n.level === level);
      const k = rowNodes.length;
      rowNodes.forEach((n, i) => {
        n.x = k === 1 ? dimensions.width / 2 : marginX + (i + 0.5) * (rowWidth / k);
        n.y = rowY[level];
      });
    });

    const draw = () => {
      ctx.clearRect(0, 0, dimensions.width, dimensions.height);

      // Row guides + labels
      (['top', 'mid', 'bottom']).forEach(level => {
        const y = rowY[level];
        ctx.beginPath();
        ctx.moveTo(dimensions.width * 0.04, y);
        ctx.lineTo(dimensions.width * 0.96, y);
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.15)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 7]);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = 'rgba(148, 163, 184, 0.45)';
        ctx.font = `700 ${Math.max(sz * 0.014, 8)}px Outfit,sans-serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const style = levelStyles[level];
        ctx.fillText(style?.label || level.toUpperCase(), dimensions.width * 0.02, y);
      });

      // Edges
      edges.forEach(e => {
        const na = byId(e.a);
        const nb = byId(e.b);
        if (!na || !nb || na.x === undefined || nb.x === undefined || nb.y === undefined || na.y === undefined) return;

        let isHov = hoveredNode && (e.a === hoveredNode || e.b === hoveredNode);
        const isDottedLine = e.isUnitConnection;

        // For EPH nodes, also highlight edges to connected EM/CM (only from role assignments, not unit connections)
        const hoveredNodeData = hoveredNode ? byId(hoveredNode) : null;
        if (hoveredNodeData && hoveredNodeData.level === 'top' && !isDottedLine) {
          // Highlight edges from EPH to EM, and from EM to CM
          if ((e.a === hoveredNode && (nb.level === 'mid' || nb.level === 'bottom')) ||
              (e.b === hoveredNode && (na.level === 'mid' || na.level === 'bottom'))) {
            isHov = true;
          }
          // Also highlight EM→CM edges if their EM is connected to the EPH
          if (na.level === 'mid' && nb.level === 'bottom') {
            const emConnectedToEph = edges.some(edge => !edge.isUnitConnection && ((edge.a === hoveredNode && edge.b === e.a) || (edge.b === hoveredNode && edge.a === e.a)));
            if (emConnectedToEph) isHov = true;
          }
          if (na.level === 'bottom' && nb.level === 'mid') {
            const emConnectedToEph = edges.some(edge => !edge.isUnitConnection && ((edge.a === hoveredNode && edge.b === e.b) || (edge.b === hoveredNode && edge.a === e.b)));
            if (emConnectedToEph) isHov = true;
          }
        }

        const midY = (na.y + nb.y) / 2;

        // Draw sharp orthogonal path (right angles)
        ctx.beginPath();
        ctx.moveTo(na.x, na.y);
        ctx.lineTo(na.x, midY);
        ctx.lineTo(nb.x, midY);
        ctx.lineTo(nb.x, nb.y);

        const style = levelStyles[na.level];
        ctx.strokeStyle = isHov ? style.color : `${style.color}22`;
        ctx.lineWidth = isHov ? 2 : 1;

        if (isDottedLine) {
          ctx.setLineDash([4, 4]);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      });

      // Nodes
      positioned.forEach(n => {
        if (n.x === undefined || n.y === undefined) return;

        let connected = hoveredNode
          ? edges.filter(e => e.a === hoveredNode || e.b === hoveredNode).map(e => (e.a === hoveredNode ? e.b : e.a))
          : [];

        // For EPH nodes, expand to include second-level connections (EM and CM)
        const hoveredNodeData = hoveredNode ? byId(hoveredNode) : null;
        if (hoveredNodeData && hoveredNodeData.level === 'top') {
          const expandedSet = new Set(connected);
          connected.forEach(nodeId => {
            edges.filter(e => e.a === nodeId || e.b === nodeId).forEach(e => {
              const other = e.a === nodeId ? e.b : e.a;
              expandedSet.add(other);
            });
          });
          connected = Array.from(expandedSet);
        }

        const isHov = hoveredNode === n.id || (hoveredNode !== null && connected.includes(n.id));

        const style = levelStyles[n.level];
        const r = NR * (style.radiusScale ?? 1);

        if (isHov) {
          ctx.save();
          ctx.shadowColor = style.color;
          ctx.shadowBlur = 15;
        }

        ctx.fillStyle = isHov ? style.color : style.fill;
        ctx.strokeStyle = isHov ? style.colorLight : `${style.color}66`;
        ctx.lineWidth = isHov ? 2 : 1;

        ctx.beginPath();
        if (style.shape === 'square') {
          ctx.rect(n.x - r, n.y - r, r * 2, r * 2);
        } else if (style.shape === 'circle') {
          ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        } else {
          // diamond
          ctx.moveTo(n.x, n.y - r);
          ctx.lineTo(n.x + r, n.y);
          ctx.lineTo(n.x, n.y + r);
          ctx.lineTo(n.x - r, n.y);
          ctx.closePath();
        }
        ctx.fill();
        ctx.stroke();
        if (isHov) ctx.restore();

        ctx.fillStyle = isHov ? style.colorLight : '#64748b';
        ctx.font = `${isHov ? '700' : '500'} ${Math.max(sz * 0.016, 9)}px Outfit,sans-serif`;

        if (n.level === 'mid') {
          // Position EM labels to the left with background box for readability
          const textWidth = ctx.measureText(n.label).width;
          const textHeight = Math.max(sz * 0.016, 9);
          const padding = 4;
          const boxX = n.x - (r + 12) - textWidth - padding;
          const boxY = n.y - textHeight / 2 - padding;
          const boxWidth = textWidth + padding * 2;
          const boxHeight = textHeight + padding * 2;

          // Draw background box
          ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
          ctx.fillRect(boxX, boxY, boxWidth, boxHeight);

          // Draw text
          ctx.fillStyle = isHov ? style.colorLight : '#64748b';
          ctx.textAlign = 'right';
          ctx.textBaseline = 'middle';
          ctx.fillText(n.label, n.x - (r + 12), n.y);
        } else {
          // Position EPH above and CM below with background box
          const dy = n.level === 'top' ? -(r + 12) : r + 12;
          const textWidth = ctx.measureText(n.label).width;
          const textHeight = Math.max(sz * 0.016, 9);
          const padding = 4;
          const boxX = n.x - textWidth / 2 - padding;
          const boxY = n.level === 'top' ? n.y + dy - textHeight - padding : n.y + dy - padding;
          const boxWidth = textWidth + padding * 2;
          const boxHeight = textHeight + padding * 2;

          // Draw background box
          ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
          ctx.fillRect(boxX, boxY, boxWidth, boxHeight);

          // Draw text
          ctx.fillStyle = isHov ? style.colorLight : '#64748b';
          ctx.textAlign = 'center';
          ctx.textBaseline = n.level === 'top' ? 'bottom' : 'top';
          ctx.fillText(n.label, n.x, n.y + dy);
        }
      });
    };

    draw();

    const onMouseMove = (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left) * (dimensions.width / rect.width);
      const my = (e.clientY - rect.top) * (dimensions.height / rect.height);

      let found = null;
      let minD = Infinity;
      positioned.forEach(n => {
        if (n.x === undefined || n.y === undefined) return;
        const d = Math.hypot(n.x - mx, n.y - my);
        if (d < NR * 2 && d < minD) {
          minD = d;
          found = n.id;
        }
      });
      if (found !== hoveredNode) setHoveredNode(found);
    };

    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseleave', () => setHoveredNode(null));
    return () => {
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mouseleave', () => setHoveredNode(null));
    };
  }, [nodes, edges, hoveredNode, dimensions, levelStyles]);

  if (nodes.length === 0) {
    return (
      <div style={{ width: '100%', height: '24rem', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-secondary)' }}>
        {emptyMessage}
      </div>
    );
  }

  return (
    <div ref={containerRef} style={{ width: '100%', aspectRatio: '16/9', position: 'relative' }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', cursor: 'crosshair', display: 'block' }} />
      {hoveredNode && (
        <div style={{
          position: 'absolute',
          bottom: '32px',
          left: '50%',
          transform: 'translateX(-50%)',
          paddingLeft: '24px',
          paddingRight: '24px',
          paddingTop: '8px',
          paddingBottom: '8px',
          background: '#1e293b',
          color: 'white',
          borderRadius: '9999px',
          fontSize: '12px',
          fontWeight: 'bold',
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1)',
        }}>
          {byId(hoveredNode)?.label}
        </div>
      )}
    </div>
  );
};
