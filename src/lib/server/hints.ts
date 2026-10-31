import type { Difference } from '../engine/types';

/** Capability 2 — hint targeting (pure, unit-testable): the next hint goes to the
 *  PENDING difference with the LOWEST Spark difficulty (ties keep level order) that
 *  still has hints left. When every pending difference has used all its hints, there
 *  is nothing more to give. `used` maps differenceId -> hints already delivered. */
export interface NextHint { differenceId: string; hint: string; hintNumber: number; totalHints: number; difficulty: number }

const clampDifficulty = (n: number) => Math.min(5, Math.max(1, Math.round(n)));

/** Difficulty for differences that never got a Spark rating (demo levels, pre-capability
 *  levels, failed hint call): estimated from the measured bbox area — smaller = harder. */
export function fallbackDifficulty(d: Difference): number {
  if (d.difficulty) return clampDifficulty(d.difficulty);
  const area = d.bbox_normalized.width * d.bbox_normalized.height;
  return area > 0.04 ? 2 : area > 0.015 ? 3 : area > 0.005 ? 4 : 5;
}

const AREA_WORDS = (cx: number, cy: number) =>
  `${cy < 0.34 ? 'top' : cy > 0.67 ? 'bottom' : 'middle'}${cx < 0.17 ? ' far-left' : cx < 0.4 ? '-left' : cx > 0.83 ? ' far-right' : cx > 0.6 ? '-right' : '-center'}`.replace('middle-center', 'center');

/** Positional fallback hints when a difference has no Spark hints: vague area → quadrant
 *  → the description itself as the last resort (same progression contract). */
export function fallbackHints(d: Difference): string[] {
  if (d.hints?.length) return d.hints;
  const b = d.bbox_normalized;
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  const zone = AREA_WORDS(cx, cy);
  const vertical = cy < 0.4 ? 'upper' : cy > 0.6 ? 'lower' : 'middle';
  const horizontal = cx < 0.4 ? 'left' : cx > 0.6 ? 'right' : 'center';
  return [
    `Look at the ${vertical} ${horizontal === 'center' ? 'part' : `${horizontal} side`} of the image.`,
    `Focus on the ${zone} area and compare both images element by element.`,
    d.description,
  ];
}

export function pickNextHint(differences: Difference[], foundIds: string[], used: Record<string, number>): NextHint | null {
  const found = new Set(foundIds);
  const pending = differences
    .map((d, order) => ({ d, order }))
    .filter(({ d }) => !found.has(d.id))
    .sort((a, b) => fallbackDifficulty(a.d) - fallbackDifficulty(b.d) || a.order - b.order);
  for (const { d } of pending) {
    const hints = fallbackHints(d);
    const n = used[d.id] ?? 0;
    if (n < hints.length) return { differenceId: d.id, hint: hints[n], hintNumber: n + 1, totalHints: hints.length, difficulty: fallbackDifficulty(d) };
  }
  return null;
}
