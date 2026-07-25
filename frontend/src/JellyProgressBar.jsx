import React, { useEffect, useRef } from 'react';
import './JellyProgressBar.css';

/**
 * Animated canvas-based jelly slider progress bar.
 * Creates a smooth, liquid-like progress animation.
 *
 * progress: { pct: number (0-100), phase?: string, msg?: string }
 */
export default function JellyProgressBar({ progress }) {
  if (!progress) return null;

  const canvasRef = useRef(null);
  const animationRef = useRef(null);
  const timeRef = useRef(0);

  const pct = Math.max(0, Math.min(100, Math.round(progress.pct ?? 0)));
  const label = progress.msg || progress.phase || 'Generating…';

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.offsetWidth;
    const height = canvas.offsetHeight;
    const dpr = window.devicePixelRatio || 1;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    const trackHeight = 32;
    const trackY = (height - trackHeight) / 2;
    const trackRadius = trackHeight / 2;

    // Animation loop
    const animate = () => {
      timeRef.current += 0.016; // ~60fps

      // Clear canvas
      ctx.fillStyle = 'transparent';
      ctx.clearRect(0, 0, width, height);

      // Draw background track
      ctx.fillStyle = '#f3f4f6';
      ctx.beginPath();
      ctx.roundRect(0, trackY, width, trackHeight, trackRadius);
      ctx.fill();

      // Draw progress fill with jelly effect
      const fillWidth = (pct / 100) * width;

      if (fillWidth > 0) {
        // Create gradient
        const gradient = ctx.createLinearGradient(0, trackY, 0, trackY + trackHeight);
        gradient.addColorStop(0, '#1e5a96');
        gradient.addColorStop(0.5, '#0C447C');
        gradient.addColorStop(1, '#2f79c4');

        ctx.fillStyle = gradient;

        // Draw jelly blob with wavy edges
        const waveAmplitude = 4;
        const waveFrequency = 6;
        const wobbleOffset = Math.sin(timeRef.current * 3) * 2;

        ctx.beginPath();
        ctx.moveTo(trackRadius, trackY);

        // Top edge with wave
        for (let x = trackRadius; x < fillWidth - trackRadius; x += 2) {
          const waveY = Math.sin((x / fillWidth) * waveFrequency) * waveAmplitude + wobbleOffset;
          ctx.lineTo(x, trackY + waveY);
        }

        // Right side (jelly blob)
        ctx.arcTo(fillWidth, trackY, fillWidth, trackY + trackHeight / 2, trackRadius);
        ctx.arcTo(fillWidth, trackY + trackHeight, fillWidth - trackRadius, trackY + trackHeight, trackRadius);

        // Bottom edge with wave
        for (let x = fillWidth - trackRadius; x > trackRadius; x -= 2) {
          const waveY = Math.sin((x / fillWidth) * waveFrequency) * waveAmplitude - wobbleOffset;
          ctx.lineTo(x, trackY + trackHeight + waveY);
        }

        // Left side
        ctx.arcTo(0, trackY + trackHeight, 0, trackY + trackHeight / 2, trackRadius);
        ctx.arcTo(0, trackY, trackRadius, trackY, trackRadius);

        ctx.fill();

        // Add shine/highlight
        ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.beginPath();
        const shineX = fillWidth * 0.3;
        const shineY = trackY + 6;
        ctx.arc(shineX, shineY, 6, 0, Math.PI * 2);
        ctx.fill();
      }

      animationRef.current = requestAnimationFrame(animate);
    };

    animationRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [pct]);

  return (
    <div className="jelly-container">
      <div className="jelly-wrapper">
        <div className="jelly-slider-wrapper">
          <canvas ref={canvasRef} className="jelly-canvas" />
          <div className="jelly-percent">{pct}%</div>
        </div>
        <div className="jelly-label">{label}</div>
      </div>
    </div>
  );
}
