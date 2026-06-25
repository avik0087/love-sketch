/**
 * Image Processing Engine
 *
 * Pipeline:
 *  1. Load image onto an offscreen canvas
 *  2. Remove background (green-park aware flood-fill + chroma)
 *  3. Sobel edge detection on the isolated person mask
 *  4. Extract contour polylines (edge tracing + silhouette marching)
 *  5. Iso-contour extraction (luminance topographic lines)
 *  6. Simplify + smooth paths → SVG-ready output
 */

export interface Point {
  x: number;
  y: number;
}

export interface ContourPath {
  points: Point[];
  length: number;
  closed: boolean;
}

export interface ProcessResult {
  paths: ContourPath[];
  width: number;
  height: number;
  mask: Uint8Array;
  edges: Float32Array;
}

// Processing resolution: high enough to capture hair detail, low enough for speed
const WORK_SIZE = 520;

export async function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    img.src = src;
  });
}

function canvasFromImage(
  img: HTMLImageElement,
  maxDim: number
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; w: number; h: number } {
  const ratio = img.width / img.height;
  let w = maxDim;
  let h = maxDim;
  if (ratio > 1) {
    h = Math.round(maxDim / ratio);
  } else {
    w = Math.round(maxDim * ratio);
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, w, h);
  return { canvas, ctx, w, h };
}

// ─── Background removal ────────────────────────────────────────────────────

/**
 * Remove the park/grass background from Deeksha's portrait.
 *
 * Strategy: multi-pass flood fill from all four borders.
 * We use a combined color distance that is especially sensitive to greens
 * and the warm/overcast sky tones in this specific photo.
 *
 * Returns a mask where 1 = person, 0 = background.
 */
function removeBackground(
  data: Uint8ClampedArray,
  w: number,
  h: number
): Uint8Array {
  const mask = new Uint8Array(w * h);
  mask.fill(1);

  // ── Step 1: collect border color samples ──
  const samples: Array<[number, number, number]> = [];
  const samplePx = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    samples.push([data[i], data[i + 1], data[i + 2]]);
  };
  const step = 2;
  for (let x = 0; x < w; x += step) {
    samplePx(x, 0);
    samplePx(x, 1);
    samplePx(x, h - 1);
    samplePx(x, h - 2);
  }
  for (let y = 0; y < h; y += step) {
    samplePx(0, y);
    samplePx(1, y);
    samplePx(w - 1, y);
    samplePx(w - 2, y);
  }
  let br = 0, bg = 0, bb = 0;
  for (const s of samples) { br += s[0]; bg += s[1]; bb += s[2]; }
  br /= samples.length;
  bg /= samples.length;
  bb /= samples.length;

  // ── Step 2: define "is background" test ──
  // Uses euclidean distance from average border color +
  // a separate green-grass and sky detector.
  const isBg = (i: number): boolean => {
    const r = data[i], g = data[i + 1], b = data[i + 2];

    // Euclidean distance from sampled border color
    const dr = r - br, dg = g - bg, db = b - bb;
    const distBorder = Math.sqrt(dr * dr + dg * dg + db * db);
    if (distBorder < 55) return true;

    // Green grass / foliage: high green relative to red and blue
    const greenExcess = g - Math.max(r, b);
    if (greenExcess > 18 && g > 90) return true;

    // Overcast sky / haze: desaturated warm-grey
    const saturation = Math.max(r, g, b) - Math.min(r, g, b);
    const brightness = (r + g + b) / 3;
    if (saturation < 30 && brightness > 160 && r >= g && r >= b) return true;

    // Very bright whites (sky bloom)
    if (r > 210 && g > 210 && b > 200) return true;

    return false;
  };

  // ── Step 3: flood fill from borders ──
  const visited = new Uint8Array(w * h);
  const stack: number[] = [];

  const seedBorder = (x: number, y: number) => {
    const idx = y * w + x;
    if (!visited[idx] && isBg(idx * 4)) stack.push(idx);
  };

  for (let x = 0; x < w; x++) {
    for (let margin = 0; margin < 4; margin++) {
      seedBorder(x, margin);
      seedBorder(x, h - 1 - margin);
    }
  }
  for (let y = 0; y < h; y++) {
    for (let margin = 0; margin < 4; margin++) {
      seedBorder(margin, y);
      seedBorder(w - 1 - margin, y);
    }
  }

  while (stack.length) {
    const idx = stack.pop()!;
    if (idx < 0 || idx >= w * h || visited[idx]) continue;
    if (!isBg(idx * 4)) continue;
    visited[idx] = 1;
    mask[idx] = 0;
    const x = idx % w;
    const y = (idx / w) | 0;
    if (x > 0) stack.push(idx - 1);
    if (x < w - 1) stack.push(idx + 1);
    if (y > 0) stack.push(idx - w);
    if (y < h - 1) stack.push(idx + w);
  }

  // ── Step 4: morphological cleanup ──
  return morphologicalClean(mask, w, h);
}

