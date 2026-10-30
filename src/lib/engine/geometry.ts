import type { BBox } from './types';

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function normalizeBBox(b: BBox, w: number, h: number): BBox {
  if (w <= 0 || h <= 0) throw new Error('image dimensions must be positive');
  return { x: clamp01(b.x / w), y: clamp01(b.y / h), width: clamp01(b.width / w), height: clamp01(b.height / h) };
}
export function denormalizeBBox(b: BBox, w: number, h: number): BBox {
  return { x: b.x * w, y: b.y * h, width: b.width * w, height: b.height * h };
}

/** Derive the REAL bbox from a boolean difference mask (row-major, w*h). */
export function maskToBBox(mask: Uint8Array | boolean[], w: number, h: number): BBox | null {
  if (mask.length !== w * h) throw new Error(`mask size ${mask.length} != ${w}x${h}`);
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (mask[y * w + x]) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export function overlaps(a: BBox, b: BBox, pad = 0): boolean {
  return !(a.x + a.width + pad <= b.x || b.x + b.width + pad <= a.x || a.y + a.height + pad <= b.y || b.y + b.height + pad <= a.y);
}
export function enforceSpacing<T extends { bbox: BBox }>(items: T[], pad = 8): T[] {
  const kept: T[] = [];
  for (const it of items) if (!kept.some(k => overlaps(k.bbox, it.bbox, pad))) kept.push(it);
  return kept;
}

/** Center of mass of a boolean diff mask — where the change visually IS (bbox center can
 *  fall outside an irregular change). Used to center the found-marker circle. */
export function maskCentroid(mask: Uint8Array | boolean[], w: number, h: number): { x: number; y: number } | null {
  if (mask.length !== w * h) throw new Error(`mask size ${mask.length} != ${w}x${h}`);
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { sx += x; sy += y; n++; }
  return n ? { x: sx / n, y: sy / n } : null;
}

/**
 * COCO polygon for a boolean mask: crack-following boundary trace (walk the grid
 * edges of the foreground, keeping foreground cells on the right) around the
 * component containing the first foreground pixel. Returns a FLAT
 * [x1,y1,x2,y2,...] array of grid-corner coordinates, or null for an empty mask.
 * Degenerate traces fall back to the mask's bbox rectangle (>= 3 points always).
 */
export function maskToPolygon(mask: Uint8Array | boolean[], w: number, h: number): number[] | null {
  if (mask.length !== w * h) throw new Error(`mask size ${mask.length} != ${w}x${h}`);
  const fg = (cx: number, cy: number) => cx >= 0 && cy >= 0 && cx < w && cy < h && !!mask[cy * w + cx];
  let start = -1;
  for (let i = 0; i < w * h; i++) if (mask[i]) { start = i; break; }
  if (start < 0) return null;
  const bbox = maskToBBox(mask, w, h)!;
  const rect = [bbox.x, bbox.y, bbox.x + bbox.width, bbox.y, bbox.x + bbox.width, bbox.y + bbox.height, bbox.x, bbox.y + bbox.height];
  // Headings E,S,W,N (y down). Right/left cells of the edge leaving vertex (vx,vy):
  const RIGHT = [[0, 0], [-1, 0], [-1, -1], [0, -1]]; // per heading: [dcx, dcy] added to (vx, vy)
  const LEFT = [[0, -1], [0, 0], [-1, 0], [-1, -1]];
  const STEP = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  const sx = start % w, sy = (start / w) | 0;
  let vx = sx, vy = sy, heading = 0; // start at the pixel's top-left corner, heading east along its top edge
  const corners: [number, number][] = [[vx, vy]];
  const maxSteps = w * h * 4 + 16;
  for (let step = 0; step < maxSteps; step++) {
    // Closed the loop as soon as we are BACK at the start vertex (any heading — the
    // walker arrives heading N and departs E, so a heading check here never fires).
    if (step > 0 && vx === sx && vy === sy) break;
    // Preference: right turn, straight, left turn, back — first edge with fg on the right and bg on the left.
    let moved = false;
    for (const turn of [1, 0, 3, 2]) {
      const nh = (heading + turn) % 4;
      const rcx = vx + RIGHT[nh][0], rcy = vy + RIGHT[nh][1];
      const lcx = vx + LEFT[nh][0], lcy = vy + LEFT[nh][1];
      if (fg(rcx, rcy) && !fg(lcx, lcy)) {
        vx += STEP[nh][0]; vy += STEP[nh][1]; heading = nh;
        corners.push([vx, vy]);
        moved = true;
        break;
      }
    }
    if (!moved) break;
  }
  if (corners.length > 1 && corners[corners.length - 1][0] === sx && corners[corners.length - 1][1] === sy) corners.pop();
  // Drop collinear middle points (keep only heading changes).
  const ring: [number, number][] = [];
  for (let i = 0; i < corners.length; i++) {
    const prev = corners[(i - 1 + corners.length) % corners.length], cur = corners[i], next = corners[(i + 1) % corners.length];
    const cross = (cur[0] - prev[0]) * (next[1] - cur[1]) - (cur[1] - prev[1]) * (next[0] - cur[0]);
    if (cross !== 0) ring.push(cur);
  }
  if (ring.length < 3) return rect;
  return ring.flatMap(p => [p[0], p[1]]);
}

/** Click hit-test against the REAL bbox, expanded by tolerance (pixels). */
export function clickHits(click: { x: number; y: number }, bbox: BBox, tolerance = 14): boolean {
  return click.x >= bbox.x - tolerance && click.x <= bbox.x + bbox.width + tolerance &&
         click.y >= bbox.y - tolerance && click.y <= bbox.y + bbox.height + tolerance;
}

export function scoreGame(found: number, total: number, mistakes: number, hintsUsed: number, elapsedSec: number): number {
  if (total <= 0) return 0;
  const base = (found / total) * 1000;
  return Math.max(0, Math.round(base - mistakes * 50 - hintsUsed * 75 - Math.min(200, elapsedSec * 0.5)));
}
export function accuracy(correct: number, totalClicks: number): number {
  return totalClicks === 0 ? 1 : Math.round((correct / totalClicks) * 1000) / 1000;
}
