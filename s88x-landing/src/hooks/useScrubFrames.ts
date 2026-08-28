import { useEffect, useRef, useState } from 'react';

/**
 * Decodes every frame of a short video into ImageBitmaps once, then exposes a
 * canvas whose frame follows horizontal mouse movement.
 *
 * Why not just seek the <video>? This clip has a single keyframe across 97
 * frames, so every backward seek makes the decoder replay from frame 0. Seeking
 * can never be smooth on such a file. Pre-decoding turns each scrub step into a
 * drawImage call, which is effectively free.
 */
export function useScrubFrames(src: string, frameCount: number, sensitivity = 0.8) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);

  const framesRef = useRef<ImageBitmap[]>([]);
  const targetRef = useRef(0); // desired frame index (float)
  const currentRef = useRef(0); // eased frame index (float)
  const drawnRef = useRef(-1); // last index actually painted
  const prevXRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  // --- decode pass: run once per src ---
  useEffect(() => {
    let cancelled = false;
    const video = document.createElement('video');
    video.src = src;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';

    const seekTo = (time: number) =>
      new Promise<void>((resolve) => {
        const onSeeked = () => {
          video.removeEventListener('seeked', onSeeked);
          resolve();
        };
        video.addEventListener('seeked', onSeeked);
        video.currentTime = time;
      });

    const decodeAll = async () => {
      await new Promise<void>((resolve, reject) => {
        if (video.readyState >= 1) return resolve();
        video.addEventListener('loadedmetadata', () => resolve(), { once: true });
        video.addEventListener('error', () => reject(new Error('video load failed')), {
          once: true,
        });
      });

      const { duration, videoWidth, videoHeight } = video;
      if (!duration || Number.isNaN(duration)) throw new Error('no duration');

      const bitmaps: ImageBitmap[] = [];
      // Decoding sequentially forward is the fast path: each seek advances past
      // at most one frame, so the decoder never rewinds to the keyframe.
      for (let i = 0; i < frameCount; i++) {
        if (cancelled) return;
        await seekTo((i / frameCount) * duration);
        bitmaps.push(await createImageBitmap(video, 0, 0, videoWidth, videoHeight));
      }

      if (cancelled) {
        bitmaps.forEach((b) => b.close());
        return;
      }
      framesRef.current = bitmaps;
      setReady(true);
    };

    decodeAll().catch(() => {
      // Leave ready=false; the caller falls back to a plain <video>.
    });

    return () => {
      cancelled = true;
      video.src = '';
      framesRef.current.forEach((b) => b.close());
      framesRef.current = [];
    };
  }, [src, frameCount]);

  // --- scrub loop: mouse + rAF, all via refs so nothing re-renders ---
  useEffect(() => {
    if (!ready) return;

    const EASING = 0.18;

    const handleMouseMove = (e: MouseEvent) => {
      if (prevXRef.current === null) {
        prevXRef.current = e.clientX;
        return;
      }
      const delta = e.clientX - prevXRef.current;
      prevXRef.current = e.clientX;

      const offset = (delta / window.innerWidth) * sensitivity * frameCount;
      targetRef.current = Math.max(
        0,
        Math.min(targetRef.current + offset, frameCount - 1)
      );
    };

    const paint = (index: number) => {
      const canvas = canvasRef.current;
      const bitmap = framesRef.current[index];
      if (!canvas || !bitmap) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // Cover-fit the bitmap, biased to 70% horizontally to match the design.
      const { width: cw, height: ch } = canvas;
      const scale = Math.max(cw / bitmap.width, ch / bitmap.height);
      const w = bitmap.width * scale;
      const h = bitmap.height * scale;
      ctx.drawImage(bitmap, (cw - w) * 0.7, (ch - h) / 2, w, h);
    };

    const resize = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      drawnRef.current = -1; // force a repaint at the new size
    };

    const tick = () => {
      rafRef.current = requestAnimationFrame(tick);

      currentRef.current += (targetRef.current - currentRef.current) * EASING;
      const index = Math.round(currentRef.current);
      if (index === drawnRef.current) return; // nothing changed this frame
      drawnRef.current = index;
      paint(index);
    };

    resize();
    paint(0);
    window.addEventListener('resize', resize);
    window.addEventListener('mousemove', handleMouseMove, { passive: true });
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', handleMouseMove);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [ready, frameCount, sensitivity]);

  return { canvasRef, ready };
}
