import { useEffect, useRef, useState, useCallback } from 'react';
import BackgroundEffects from './components/BackgroundEffects';
import NeonCanvas from './components/NeonCanvas';

const SOURCE_IMAGE = '/deeksha.jpg';

// ─── Phases ──────────────────────────────────────────────────────────────────
// 'intro'     → pulsing heart + "LOVE YOU" text, slide-in
// 'burst'     → heart explodes, I LOVE YOU texts fly from random positions
// 'portrait'  → neon text portrait builds
// 'complete'  → portrait done, idle glow
type Phase = 'intro' | 'burst' | 'portrait' | 'complete';

function clamp(v: number, lo = 0, hi = 1) {
  return Math.max(lo, Math.min(hi, v));
}
function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// ─── Rainfall text item ──────────────────────────────────────────────────────
interface RainText {
  id: number;
  text: string;
  x: number;      // horizontal start % (spread across full width)
  drift: number;  // horizontal drift px during fall
  rot: number;    // rotation deg
  size: number;
  delay: number;  // staggered start for continuous rain
  dur: number;    // fall duration
  color: string;
  opacity: number;
}

const RAIN_COLORS = ['#ff1744', '#ff4081', '#f50057', '#ff80ab', '#ff6090', '#ff2090'];
const RAIN_TEXTS = ['I LOVE YOU', 'I♥U', 'LOVE', 'I LOVE YOU ♥', '♥', 'I♥LOVE♥YOU', 'I LOVE YOU YRR', '♥♥♥'];

function generateRain(count: number): RainText[] {
  const items: RainText[] = [];
  for (let i = 0; i < count; i++) {
    items.push({
      id: i,
      text: RAIN_TEXTS[Math.floor(Math.random() * RAIN_TEXTS.length)],
      x: Math.random() * 100,           // full width spread
      drift: (Math.random() - 0.5) * 80, // slight horizontal sway
      rot: (Math.random() - 0.5) * 20,
      size: 12 + Math.random() * 28,
      delay: Math.random() * 4,         // staggered over 4s for continuous rain
      dur: 3.5 + Math.random() * 3,     // 3.5-6.5s fall
      color: RAIN_COLORS[Math.floor(Math.random() * RAIN_COLORS.length)],
      opacity: 0.6 + Math.random() * 0.4,
    });
  }
  return items;
}

// ─── Heart SVG ───────────────────────────────────────────────────────────────
function HeartIcon({ size = 120, className = '', style = {} }: { size?: number; className?: string; style?: React.CSSProperties }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      style={style}
      fill="none"
    >
      <path
        d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"
        fill="url(#heartGrad)"
        stroke="#ff4081"
        strokeWidth="0.5"
      />
      <defs>
        <linearGradient id="heartGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ff4081" />
          <stop offset="50%" stopColor="#ff1744" />
          <stop offset="100%" stopColor="#d500f9" />
        </linearGradient>
      </defs>
    </svg>
  );
}

