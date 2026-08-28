import { useState, useEffect, useRef } from 'react';
import { useTypewriter } from './hooks/useTypewriter';
import { useScrubFrames } from './hooks/useScrubFrames';
import './App.css';

// Destination for the "Open the app" button. Set VITE_APP_URL to the deployed
// PCS7 app URL in production; falls back to the dev server port.
const APP_URL = import.meta.env.VITE_APP_URL ?? 'http://localhost:5173/';

// Destination for the "AS Load Calc" button. Set VITE_CALC_URL to the
// deployed AS Load Calc URL in production; falls back to the dev server port.
const CALC_URL = import.meta.env.VITE_CALC_URL ?? 'http://localhost:3000/';

const VIDEO_SRC =
  'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260530_042513_df96a13b-6155-4f6e-8b93-c9dee66fba08.mp4';
const FRAME_COUNT = 97; // read from the file's stsz atom

function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { canvasRef, ready: framesReady } = useScrubFrames(VIDEO_SRC, FRAME_COUNT);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [showButtons, setShowButtons] = useState(false);
  const [copied, setCopied] = useState(false);

  // Scrub state lives in refs, not React state: this updates every frame and
  // must never trigger a re-render.
  const prevXRef = useRef<number | null>(null);
  const targetTimeRef = useRef(0);
  const currentTimeRef = useRef(0);
  const seekingRef = useRef(false);
  const rafRef = useRef<number | null>(null);

  const { displayed, done } = useTypewriter(
    'Glad you stopped in. Now, what are we building?',
    38,
    600
  );

  useEffect(() => {
    const timer = setTimeout(() => setShowButtons(true), 400);
    return () => clearTimeout(timer);
  }, []);

  // Fallback scrub path: drives the <video> by seeking. Used only until the
  // pre-decoded canvas is ready (or forever, if decoding failed).
  useEffect(() => {
    if (framesReady) return;

    const SENSITIVITY = 0.8;
    const EASING = 0.12; // fraction of remaining distance covered per frame

    const handleMouseMove = (e: MouseEvent) => {
      const video = videoRef.current;
      if (!video || !video.duration || Number.isNaN(video.duration)) return;

      // First move only establishes the origin, so there's no jump from x=0.
      if (prevXRef.current === null) {
        prevXRef.current = e.clientX;
        return;
      }

      const delta = e.clientX - prevXRef.current;
      prevXRef.current = e.clientX;

      const offset = (delta / window.innerWidth) * SENSITIVITY * video.duration;
      targetTimeRef.current = Math.max(
        0,
        Math.min(targetTimeRef.current + offset, video.duration)
      );
    };

    // Advance the eased position one step and seek there. Only ever one seek is
    // in flight; the decoder sets its own pace via the 'seeked' event.
    const step = () => {
      const video = videoRef.current;
      if (!video || !video.duration || Number.isNaN(video.duration)) return false;

      const diff = targetTimeRef.current - currentTimeRef.current;
      if (Math.abs(diff) < 0.004) return false; // settled

      currentTimeRef.current += diff * EASING;
      seekingRef.current = true;
      video.currentTime = currentTimeRef.current;
      return true;
    };

    // Per the spec: when a seek completes, immediately queue the next one if
    // targetTime has moved. This chains seeks at the decoder's own rate rather
    // than flooding it at 60Hz.
    const handleSeeked = () => {
      seekingRef.current = false;
      step();
    };

    // rAF only restarts the chain when it has gone idle — it does not drive
    // seeking itself, so a slow decoder can never accumulate a backlog.
    const tick = () => {
      rafRef.current = requestAnimationFrame(tick);
      if (!seekingRef.current) step();
    };

    const video = videoRef.current;
    video?.addEventListener('seeked', handleSeeked);
    window.addEventListener('mousemove', handleMouseMove, { passive: true });
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      video?.removeEventListener('seeked', handleSeeked);
      window.removeEventListener('mousemove', handleMouseMove);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [framesReady]);

  const handleCopyEmail = () => {
    navigator.clipboard.writeText('hello@mainframe.co');
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const CopyIcon = () => (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="2" y="2" width="6" height="6" stroke="currentColor" strokeWidth="1" fill="none" />
      <rect x="4" y="4" width="6" height="6" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  );

  const ArrowIcon = () => (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M2 6h8M6.5 2.5 10 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );

  return (
    <>
      {/* Fallback: shown until the pre-decoded frames are ready. */}
      <video
        ref={videoRef}
        className="fixed inset-0 w-full h-full object-cover object-[70%_center] -z-10"
        src={VIDEO_SRC}
        muted
        playsInline
        preload="auto"
        style={{ visibility: framesReady ? 'hidden' : 'visible' }}
      />

      {/* Pre-decoded frame canvas — the smooth scrub path. */}
      <canvas
        ref={canvasRef}
        className="fixed inset-0 w-full h-full -z-10"
        style={{ display: framesReady ? 'block' : 'none' }}
      />

      <nav className="fixed top-0 left-0 right-0 px-5 sm:px-8 py-4 sm:py-5 flex justify-between items-center z-10">
        {/* Logo */}
        <div className="flex gap-3 items-center">
          <div
            className="text-[21px] sm:text-[26px] tracking-tight text-black select-none"
            style={{ fontFamily: 'var(--font-heading)' }}
          >
            S88x®
          </div>
          <div className="text-[25px] sm:text-[30px] text-black select-none" style={{ letterSpacing: '-0.02em' }}>
            ✳︎
          </div>
        </div>

        {/* Desktop Nav */}
        {/*
        <div className="hidden md:flex gap-1 text-[23px] text-black">
          <a href="#" className="hover:opacity-60 transition-opacity">
            Labs
          </a>
          <span>, </span>
          <a href="#" className="hover:opacity-60 transition-opacity">
            Studio
          </a>
          <span>, </span>
          <a href="#" className="hover:opacity-60 transition-opacity">
            Openings
          </a>
          <span>, </span>
          <a href="#" className="hover:opacity-60 transition-opacity">
            Shop
          </a>
        </div>
        */}

        {/* Desktop CTA */}
        <a
          href="#"
          className="hidden md:block text-[23px] text-black underline underline-offset-2 hover:opacity-60 transition-opacity"
        >
          Get in touch
        </a>

        {/* Mobile Hamburger */}
        <button
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          className="md:hidden flex flex-col gap-[5px] relative w-6 h-6"
          aria-label="Toggle menu"
        >
          <div
            className="w-6 h-[2px] bg-black transition-all duration-300"
            style={{
              transform: mobileMenuOpen ? 'translateY(7px) rotate(45deg)' : 'none',
            }}
          />
          <div
            className="w-6 h-[2px] bg-black transition-opacity duration-300"
            style={{
              opacity: mobileMenuOpen ? 0 : 1,
            }}
          />
          <div
            className="w-6 h-[2px] bg-black transition-all duration-300"
            style={{
              transform: mobileMenuOpen ? 'translateY(-7px) rotate(-45deg)' : 'none',
            }}
          />
        </button>
      </nav>

      {/* Mobile Menu */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 bg-white/95 backdrop-blur-sm flex flex-col items-start justify-center px-8 gap-8 z-9 md:hidden"
          style={{
            pointerEvents: mobileMenuOpen ? 'auto' : 'none',
            opacity: mobileMenuOpen ? 1 : 0,
            transition: 'opacity 0.3s ease',
          }}
        >
          <a href="#" className="text-[32px] font-medium text-black hover:opacity-60 transition-opacity">
            Labs
          </a>
          <a href="#" className="text-[32px] font-medium text-black hover:opacity-60 transition-opacity">
            Studio
          </a>
          <a href="#" className="text-[32px] font-medium text-black hover:opacity-60 transition-opacity">
            Openings
          </a>
          <a href="#" className="text-[32px] font-medium text-black hover:opacity-60 transition-opacity">
            Shop
          </a>
          <a
            href="#"
            className="text-[32px] font-medium text-black underline underline-offset-2 hover:opacity-60 transition-opacity"
          >
            Get in touch
          </a>
        </div>
      )}

      {/* Hero Section */}
      <section
        className="h-screen flex flex-col md:justify-center justify-end pb-12 md:pb-0 px-5 sm:px-8 md:px-10 overflow-hidden relative z-1"
      >
        <div className="max-w-xl relative z-10">
          {/* Blurred Intro Label */}
          <div
            className="pointer-events-none select-none mb-5 sm:mb-6"
            style={{
              fontSize: 'clamp(18px, 4vw, 26px)',
              lineHeight: '1.3',
              fontWeight: 400,
              color: '#000',
              filter: 'blur(4px)',
              fontFamily: 'var(--font-body)',
            }}
          >
            <div>Hey there, meet S88x,</div>
            {/* <div>Mainframe's Adaptive Response Interface Agent</div> */}
          </div>

          {/* Typewriter Text */}
          <p
            className="mb-5 sm:mb-6 text-black"
            style={{
              fontSize: 'clamp(18px, 4vw, 26px)',
              lineHeight: '1.35',
              fontWeight: 400,
              minHeight: '54px',
              fontFamily: 'var(--font-body)',
            }}
          >
            {displayed}
            {!done && (
              <span
                className="inline-block w-[2px] h-[1.1em] bg-black align-middle ml-[2px]"
                style={{
                  animation: 'blink 1s step-end infinite',
                }}
              />
            )}
          </p>

          {/* Action Buttons */}
          <div
            className="flex flex-wrap gap-y-1"
            style={{
              opacity: showButtons ? 1 : 0,
              transform: showButtons ? 'translateY(0)' : 'translateY(8px)',
              transition: 'opacity 0.4s ease, transform 0.4s ease',
              pointerEvents: showButtons ? 'auto' : 'none',
            }}
          >
            {['Pitch us an idea', 'Come work here', 'Send a brief hello', 'See how we operate'].map(
              (label) => (
                <button
                  key={label}
                  className="inline-flex items-center justify-center bg-white text-black border border-black/10 rounded-full text-[13px] sm:text-[15px] px-4 sm:px-5 py-[0.3em] mx-[0.2em] mb-[0.4em] whitespace-nowrap hover:bg-black hover:text-white transition-colors duration-200"
                  style={{ fontFamily: 'var(--font-body)' }}
                >
                  {label}
                </button>
              )
            )}

            {/* Email Pill Button */}
            <button
              onClick={handleCopyEmail}
              className="inline-flex items-center justify-center gap-2 sm:gap-3 text-white border border-white rounded-full text-[13px] sm:text-[15px] px-4 sm:px-5 py-[0.3em] mx-[0.2em] mb-[0.4em] whitespace-nowrap hover:bg-white hover:text-black transition-colors duration-200"
              style={{ fontFamily: 'var(--font-body)' }}
            >
              <span>
                {copied ? (
                  'Copied to clipboard'
                ) : (
                  <>
                    Reach us: <u className="underline-offset-1">hello@mainframe.co</u>
                  </>
                )}
              </span>
              <CopyIcon />
            </button>

            {/* Open the app — links to the PCS7 app */}
            <a
              href={APP_URL}
              className="inline-flex items-center justify-center gap-2 bg-black text-white border border-black rounded-full text-[13px] sm:text-[15px] px-4 sm:px-5 py-[0.3em] mx-[0.2em] mb-[0.4em] whitespace-nowrap hover:bg-white hover:text-black transition-colors duration-200"
              style={{ fontFamily: 'var(--font-body)' }}
            >
              Open the app
              <ArrowIcon />
            </a>

            {/* AS Load Calc — links to the AS Load Calc app */}
            <a
              href={CALC_URL}
              className="inline-flex items-center justify-center gap-2 bg-black text-white border border-black rounded-full text-[13px] sm:text-[15px] px-4 sm:px-5 py-[0.3em] mx-[0.2em] mb-[0.4em] whitespace-nowrap hover:bg-white hover:text-black transition-colors duration-200"
              style={{ fontFamily: 'var(--font-body)' }}
            >
              AS Load Calc
              <ArrowIcon />
            </a>
          </div>
        </div>
      </section>
    </>
  );
}

export default App;
