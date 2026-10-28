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