function morphologicalClean(mask: Uint8Array, w: number, h: number): Uint8Array {
  const eroded = erode(mask, w, h, 1);
  const dilated = dilate(eroded, w, h, 3);
  // Second pass: fill holes inside the person
  return fillHoles(dilated, w, h);
}

/**
 * Fill enclosed background regions inside the person (e.g., gaps between fingers).
 * We flood-fill from borders on the *inverted* mask and subtract from background.
 */
function fillHoles(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(mask);
  const reachable = new Uint8Array(w * h);
  const stack: number[] = [];

  for (let x = 0; x < w; x++) {
    if (!mask[x]) stack.push(x);
    if (!mask[(h - 1) * w + x]) stack.push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    if (!mask[y * w]) stack.push(y * w);
    if (!mask[y * w + w - 1]) stack.push(y * w + w - 1);
  }

  while (stack.length) {
    const idx = stack.pop()!;
    if (reachable[idx] || mask[idx]) continue;
    reachable[idx] = 1;
    const x = idx % w, y = (idx / w) | 0;
    if (x > 0) stack.push(idx - 1);
    if (x < w - 1) stack.push(idx + 1);
    if (y > 0) stack.push(idx - w);
    if (y < h - 1) stack.push(idx + w);
  }

  // Any background pixel NOT reachable from border = enclosed hole → fill
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] && !reachable[i]) out[i] = 1;
  }
  return out;
}

function erode(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = r; y < h - r; y++) {
    for (let x = r; x < w - r; x++) {
      let keep = 1;
      outer: for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (!mask[(y + dy) * w + (x + dx)]) { keep = 0; break outer; }
        }
      }
      out[y * w + x] = keep;
    }
  }
  return out;
}

function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h) out[ny * w + nx] = 1;
        }
      }
    }
  }
  return out;
}

// ─── Edge detection ────────────────────────────────────────────────────────

/**
 * Multi-scale Sobel edge detection inside the person mask.
 * We run at two scales and merge for richer feature capture.
 */
function detectEdges(
  data: Uint8ClampedArray,
  mask: Uint8Array,
  w: number,
  h: number
): Float32Array {
  const edges = new Float32Array(w * h);
  const gray = new Float32Array(w * h);

  for (let i = 0; i < w * h; i++) {
    if (!mask[i]) { gray[i] = 0; continue; }
    const j = i * 4;
    gray[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
  }

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;

      const tl = gray[(y - 1) * w + (x - 1)], tc = gray[(y - 1) * w + x], tr = gray[(y - 1) * w + (x + 1)];
      const ml = gray[y * w + (x - 1)],                                      mr = gray[y * w + (x + 1)];
      const bl = gray[(y + 1) * w + (x - 1)], bc = gray[(y + 1) * w + x], br = gray[(y + 1) * w + (x + 1)];

      const gx = -tl - 2 * ml - bl + tr + 2 * mr + br;
      const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
      let mag = Math.sqrt(gx * gx + gy * gy);

      // Boost silhouette (border of mask)
      let boundary = 0;
      for (let dy = -1; dy <= 1 && !boundary; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!mask[(y + dy) * w + (x + dx)]) { boundary = 1; break; }
        }
      }
      if (boundary) mag = Math.max(mag, 200);

      edges[i] = mag;
    }
  }

  return edges;
}

// ─── Contour extraction ────────────────────────────────────────────────────