// ─── Main App ────────────────────────────────────────────────────────────────
export default function App() {
  const [phase, setPhase] = useState<Phase>('intro');
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [rain, setRain] = useState<RainText[]>([]);
  const [heartExploding, setHeartExploding] = useState(false);
  const [showFlash, setShowFlash] = useState(false);
  const [portraitProgress, setPortraitProgress] = useState(0);
  const [bgIntensity, setBgIntensity] = useState(0.15);

  const portraitStartRef = useRef(0);
  const rafRef = useRef(0);

  // Preload image in background
  useEffect(() => {
    const image = new Image();
    image.onload = () => setImg(image);
    image.src = SOURCE_IMAGE;
  }, []);

  // ── Heart click handler ────────────────────────────────────────────────────
  const handleHeartClick = useCallback(() => {
    if (phase !== 'intro') return;

    // Generate rainfall texts across full screen
    setRain(generateRain(90));
    setHeartExploding(true);
    setBgIntensity(0.5);

    // After heart explodes, show flash and transition to portrait
    setTimeout(() => {
      setShowFlash(true);
      setPhase('burst');
    }, 600);

    // After rainfall, start portrait
    setTimeout(() => {
      setPhase('portrait');
      portraitStartRef.current = performance.now();
      setBgIntensity(0.7);
    }, 6500);
  }, [phase]);

  // ── Portrait animation clock ───────────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'portrait') return;
    const PORTRAIT_DUR = 16000;

    const tick = (now: number) => {
      const t = now - portraitStartRef.current;
      const raw = clamp(t / PORTRAIT_DUR);
      setPortraitProgress(easeInOut(raw));

      // Fade background particles as portrait completes
      if (t < PORTRAIT_DUR * 0.3) {
        setBgIntensity(0.7);
      } else if (t < PORTRAIT_DUR) {
        setBgIntensity(0.7 - (t / PORTRAIT_DUR - 0.3) * 0.3);
      }

      if (t < PORTRAIT_DUR) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        setPortraitProgress(1);
        setPhase('complete');
        setBgIntensity(0.4);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [phase]);

  // ── Auto fade flash ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!showFlash) return;
    const t = setTimeout(() => setShowFlash(false), 800);
    return () => clearTimeout(t);
  }, [showFlash]);

  return (
    <div
      className="relative w-screen h-screen overflow-hidden no-select"
      style={{ background: '#000' }}
    >
      <BackgroundEffects intensity={bgIntensity} />

      {/* ── Stage 1: Intro — heart + LOVE YOU ─────────────────────────────── */}
      {phase === 'intro' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center z-50">
          {/* Heart — clickable */}
          <div
            onClick={handleHeartClick}
            className="cursor-pointer"
            style={{
              animation: heartExploding
                ? 'heartExplode 0.6s ease-out forwards'
                : 'heartPulse 1.8s ease-in-out infinite, heartBeat 2.5s ease-in-out infinite',
              transformOrigin: 'center',
            }}
          >
            <HeartIcon size={140} />
          </div>

          {/* LOVE YOU text below heart */}
          {!heartExploding && (
            <div
              style={{
                marginTop: 30,
                animation: 'slideUp 1.2s ease-out 0.3s both',
              }}
            >
              <p
                className="neon-text"
                style={{
                  fontSize: 'clamp(1.8rem, 5vw, 3.2rem)',
                  fontWeight: 300,
                  letterSpacing: '0.15em',
                  color: '#ff4081',
                  textShadow: '0 0 10px #ff4081, 0 0 25px #ff1744, 0 0 50px #f50057',
                }}
              >
                LOVE YOU YRR
              </p>
            </div>
          )}

          {/* Tap hint */}
          {!heartExploding && (
            <p
              style={{
                marginTop: 40,
                fontSize: 12,
                letterSpacing: '0.35em',
                textTransform: 'uppercase',
                color: 'rgba(255,64,129,0.5)',
                animation: 'tapHint 2s ease-in-out infinite',
                animationDelay: '1.5s',
              }}
            >
              Tap the heart
            </p>
          )}
        </div>
      )}

      {/* ── Stage 2: I LOVE YOU rainfall ─────────────────────────────────── */}
      {phase === 'burst' && (
        <div className="absolute inset-0 z-40 pointer-events-none overflow-hidden">
          {rain.map((r) => (
            <div
              key={r.id}
              style={{
                position: 'absolute',
                left: `${r.x}%`,
                top: '-60px',
                fontSize: `${r.size}px`,
                fontWeight: 300,
                color: r.color,
                textShadow: `0 0 8px ${r.color}, 0 0 18px ${r.color}, 0 0 30px ${r.color}`,
                whiteSpace: 'nowrap',
                fontFamily: "'Cormorant Garamond', Georgia, serif",
                fontStyle: 'italic',
                opacity: r.opacity,
                ['--drift' as string]: `${r.drift}px`,
                ['--rot' as string]: `${r.rot}deg`,
                animation: `loveRainfall ${r.dur}s linear ${r.delay}s forwards`,
              } as React.CSSProperties}
            >
              {r.text}
            </div>
          ))}
        </div>
      )}

      {/* ── White flash on heart explode ─────────────────────────────────── */}
      {showFlash && (
        <div
          className="absolute inset-0 z-50 pointer-events-none"
          style={{
            background: 'radial-gradient(circle, rgba(255,255,255,0.9) 0%, rgba(255,64,129,0.4) 40%, transparent 70%)',
            animation: 'flashWhite 0.8s ease-out forwards',
          }}
        />
      )}

      {/* ── Stage 3: Neon portrait ───────────────────────────────────────── */}
      {img && (phase === 'portrait' || phase === 'complete') && (
        <NeonCanvas img={img} progress={portraitProgress} />
      )}

      {/* ── Final caption ────────────────────────────────────────────────── */}
      {phase === 'complete' && (
        <div
          className="absolute bottom-6 left-0 right-0 text-center z-40"
          style={{ animation: 'fadeIn 2.5s ease forwards' }}
        >
          <p
            className="neon-text"
            style={{
              fontSize: 13,
              letterSpacing: '0.52em',
              textTransform: 'uppercase',
              color: 'rgba(255,64,129,0.38)',
              fontWeight: 300,
            }}
          >
            Neon Love
          </p>
        </div>
      )}
    </div>
  );
}
