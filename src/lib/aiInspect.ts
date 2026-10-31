import { clickHits } from './engine/geometry';
import type { Difference, AiFinding } from './engine/types';

export type { AiFinding };

/** Challenge the AI inspector: Muse Spark inspects a level's target image and
 *  returns findings; the server validates them with EXACTLY the click rule a
 *  human plays by (center of the box inside the real bbox, 16 px tolerance —
 *  see /api/validate-click), so human and AI compete under identical rules. */

export type AiInspectMode = 'no-reference' | 'with-reference';

export interface ValidatedFinding extends AiFinding {
  matched: boolean;
  differenceId?: string;
  /** What the matched difference actually is (QC: classified ?? planned type; game: description). */
  truthLabel?: string;
}

export const truthLabelOf = (d: Difference, kind: 'qc' | 'game'): string =>
  kind === 'qc' ? (d.classifiedType ?? d.type) : d.description;

/** Greedy by confidence: each real difference can be claimed by at most one
 *  finding; a second box on the same difference counts as a false positive. */
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
    const cx = (f.bbox_normalized.x + f.bbox_normalized.width / 2) * width;
    const cy = (f.bbox_normalized.y + f.bbox_normalized.height / 2) * height;
    const hit = diffs.find(d => !claimed.has(d.id) && clickHits({ x: cx, y: cy }, d.bbox, 16));
    if (!hit) return { ...f, matched: false };
    claimed.add(hit.id);
    return { ...f, matched: true, differenceId: hit.id, truthLabel: truthLabelOf(hit, kind) };
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