function extractContours(
  edges: Float32Array,
  w: number,
  h: number,
  threshold: number
): ContourPath[] {
  const visited = new Uint8Array(w * h);
  const paths: ContourPath[] = [];

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (visited[i] || edges[i] < threshold) continue;

      const points: Point[] = [];
      let cx = x, cy = y;
      let steps = 0;
      const maxSteps = 5000;

      while (steps < maxSteps) {
        const ci = cy * w + cx;
        if (visited[ci] && steps > 0) break;
        visited[ci] = 1;
        points.push({ x: cx, y: cy });

        const order = [[0,1],[1,0],[0,-1],[-1,0],[1,1],[-1,1],[1,-1],[-1,-1]];
        let found = false;
        for (const [dx, dy] of order) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (!visited[ni] && edges[ni] >= threshold) {
            cx = nx; cy = ny; found = true; break;
          }
        }
        if (!found) break;
        steps++;
      }

      if (points.length >= 12) paths.push({ points, length: points.length, closed: false });
    }
  }

  return paths;
}

function extractSilhouette(mask: Uint8Array, w: number, h: number): ContourPath[] {
  const paths: ContourPath[] = [];
  const visited = new Uint8Array(w * h);

  const isBoundary = (x: number, y: number) => {
    if (!mask[y * w + x]) return false;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!mask[(y + dy) * w + (x + dx)]) return true;
      }
    }
    return false;
  };

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (visited[i] || !isBoundary(x, y)) continue;

      const points: Point[] = [];
      let cx = x, cy = y;
      let steps = 0;

      while (steps < 8000) {
        const ci = cy * w + cx;
        if (visited[ci] && steps > 0) break;
        visited[ci] = 1;
        points.push({ x: cx, y: cy });

        const order = [[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]];
        let found = false;
        for (const [dx, dy] of order) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (!visited[ni] && isBoundary(nx, ny)) {
            cx = nx; cy = ny; found = true; break;
          }
        }
        if (!found) break;
        steps++;
      }

      if (points.length >= 20) paths.push({ points, length: points.length, closed: true });
    }
  }

  return paths;
}

// ─── Iso-contour (topographic luminance lines) ─────────────────────────────

/**
 * Extract dense iso-contour lines at multiple luminance levels inside the mask.
 * These flow naturally along hair strands, face contours, hands, and clothing.
 */
function extractIsoContours(
  data: Uint8ClampedArray,
  mask: Uint8Array,
  w: number,
  h: number
): ContourPath[] {
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (!mask[i]) { gray[i] = -1; continue; }
    const j = i * 4;
    gray[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
  }

  const paths: ContourPath[] = [];
  // Dense levels — more levels = denser text portrait
  const levels = [20, 35, 50, 65, 80, 100, 120, 140, 160, 178, 195, 210, 225];

  for (const level of levels) {
    const contours = marchingSquares(gray, mask, w, h, level);
    paths.push(...contours);
  }

  return paths;
}

function marchingSquares(
  gray: Float32Array,
  mask: Uint8Array,
  w: number,
  h: number,
  level: number
): ContourPath[] {
  const segments: Array<[Point, Point]> = [];

  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const i00 = y * w + x, i10 = y * w + (x + 1);
      const i11 = (y + 1) * w + (x + 1), i01 = (y + 1) * w + x;

      if (!mask[i00] && !mask[i10] && !mask[i11] && !mask[i01]) continue;

      const tl = gray[i00] >= level ? 1 : 0;
      const tr = gray[i10] >= level ? 1 : 0;
      const br = gray[i11] >= level ? 1 : 0;
      const bl = gray[i01] >= level ? 1 : 0;

      const code = (tl << 3) | (tr << 2) | (br << 1) | bl;
      if (code === 0 || code === 15) continue;

      const lerp = (a: number, b: number) => {
        const va = gray[a], vb = gray[b];
        if (Math.abs(va - vb) < 0.001) return 0.5;
        return Math.max(0, Math.min(1, (level - va) / (vb - va)));
      };

      const top    = (): Point => ({ x: x + lerp(i00, i10), y: y });
      const right  = (): Point => ({ x: x + 1,              y: y + lerp(i10, i11) });
      const bottom = (): Point => ({ x: x + lerp(i01, i11), y: y + 1 });
      const left   = (): Point => ({ x: x,                  y: y + lerp(i00, i01) });

      switch (code) {
        case 1:  case 14: segments.push([left(), bottom()]); break;
        case 2:  case 13: segments.push([bottom(), right()]); break;
        case 3:  case 12: segments.push([left(), right()]); break;
        case 4:  case 11: segments.push([top(), right()]); break;
        case 5:           segments.push([left(), top()], [bottom(), right()]); break;
        case 6:  case 9:  segments.push([top(), bottom()]); break;
        case 7:  case 8:  segments.push([left(), top()]); break;
        case 10:          segments.push([left(), bottom()], [top(), right()]); break;
      }
    }
  }

  return chainSegments(segments);
}

