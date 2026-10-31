import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { validateAiFindings, applyDetectability, challengeVerdict } from '../src/lib/aiInspect';
import { hitChallengeRateLimit, CHALLENGE_LIMIT_MAX } from '../src/lib/server/rateLimit';
import { saveImageLevel, getDifferences } from '../src/lib/serverStore';
import { bufferToDataUrl } from '../src/lib/server/imageOps';
import { POST as aiInspectPOST } from '../src/app/api/ai-inspect/route';
import type { Difference } from '../src/lib/engine/types';

// Challenge the AI inspector (offline — MOCK/fake data only, no paid calls):
// Spark findings are validated with the box-overlap rule (16 px expansion /
// either center inside), the verdict compares coverage then speed,
// detectability accumulates, and the route enforces the
// 10-challenges/hour/IP limit without any access code.

const diff = (id: string, bbox: Difference['bbox'], over: Partial<Difference> = {}): Difference => ({
  id, type: 'scratch', description: `desc ${id}`, bbox,
  bbox_normalized: { x: bbox.x / 1000, y: bbox.y / 1000, width: bbox.width / 1000, height: bbox.height / 1000 },
  mask_url: null, severity: 'medium', verification_status: 'verified', verifier_notes: '', ...over,
});
const box = (cx: number, cy: number, s = 0.02) => ({ x: cx - s / 2, y: cy - s / 2, width: s, height: s });

const A = diff('A', { x: 100, y: 100, width: 100, height: 100 });
const B = diff('B', { x: 600, y: 600, width: 80, height: 80 }, { type: 'dent', classifiedType: 'crack' });

describe('validateAiFindings (overlap rule: box expanded 16px overlaps, or either center inside)', () => {
  it('matches boxes overlapping the real bbox (incl. 16px tolerance), counts the rest as false positives', () => {
    const r = validateAiFindings([
      { bbox_normalized: box(0.15, 0.15), label: 'scratch', confidence: 0.9 },   // center of A
      { bbox_normalized: box(0.9, 0.1), label: 'crack', confidence: 0.8 },       // empty corner -> FP
      { bbox_normalized: box(0.16, 0.16), label: 'scratch', confidence: 0.7 },   // A again -> duplicate = FP
      { bbox_normalized: box(0.59, 0.64), label: 'dent', confidence: 0.6 },      // 10px left of B: within tolerance
    ], [A, B], 1000, 1000, 'qc');
    expect(r.matchedIds.sort()).toEqual(['A', 'B']);
    expect(r.falsePositives).toBe(2);
    expect(r.missed).toEqual([]);
    // QC truth label prefers the classified type over the planned one.
    expect(r.findings.find(f => f.differenceId === 'B')?.truthLabel).toBe('crack');
  });
  it('reports what Spark missed, with game descriptions as labels', () => {
    const r = validateAiFindings([{ bbox_normalized: box(0.15, 0.15), label: 'x', confidence: 1 }], [A, B], 1000, 1000, 'game');
    expect(r.missed).toEqual([{ id: 'B', label: 'desc B' }]);
  });
  it('counts a finding whose box overlaps the real one even when its center lands beyond the old tolerance (the logo case)', () => {
    // Real A spans px 100–200; Spark's box (185,185,90,90) overlaps its corner but
    // its center (230,230) sits 30px past A's edge — the old center rule missed it.
    const r = validateAiFindings([
      { bbox_normalized: { x: 0.185, y: 0.185, width: 0.09, height: 0.09 }, label: 'logo added', confidence: 0.9 },
    ], [A], 1000, 1000, 'game');
    expect(r.matchedIds).toEqual(['A']);
    expect(r.falsePositives).toBe(0);
    // Calibration: Spark box vs nearest real box + center distance are attached.
    expect(r.findings[0].sparkBoxPx).toEqual({ x: 185, y: 185, width: 90, height: 90 });
    expect(r.findings[0].nearestLabel).toBe('desc A');
    expect(r.findings[0].centerDistancePx).toBe(113); // (230,230) vs A center (150,150)
  });
});

