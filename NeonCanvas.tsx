import { useEffect, useRef, useCallback } from 'react';

interface NeonCanvasProps {
  img: HTMLImageElement;
  progress: number; // 0..1
}

// Richer phrase set — cycling through these gives visual texture variation
// instead of the same 11 chars repeating identically everywhere.
const PHRASES = [
  'I LOVE YOU ',
  'I LOVE YOU ♥ ',
  'I♥LOVE♥YOU ',
  'I LOVE YOU ✦ ',
];
const COMBINED = PHRASES.join('');
const COMBINED_LEN = COMBINED.length;

// ─── Neon colour ramp ────────────────────────────────────────────────────────
// 0 = shadow/hair → deep crimson-black
// 1 = highlight   → bright rose-white
// Skin tones get a warmer pink bias; cold darks get deeper crimson.
function neonRGB(lum: number, isSkin: boolean): [number, number, number] {
  const b = Math.pow(Math.max(0, Math.min(1, lum)), 0.70);

  if (b < 0.14) {
    // Deep shadow / black hair → blood crimson
    const f = b / 0.14;
    return [Math.round(90 + f * 140), Math.round(f * 10), Math.round(f * 24)];
  } else if (b < 0.34) {
    // Shadow-to-mid → crimson to vivid red
    const f = (b - 0.14) / 0.20;
    return [230 + Math.round(f * 25), Math.round(10 + f * 24), Math.round(24 + f * 52)];
  } else if (b < 0.58) {
    // Mid tones → neon hot pink
    const f = (b - 0.34) / 0.24;
    // Skin gets a warmer bias (more green = rosier pink)
    const skinBoost = isSkin ? 18 : 0;
    return [255, Math.round(34 + f * (70 + skinBoost)), Math.round(76 + f * 94)];
  } else if (b < 0.80) {
    // Upper-mid highlights → bright pink
    const f = (b - 0.58) / 0.22;
    const skinBoost = isSkin ? 22 : 0;
    return [255, Math.round(104 + f * (120 + skinBoost)), Math.round(170 + f * 60)];
  } else {
    // Bright highlights → near-white rose
    const f = (b - 0.80) / 0.20;
    return [255, Math.round(226 + f * 29), Math.round(230 + f * 25)];
  }
}

// ─── Background classifier ────────────────────────────────────────────────────
function isBg(r: number, g: number, b: number, lum: number): boolean {
  const greenDom = g - Math.max(r, b);
  if (greenDom > 12 && g > 85 && lum > 0.26) return true;           // grass/leaves
  const sat = Math.max(r, g, b) - Math.min(r, g, b);
  if (lum > 0.76 && sat < 36)  return true;                          // sky / haze
  if (r > 198 && g > 192 && b > 175 && lum > 0.78) return true;     // bright sky
  return false;
}

// ─── Skin-tone detector ───────────────────────────────────────────────────────
// Detects warm reddish-pink tones typical of skin (any ethnicity).
function isSkinTone(r: number, g: number, b: number): boolean {
  // Skin: R > G > B, R-B > 12, moderate saturation, not too dark
  if (r < 95 || r > 255) return false;
  if (!(r > g && g > b)) return false;
  if (r - b < 10) return false;
  const sat = r - Math.min(g, b);
  if (sat < 8 || sat > 120) return false;
  // Exclude orange-red clothing (very high R, low G and B)
  if (r > 200 && g < 90 && b < 80) return false;
  return true;
}

// ─── S-curve contrast ─────────────────────────────────────────────────────────
function sCurve(x: number): number {
  return x < 0.5
    ? 0.5 * Math.pow(2 * x, 1.70)
    : 1 - 0.5 * Math.pow(2 * (1 - x), 1.70);
}

