import type { BBox, Difference, AiFinding } from './engine/types';

export type { AiFinding };

/** Challenge the AI inspector: Muse Spark inspects a level's target image and
 *  returns findings; the server validates them against the real difference
 *  boxes. A finding hits when its box, expanded 16 px, overlaps an unclaimed
 *  real bbox — or when the center of either box falls inside the other (Spark
 *  boxes sit tight on a change and their center alone kept missing real boxes
 *  it visibly overlapped; field case: a found logo went uncounted). Every
 *  finding is also logged against its NEAREST real box with the center
 *  distance, for calibration. */

export type AiInspectMode = 'no-reference' | 'with-reference';

export interface ValidatedFinding extends AiFinding {
  matched: boolean;
  differenceId?: string;
  /** What the matched difference actually is (QC: classified ?? planned type; game: description). */
  truthLabel?: string;
  /** Calibration (px, image coordinates): Spark's box and its nearest real box. */
  sparkBoxPx: BBox;
  nearestBoxPx?: BBox;
  nearestLabel?: string;
  centerDistancePx?: number;
}

export const truthLabelOf = (d: Difference, kind: 'qc' | 'game'): string =>
  kind === 'qc' ? (d.classifiedType ?? d.type) : d.description;

const TOLERANCE_PX = 16;
const expandBox = (b: BBox, m: number): BBox => ({ x: b.x - m, y: b.y - m, width: b.width + 2 * m, height: b.height + 2 * m });
const boxesOverlap = (a: BBox, b: BBox): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const centerOf = (b: BBox): { x: number; y: number } => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const pointInBox = (p: { x: number; y: number }, b: BBox): boolean => p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;

/** Greedy by confidence: each real difference can be claimed by at most one
 *  finding (the nearest qualifying one wins); a second box on the same
 *  difference counts as a false positive, and a finding counts at most once. */
export function validateAiFindings(
  findings: AiFinding[],
  diffs: Difference[],
  width: number,
  height: number,
  kind: 'qc' | 'game',
): { findings: ValidatedFinding[]; matchedIds: string[]; falsePositives: number; missed: { id: string; label: string }[] } {
  const claimed = new Set<string>();
  const ordered = [...findings].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  const out: ValidatedFinding[] = ordered.map(f => {
    const spark: BBox = {
      x: Math.round(f.bbox_normalized.x * width), y: Math.round(f.bbox_normalized.y * height),
      width: Math.round(f.bbox_normalized.width * width), height: Math.round(f.bbox_normalized.height * height),
    };
    const sc = centerOf(spark);
    let nearest: { d: Difference; dist: number } | undefined;
    for (const d of diffs) {
      const dc = centerOf(d.bbox);
      const dist = Math.hypot(sc.x - dc.x, sc.y - dc.y);
      if (!nearest || dist < nearest.dist) nearest = { d, dist };
    }
    const expanded = expandBox(spark, TOLERANCE_PX);
    const candidates = diffs
      .filter(d => !claimed.has(d.id) && (boxesOverlap(expanded, d.bbox) || pointInBox(sc, d.bbox) || pointInBox(centerOf(d.bbox), spark)))
      .sort((a, b) => {
        const ca = centerOf(a.bbox); const cb = centerOf(b.bbox);
        return Math.hypot(sc.x - ca.x, sc.y - ca.y) - Math.hypot(sc.x - cb.x, sc.y - cb.y);
      });
    const calibration = {
      sparkBoxPx: spark,
      nearestBoxPx: nearest?.d.bbox,
      nearestLabel: nearest ? truthLabelOf(nearest.d, kind) : undefined,
      centerDistancePx: nearest ? Math.round(nearest.dist) : undefined,
    };
    const hit = candidates[0];
    if (!hit) return { ...f, ...calibration, matched: false };
    claimed.add(hit.id);
    return { ...f, ...calibration, matched: true, differenceId: hit.id, truthLabel: truthLabelOf(hit, kind) };
  });
  return {
    findings: out,
    matchedIds: [...claimed],
    falsePositives: out.filter(f => !f.matched).length,
    missed: diffs.filter(d => !claimed.has(d.id)).map(d => ({ id: d.id, label: truthLabelOf(d, kind) })),
  };
}

/** Accumulates Spark detectability per difference over challenges: each challenge
 *  counts as one attempt; detectability = hits / attempts (0..1), plus the modes
 *  in which Spark has ever found it. Mutates the difference records in place. */
export function applyDetectability(diffs: Difference[], matchedIds: string[], mode: AiInspectMode): void {
  const hit = new Set(matchedIds);
  for (const d of diffs) {
    d.aiChallenges = (d.aiChallenges ?? 0) + 1;
    if (hit.has(d.id)) {
      d.aiHits = (d.aiHits ?? 0) + 1;
      d.aiFoundModes = [...new Set([...(d.aiFoundModes ?? []), mode])];
    }
    d.detectability = (d.aiHits ?? 0) / d.aiChallenges;
  }
}

export interface ChallengeSide { foundIds: string[]; falsePositives: number; timeSec: number }

/** Final compared verdict. Coverage first (who found things the other missed),
 *  then speed when both found exactly the same set. */
export function challengeVerdict(human: ChallengeSide, ai: ChallengeSide, unit = 'defects', aiName = 'AI inspector'): string {
  const humanSet = new Set(human.foundIds);
  const aiSet = new Set(ai.foundIds);
  const aiOnly = ai.foundIds.filter(id => !humanSet.has(id)).length;
  const humanOnly = human.foundIds.filter(id => !aiSet.has(id)).length;
  const noun = (n: number) => (n === 1 ? unit.replace(/s$/, '') : unit);
  if (aiOnly > 0) return `The ${aiName} found ${aiOnly} ${noun(aiOnly)} you missed`;
  if (humanOnly > 0) return `You found ${humanOnly} ${noun(humanOnly)} the ${aiName} missed`;
  const diff = Math.round(Math.abs(human.timeSec - ai.timeSec));
  if (diff < 1) return `Dead heat — same ${unit}, same time`;
  return human.timeSec < ai.timeSec ? `You beat the ${aiName} by ${diff} s` : `The ${aiName} beat you by ${diff} s`;
}