describe('detectability accumulation', () => {
  it('hits/attempts over challenges, with the modes Spark found it in', () => {
    const d = diff('D', { x: 0, y: 0, width: 10, height: 10 });
    applyDetectability([d], ['D'], 'no-reference');
    expect(d.detectability).toBe(1); expect(d.aiFoundModes).toEqual(['no-reference']);
    applyDetectability([d], [], 'with-reference');
    expect(d.detectability).toBe(0.5); expect(d.aiChallenges).toBe(2); expect(d.aiHits).toBe(1);
    applyDetectability([d], ['D'], 'with-reference');
    expect(d.detectability).toBeCloseTo(2 / 3); expect(d.aiFoundModes).toEqual(['no-reference', 'with-reference']);
  });
});

describe('challengeVerdict', () => {
  const side = (foundIds: string[], timeSec: number, falsePositives = 0) => ({ foundIds, falsePositives, timeSec });
  it('same coverage: faster side wins, with the spec wording', () => {
    expect(challengeVerdict(side(['A', 'B'], 30), side(['A', 'B'], 34))).toBe('You beat the AI inspector by 4 s');
    expect(challengeVerdict(side(['A', 'B'], 40), side(['A', 'B'], 34))).toBe('The AI inspector beat you by 6 s');
    expect(challengeVerdict(side(['A'], 10), side(['A'], 10))).toBe('Dead heat — same defects, same time');
  });
  it('coverage beats speed: whoever found what the other missed', () => {
    expect(challengeVerdict(side(['A'], 5), side(['A', 'B', 'C'], 60))).toBe('The AI inspector found 2 defects you missed');
    expect(challengeVerdict(side(['A', 'B'], 60), side(['A'], 5))).toBe('You found 1 defect the AI inspector missed');
  });
});

describe('challenge rate limit (10/hour/IP, no access code)', () => {
  it('allows 10 and blocks the 11th for the same IP only', () => {
    for (let i = 0; i < CHALLENGE_LIMIT_MAX; i++) expect(hitChallengeRateLimit('198.51.100.7').ok).toBe(true);
    expect(hitChallengeRateLimit('198.51.100.7').ok).toBe(false);
    expect(hitChallengeRateLimit('198.51.100.8').ok).toBe(true);
  });
});

describe('POST /api/ai-inspect (MOCK provider — finds nothing, never a fake find)', () => {
  it('validates the level, defaults to no-reference, accumulates detectability, then 429s after 10', async () => {
    const img = bufferToDataUrl(await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 120, g: 120, b: 120 } } }).png().toBuffer());
    const levelId = saveImageLevel({
      differences: [diff('A', { x: 4, y: 4, width: 10, height: 10 }), diff('B', { x: 40, y: 40, width: 10, height: 10 })],
      original: img, modified: img, width: 64, height: 64, isMock: false, mode: 'qc',
    });
    const call = () => aiInspectPOST(new Request('http://localhost/api/ai-inspect', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '10.7.7.7' },
      body: JSON.stringify({ levelId }),
    }));
    const first = await (await call()).json();
    expect(first.mode).toBe('no-reference'); // default
    expect(first.total).toBe(2); expect(first.matchedCount).toBe(0); expect(first.falsePositives).toBe(0);
    expect(first.findings).toEqual([]); expect(first.missed).toHaveLength(2);
    expect(typeof first.latencyMs).toBe('number');
    expect(first.detectability).toEqual([
      { id: 'A', detectability: 0, aiChallenges: 1, aiHits: 0, aiFoundModes: [] },
      { id: 'B', detectability: 0, aiChallenges: 1, aiHits: 0, aiFoundModes: [] },
    ]);
    expect(getDifferences(levelId)?.[0].aiChallenges).toBe(1);
    for (let i = 0; i < 9; i++) expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(429); // 11th challenge within the hour
  });
  it('404s an unknown level and echoes with-reference mode', async () => {
    const missing = await aiInspectPOST(new Request('http://localhost/api/ai-inspect', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '10.7.7.9' },
      body: JSON.stringify({ levelId: 'nope' }),
    }));
    expect(missing.status).toBe(404);
  });
});
