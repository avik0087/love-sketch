import { useMemo, useId } from 'react';
import type { ContourPath, Point } from '../lib/imageProcessing';
import { pointsToPathD } from '../lib/imageProcessing';

interface NeonPathRendererProps {
  paths: ContourPath[];
  width: number;
  height: number;
  textProgress: number;
  drawProgress: number;
  scale: number;
}

const PHRASE = 'I LOVE YOU ✦ ';

function pathLength(points: Point[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return len;
}

export default function NeonPathRenderer({
  paths,
  width,
  height,
  textProgress,
  drawProgress,
}: NeonPathRendererProps) {
  const uid = useId().replace(/:/g, '');

  const pathData = useMemo(() => {
    // Base font size in processing-space pixels.
    // Tuned so text is legible but dense enough to fill contours.
    const fontSize = Math.max(6, Math.min(9, width / 58));

    return paths.map((p, idx) => {
      const id = `${uid}-p${idx}`;
      const d = pointsToPathD(p.points, p.closed);
      const len = pathLength(p.points);
      // Each glyph ≈ fontSize * 0.65 wide in processing space
      const glyphWidth = fontSize * 0.65;
      const phraseWidth = PHRASE.length * glyphWidth;
      const reps = Math.max(1, Math.ceil(len / phraseWidth));
      const text = PHRASE.repeat(Math.min(reps, 60));
      return { id, d, len, text, fontSize };
    });
  }, [paths, width, uid]);

  const filters = useMemo(
    () => (
      <defs>
        {/* 4-layer neon glow stack */}
        <filter id={`${uid}-glow`} x="-60%" y="-60%" width="220%" height="220%" colorInterpolationFilters="sRGB">
          <feGaussianBlur in="SourceGraphic" stdDeviation="0.8" result="g1" />
          <feGaussianBlur in="SourceGraphic" stdDeviation="2.5" result="g2" />
          <feGaussianBlur in="SourceGraphic" stdDeviation="6"   result="g3" />
          <feGaussianBlur in="SourceGraphic" stdDeviation="13"  result="bloom" />
          <feMerge>
            <feMergeNode in="bloom" />
            <feMergeNode in="g3" />
            <feMergeNode in="g2" />
            <feMergeNode in="g1" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>

        {/* Softer glow for guide lines */}
        <filter id={`${uid}-soft`} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="2" result="s" />
          <feMerge>
            <feMergeNode in="s" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>

        {/* Neon gradient: deep crimson → hot pink → rose */}
        <linearGradient id={`${uid}-grad`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%"   stopColor="#ff0844" />
          <stop offset="40%"  stopColor="#ff4081" />
          <stop offset="75%"  stopColor="#f50057" />
          <stop offset="100%" stopColor="#ff1744" />
        </linearGradient>

        {/* Subtle pink-tinted ambient fill behind portrait */}
        <radialGradient id={`${uid}-ambient`} cx="50%" cy="45%" r="52%">
          <stop offset="0%"   stopColor="#ff1744" stopOpacity="0.12" />
          <stop offset="50%"  stopColor="#ff4081" stopOpacity="0.04" />
          <stop offset="100%" stopColor="#000"    stopOpacity="0" />
        </radialGradient>

        {/* Hidden path geometry */}
        {pathData.map((p) => (
          <path key={p.id} id={p.id} d={p.d} fill="none" stroke="none" />
        ))}
      </defs>
    ),
    [pathData, uid]
  );

  return (
    <svg
      className="absolute inset-0 w-full h-full"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ overflow: 'visible' }}
    >
      {filters}

      {/* Ambient glow backing */}
      <rect
        x={0} y={0} width={width} height={height}
        fill={`url(#${uid}-ambient)`}
        opacity={textProgress * 0.9}
      />

      {/* Contour guide lines: appear during draw phase, fade as text fills */}
      {pathData.map((p) => {
        const op = drawProgress * (1 - textProgress * 0.75);
        if (op <= 0.01) return null;
        return (
          <path
            key={`gl-${p.id}`}
            d={p.d}
            fill="none"
            stroke="#ff4081"
            strokeWidth={0.5}
            strokeOpacity={op * 0.45}
            filter={`url(#${uid}-soft)`}
            strokeLinecap="round"
          />
        );
      })}

      {/* "I LOVE YOU" text along each contour — staggered reveal */}
      {pathData.map((p, idx) => {
        // Slightly stagger path reveals so the portrait "draws in" progressively
        const stagger = Math.min(0.6, idx * 0.008);
        const reveal = clamp01((textProgress - stagger) * 2.2);
        if (reveal < 0.005) return null;

        return (
          <g
            key={`txt-${p.id}`}
            filter={`url(#${uid}-glow)`}
            opacity={reveal}
          >
            <text
              fill={`url(#${uid}-grad)`}
              fontSize={p.fontSize}
              fontFamily="'Cormorant Garamond', Georgia, serif"
              fontStyle="italic"
              fontWeight={400}
              letterSpacing="0.06em"
            >
              <textPath href={`#${p.id}`} startOffset="0%">
                {p.text}
              </textPath>
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