// ─── Sobel edge magnitude ─────────────────────────────────────────────────────
// Returns a Float32Array of edge magnitudes (0..~400).
function sobelEdges(lum: Float32Array, W: number, H: number): Float32Array {
  const edges = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const tl = lum[i - W - 1], tc = lum[i - W], tr = lum[i - W + 1];
      const ml = lum[i - 1],                       mr = lum[i + 1];
      const bl = lum[i + W - 1], bc = lum[i + W], br = lum[i + W + 1];
      const gx = -tl - 2 * ml - bl + tr + 2 * mr + br;
      const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
      edges[i] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return edges;
}

// ─── Cell type ───────────────────────────────────────────────────────────────
interface Cell {
  x: number; y: number;
  char: string;
  lum: number;
  alpha: number;
  r: number; g: number; b: number;
  wave: number;     // 0..1 — diagonal reveal order
  fontSize: number; // varies by local detail
}

// ─── Component ───────────────────────────────────────────────────────────────
export default function NeonCanvas({ img, progress }: NeonCanvasProps) {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const cellsRef     = useRef<Cell[]>([]);
  const cwRef        = useRef(6);
  const glowRef      = useRef<HTMLCanvasElement | null>(null);
  const sharpRef     = useRef<HTMLCanvasElement | null>(null);
  const rafRef       = useRef(0);

  // ── Build grid ───────────────────────────────────────────────────────────
  const buildGrid = useCallback((W: number, H: number) => {
    // Sample image at display resolution
    const src = document.createElement('canvas');
    src.width = W; src.height = H;
    const sc = src.getContext('2d', { willReadFrequently: true })!;

    // Cover-fit
    const ir = img.width / img.height, cr = W / H;
    let dw = W, dh = H, dx = 0, dy = 0;
    if (ir > cr) { dh = H; dw = H * ir; dx = (W - dw) / 2; }
    else          { dw = W; dh = W / ir; dy = (H - dh) / 2; }
    sc.drawImage(img, dx, dy, dw, dh);
    const { data } = sc.getImageData(0, 0, W, H);

    // Luminance map
    const lum = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const j = i * 4;
      lum[i] = (0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2]) / 255;
    }

    // Sobel edge map — captures hair strands, eyelashes, finger outlines
    const edges = sobelEdges(lum, W, H);

    // Local contrast map (7×7 box — difference from local mean)
    const lc = new Float32Array(W * H);
    const LR = 7;
    for (let y = LR; y < H - LR; y++) {
      for (let x = LR; x < W - LR; x++) {
        let s = 0, cnt = 0;
        for (let dy = -LR; dy <= LR; dy += 2) {
          for (let dx2 = -LR; dx2 <= LR; dx2 += 2) {
            s += lum[(y + dy) * W + (x + dx2)]; cnt++;
          }
        }
        lc[y * W + x] = lum[y * W + x] - s / cnt;
      }
    }

    // Character cell: ~240 columns for hair-strand level detail
    const cw = Math.max(4, Math.floor(W / 240));
    const ch = Math.round(cw * 1.78);
    const cols = Math.floor(W / cw);
    const rows = Math.floor(H / ch);
    cwRef.current = cw;

    const cells: Cell[] = [];
    let phraseIdx = 0;

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const cx = col * cw + (cw >> 1);
        const cy = row * ch + (ch >> 1);

        // Multi-sample: average 2×2 sub-points within the cell footprint
        let sR = 0, sG = 0, sB = 0, sL = 0, sLC = 0, sEdge = 0, cnt = 0;
        const halfStep = Math.max(1, Math.floor(cw / 3));
        for (let sy = -halfStep; sy <= halfStep; sy += Math.max(1, halfStep)) {
          for (let sx = -halfStep; sx <= halfStep; sx += Math.max(1, halfStep)) {
            const px = cx + sx, py = cy + sy;
            if (px < 0 || py < 0 || px >= W || py >= H) continue;
            const pi = py * W + px, pj = pi * 4;
            sR += data[pj]; sG += data[pj + 1]; sB += data[pj + 2];
            sL  += lum[pi]; sLC += lc[pi]; sEdge += edges[pi]; cnt++;
          }
        }
        if (!cnt) { phraseIdx++; continue; }

        const aR = sR / cnt, aG = sG / cnt, aB = sB / cnt;
        const rawL = sL / cnt, lcv = sLC / cnt;
        const edgeMag = sEdge / cnt; // 0..~360

        if (isBg(aR, aG, aB, rawL)) { phraseIdx++; continue; }

        // Skin detection
        const skin = isSkinTone(aR, aG, aB);

        // Enhanced luminance: S-curve + local contrast + edge boost
        // Edge boost: strong edges (hair, eyes, lips) get pushed brighter
        const edgeBoost = Math.min(0.25, edgeMag / 1400);
        const enhL = Math.max(0, Math.min(1, sCurve(rawL) + lcv * 0.42 + edgeBoost));

        // Alpha: hair & shadows solid; edges boosted; skin slightly brighter
        let alpha: number;
        if (rawL < 0.18) {
          alpha = 0.78;                              // dark hair / eyes — very solid
        } else if (edgeMag > 80) {
          alpha = 0.72 + Math.min(0.20, edgeMag / 800); // edges — boosted
        } else {
          alpha = 0.50 + enhL * 0.48;                // skin/clothing — luminance driven
        }
        if (skin) alpha = Math.min(1, alpha + 0.06);  // skin slightly more visible

        const [cr2, cg, cb] = neonRGB(enhL, skin);

        // Font size varies by local detail:
        // High-detail areas (strong edges) → smaller chars (more text density)
        // Flat areas (cheeks, clothing) → slightly larger chars
        const detailFactor = Math.min(1, edgeMag / 120);
        const fontSize = Math.max(
          4,
          Math.round(cw * (0.92 - detailFactor * 0.22))
        );

        // Diagonal wave reveal (left-to-right + slight top-to-bottom tilt)
        const wave = (col / cols) * 0.65 + (row / rows) * 0.35;

        cells.push({
          x: col * cw, y: row * ch,
          char: COMBINED[phraseIdx % COMBINED_LEN],
          lum: enhL, alpha,
          r: cr2, g: cg, b: cb,
          wave, fontSize,
        });
        phraseIdx++;
      }
    }

    cellsRef.current = cells;
    glowRef.current  = null;
    sharpRef.current = null;
  }, [img]);

  // ── Render ────────────────────────────────────────────────────────────────
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !cellsRef.current.length) return;

    const W   = canvas.width;
    const H   = canvas.height;
    const ctx = canvas.getContext('2d')!;
    const cw  = cwRef.current;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    if (progress <= 0.001) return;

    // Visible set
    const cells = cellsRef.current;
    const visible: Cell[] = [];
    for (const cell of cells) {
      if (cell.wave < progress) visible.push(cell);
    }
    if (!visible.length) return;

    const fullyRevealed = progress >= 0.999;

    // ── Layer 1: Glow offscreen ───────────────────────────────────────────
    let glowC = fullyRevealed ? glowRef.current : null;
    if (!glowC) {
      glowC = document.createElement('canvas');
      glowC.width  = W; glowC.height = H;
      const gc = glowC.getContext('2d')!;
      gc.textBaseline = 'top'; gc.textAlign = 'left';

      // Group cells by fontSize to minimize font string changes
      const bySize = new Map<number, Cell[]>();
      for (const cell of visible) {
        const arr = bySize.get(cell.fontSize);
        if (arr) arr.push(cell); else bySize.set(cell.fontSize, [cell]);
      }
      for (const [fs, group] of bySize) {
        gc.font = `italic ${fs}px 'Cormorant Garamond', Georgia, serif`;
        for (const { x, y, char, r, g, b, alpha } of group) {
          gc.fillStyle = `rgba(${r},${g},${b},${alpha})`;
          gc.fillText(char, x, y);
        }
      }
      if (fullyRevealed) glowRef.current = glowC;
    }

    // Composite 4 glow passes using screen blending for neon bloom
    ctx.save();
    ctx.globalCompositeOperation = 'screen';

    // 1. Outermost bloom (largest blur, dim)
    ctx.filter     = `blur(${Math.round(cw * 3.5)}px) brightness(2.0)`;
    ctx.globalAlpha = 0.35;
    ctx.drawImage(glowC, 0, 0);

    // 2. Mid-wide glow
    ctx.filter     = `blur(${Math.round(cw * 2.0)}px) brightness(1.7)`;
    ctx.globalAlpha = 0.50;
    ctx.drawImage(glowC, 0, 0);

    // 3. Mid-tight glow
    ctx.filter     = `blur(${Math.round(cw * 1.0)}px) brightness(1.4)`;
    ctx.globalAlpha = 0.68;
    ctx.drawImage(glowC, 0, 0);

    // 4. Ultra-tight inner glow (crisp neon core halo)
    ctx.filter     = `blur(${Math.round(cw * 0.35)}px) brightness(1.2)`;
    ctx.globalAlpha = 0.85;
    ctx.drawImage(glowC, 0, 0);

    ctx.restore();

    // ── Layer 2: Sharp text ───────────────────────────────────────────────
    let sharpC = fullyRevealed ? sharpRef.current : null;
    if (!sharpC) {
      sharpC = document.createElement('canvas');
      sharpC.width  = W; sharpC.height = H;
      const sc2 = sharpC.getContext('2d')!;
      sc2.textBaseline = 'top'; sc2.textAlign = 'left';

      // Group by fontSize for the sharp layer too
      const bySize = new Map<number, Cell[]>();
      for (const cell of visible) {
        const arr = bySize.get(cell.fontSize);
        if (arr) arr.push(cell); else bySize.set(cell.fontSize, [cell]);
      }
      for (const [fs, group] of bySize) {
        sc2.font = `italic ${fs}px 'Cormorant Garamond', Georgia, serif`;
        sc2.shadowBlur = 2;
        for (const { x, y, char, r, g, b, alpha } of group) {
          sc2.shadowColor = `rgb(${r},${g},${b})`;
          sc2.fillStyle   = `rgba(${r},${g},${b},${alpha})`;
          sc2.fillText(char, x, y);
        }
      }
      sc2.shadowBlur = 0;
      if (fullyRevealed) sharpRef.current = sharpC;
    }

    ctx.globalCompositeOperation = 'source-over';
    ctx.filter     = 'none';
    ctx.globalAlpha = 1;
    ctx.drawImage(sharpC, 0, 0);

    // ── Wave-front flare (animation only) ────────────────────────────────
    if (!fullyRevealed) {
      const fx = progress * W;
      const fl = Math.round(cw * 6);
      const grad = ctx.createLinearGradient(fx - fl, 0, fx + cw * 2, 0);
      grad.addColorStop(0,   'rgba(255,23,68,0)');
      grad.addColorStop(0.55, 'rgba(255,64,129,0.20)');
      grad.addColorStop(0.85, 'rgba(255,180,200,0.10)');
      grad.addColorStop(1,   'rgba(255,255,255,0.06)');
      ctx.fillStyle = grad;
      ctx.globalCompositeOperation = 'screen';
      ctx.fillRect(fx - fl, 0, fl + cw * 3, H);
      ctx.globalCompositeOperation = 'source-over';
    }

    ctx.filter     = 'none';
    ctx.globalAlpha = 1;
  }, [progress]);

  // ── Canvas setup ──────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const setup = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const logW = canvas.offsetWidth;
      const logH = canvas.offsetHeight;
      canvas.width  = Math.floor(logW * dpr);
      canvas.height = Math.floor(logH * dpr);
      buildGrid(canvas.width, canvas.height);
    };

    setup();
    const ro = new ResizeObserver(setup);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [buildGrid]);

  // ── Re-render on progress tick ────────────────────────────────────────────
  useEffect(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(rafRef.current);
  }, [render, progress]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full"
      style={{ display: 'block' }}
    />
  );
}
