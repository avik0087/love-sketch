import { useMemo } from 'react';

interface BackgroundEffectsProps {
  intensity: number;
}

interface Particle { left: number; top: number; size: number; dur: number; delay: number; hue: string }
interface Spark    { left: number; top: number; dx: number; dy: number; dur: number; delay: number; sz: number }
interface Wave     { left: number; top: number; sz: number; dur: number; delay: number }

const PARTICLES = 65;
const SPARKS    = 30;
const WAVES     = 7;

const r = (min: number, max: number) => Math.random() * (max - min) + min;

export default function BackgroundEffects({ intensity }: BackgroundEffectsProps) {
  const particles = useMemo<Particle[]>(() =>
    Array.from({ length: PARTICLES }, () => ({
      left: r(0, 100), top: r(0, 100),
      size: r(0.8, 3.2),
      dur: r(9, 22), delay: r(0, 18),
      hue: Math.random() > 0.45 ? '#ff1744' : '#ff4081',
    })), []);

  const sparks = useMemo<Spark[]>(() =>
    Array.from({ length: SPARKS }, () => ({
      left: r(5, 95), top: r(5, 95),
      dx: r(-220, 220), dy: r(-220, 220),
      dur: r(3, 8), delay: r(0, 12),
      sz: r(1.5, 4.5),
    })), []);

  const waves = useMemo<Wave[]>(() =>
    Array.from({ length: WAVES }, () => ({
      left: r(15, 85), top: r(15, 85),
      sz: r(180, 560),
      dur: r(7, 14), delay: r(0, 10),
    })), []);

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden" style={{ opacity: intensity }}>

      {/* Deep ambient glow centered on the portrait */}
      <div className="absolute" style={{
        left: '50%', top: '48%',
        transform: 'translate(-50%, -50%)',
        width: '75vmin', height: '75vmin',
        borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(255,23,68,0.1) 0%, rgba(255,64,129,0.05) 40%, transparent 70%)',
        animation: 'ambientGlow 7s ease-in-out infinite',
      }} />

      {/* Secondary glow pulse */}
      <div className="absolute" style={{
        left: '50%', top: '48%',
        transform: 'translate(-50%, -50%)',
        width: '45vmin', height: '55vmin',
        borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(245,0,87,0.07) 0%, transparent 65%)',
        animation: 'ambientGlow 5s ease-in-out infinite',
        animationDelay: '1.5s',
      }} />

      {/* Energy rings */}
      {waves.map((w, i) => (
        <div key={`wave-${i}`} className="absolute rounded-full" style={{
          left: `${w.left}%`, top: `${w.top}%`,
          width: `${w.sz}px`, height: `${w.sz}px`,
          border: '1px solid rgba(255,64,129,0.12)',
          transform: 'translate(-50%, -50%)',
          animation: `wavePulse ${w.dur}s ease-out infinite`,
          animationDelay: `${w.delay}s`,
        }} />
      ))}

      {/* Floating particles */}
      {particles.map((p, i) => (
        <div key={`pt-${i}`} className="absolute rounded-full" style={{
          left: `${p.left}%`, top: `${p.top}%`,
          width: `${p.size}px`, height: `${p.size}px`,
          background: p.hue,
          boxShadow: `0 0 ${p.size * 3}px ${p.hue}, 0 0 ${p.size * 7}px ${p.hue}`,
          animation: `floatUp ${p.dur}s linear infinite`,
          animationDelay: `${p.delay}s`,
        }} />
      ))}

      {/* Neon sparks */}
      {sparks.map((s, i) => (
        <div key={`sp-${i}`} className="absolute rounded-full" style={{
          left: `${s.left}%`, top: `${s.top}%`,
          width: `${s.sz}px`, height: `${s.sz}px`,
          background: '#ff4081',
          boxShadow: '0 0 5px #ff4081, 0 0 10px #ff1744',
          ['--dx' as string]: `${s.dx}px`,
          ['--dy' as string]: `${s.dy}px`,
          animation: `sparkDrift ${s.dur}s ease-out infinite`,
          animationDelay: `${s.delay}s`,
        } as React.CSSProperties} />
      ))}
    </div>
  );
}