function chainSegments(segments: Array<[Point, Point]>): ContourPath[] {
  const paths: ContourPath[] = [];
  const used = new Uint8Array(segments.length);
  const tol = 0.6;

  const close = (a: Point, b: Point) =>
    Math.abs(a.x - b.x) < tol && Math.abs(a.y - b.y) < tol;

  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    let [start, end] = segments[i];
    const points: Point[] = [start, end];

    let found = true;
    while (found) {
      found = false;
      for (let j = 0; j < segments.length; j++) {
        if (used[j]) continue;
        const [a, b] = segments[j];
        if (close(end, a)) { points.push(b); end = b; used[j] = 1; found = true; break; }
        if (close(end, b)) { points.push(a); end = a; used[j] = 1; found = true; break; }
      }
    }

    found = true;
    while (found) {
      found = false;
      for (let j = 0; j < segments.length; j++) {
        if (used[j]) continue;
        const [a, b] = segments[j];
        if (close(start, a)) { points.unshift(b); start = b; used[j] = 1; found = true; break; }
        if (close(start, b)) { points.unshift(a); start = a; used[j] = 1; found = true; break; }
      }
    }

    if (points.length >= 5) paths.push({ points, length: points.length, closed: false });
  }

  return paths;
}

// ─── Path simplification & smoothing ──────────────────────────────────────

function simplifyAndSmooth(points: Point[], tolerance = 1.2): Point[] {
  if (points.length < 3) return points;
  const simplified = douglasPeucker(points, tolerance);
  return smoothPath(simplified, 2);
}

function douglasPeucker(points: Point[], tol: number): Point[] {
  if (points.length < 3) return points;
  let maxDist = 0, idx = 0;
  const last = points.length - 1;
  for (let i = 1; i < last; i++) {
    const d = perpDist(points[i], points[0], points[last]);
    if (d > maxDist) { maxDist = d; idx = i; }
  }
  if (maxDist > tol) {
    const left = douglasPeucker(points.slice(0, idx + 1), tol);
    const right = douglasPeucker(points.slice(idx), tol);
    return left.slice(0, -1).concat(right);
  }
  return [points[0], points[last]];
}

function perpDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (dx === 0 && dy === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function smoothPath(points: Point[], passes: number): Point[] {
  let out = points;
  for (let p = 0; p < passes; p++) {
    const next: Point[] = [out[0]];
    for (let i = 1; i < out.length - 1; i++) {
      next.push({
        x: (out[i - 1].x + out[i].x * 2 + out[i + 1].x) / 4,
        y: (out[i - 1].y + out[i].y * 2 + out[i + 1].y) / 4,
      });
    }
    next.push(out[out.length - 1]);
    out = next;
  }
  return out;
}

// ─── SVG path helper ───────────────────────────────────────────────────────

export function pointsToPathD(points: Point[], closed = false): string {
  if (points.length === 0) return '';
  let d = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  for (let i = 1; i < points.length; i++) {
    d += ` L ${points[i].x.toFixed(2)} ${points[i].y.toFixed(2)}`;
  }
  if (closed) d += ' Z';
  return d;
}

// ─── Main pipeline ─────────────────────────────────────────────────────────

export function processImage(img: HTMLImageElement): ProcessResult {
  const { w, h, ctx } = canvasFromImage(img, WORK_SIZE);
  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;

  const mask = removeBackground(data, w, h);
  const edges = detectEdges(data, mask, w, h);

  // Edge-based contours (silhouette + feature edges)
  const edgeContours = extractContours(edges, w, h, 80);
  // Silhouette boundary
  const silhouette = extractSilhouette(mask, w, h);
  // Luminance iso-contours (hair flow, face, hands, clothing)
  const isoContours = extractIsoContours(data, mask, w, h);

  const rawPaths = [...edgeContours, ...silhouette, ...isoContours];

  const paths = rawPaths
    .map((p) => {
      const pts = simplifyAndSmooth(p.points, 1.4);
      return { points: pts, length: pts.length, closed: p.closed };
    })
    .filter((p) => p.length >= 6)
    .sort((a, b) => b.length - a.length);

  return { paths, width: w, height: h, mask, edges };
}
