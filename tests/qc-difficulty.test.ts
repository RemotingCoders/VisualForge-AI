import { describe, it, expect, vi, afterEach } from 'vitest';
import sharp from 'sharp';
import { createJob, getJob, runGeneration, QC_AREA_FLOOR } from '../src/lib/server/jobs';
import { getDifferences, getLevelPayload, saveImageLevel } from '../src/lib/serverStore';
import { bufferToDataUrl } from '../src/lib/server/imageOps';
import { selectProviders } from '../src/lib/engine/providers';
import { GET as qcRevealGET } from '../src/app/api/qc-reveal/route';
import type { Difference, PlannedChange, Providers } from '../src/lib/engine/types';

// QC difficulty = inspector level (fake providers only — no real calls):
//  - easy/medium discard defects whose MEASURED area is below the floor
//    (0.25% / 0.12% of the image) and the next candidate replaces them;
//  - hard has no floor (component-scale defects are accepted);
//  - the difficulty reaches the QC planner, whose prompt (easy/medium) demands
//    defects clearly visible at normal viewing size on the largest surfaces;
//  - the difficulty is stored on the level and exposed by the QC reveal.

const solidPng = async (w: number, h: number, rgb: [number, number, number]) =>
  bufferToDataUrl(await sharp({ create: { width: w, height: h, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer());
const rawPixels = async (dataUrl: string) => {
  const { data, info } = await sharp(Buffer.from(dataUrl.split(',')[1], 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
};
const paintRects = async (imageRef: string, rects: { x: number; y: number; width: number; height: number; rgb: [number, number, number] }[]) => {
  const { data, width, height } = await rawPixels(imageRef);
  const out = Buffer.from(data);
  for (const r of rects) for (let y = r.y; y < r.y + r.height; y++) for (let x = r.x; x < r.x + r.width; x++) {
    const o = (y * width + x) * 3; out[o] = r.rgb[0]; out[o + 1] = r.rgb[1]; out[o + 2] = r.rgb[2];
  }
  return bufferToDataUrl(await sharp(out, { raw: { width, height, channels: 3 } }).png().toBuffer());
};
/** Fake Muse: paints solid blue exactly inside the paste box it is given (the box
 *  derived from the candidate's targetBox), leaves everything else untouched. */
const paintPatternBlue = async (imageRef: string, region?: { bbox: { x: number; y: number; width: number; height: number } }) => {
  const { data, info } = await sharp(Buffer.from(imageRef.split(',')[1], 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.from(data);
  const b = region?.bbox ?? { x: 12, y: 12, width: Math.max(1, info.width - 24), height: Math.max(1, info.height - 24) };
  for (let y = Math.max(0, b.y); y < Math.min(info.height, b.y + b.height); y++) for (let x = Math.max(0, b.x); x < Math.min(info.width, b.x + b.width); x++) {
    const o = (y * info.width + x) * 3; out[o] = 30; out[o + 1] = 30; out[o + 2] = 220;
  }
  return bufferToDataUrl(await sharp(out, { raw: { width: info.width, height: info.height, channels: 3 } }).png().toBuffer());
};

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

// 200x160 = 32000 px: medium floor = 38.4 measured px, easy floor = 80 px.
// targetBox 3x3 -> paste ~4x4 (<=16 px, below both floors); 6x6 -> ~8x8 (<=64 px,
// below easy only); 24x18 -> ~31x23 (hundreds of px, above both floors).
const TINY: PlannedChange = { id: 'tiny', regionId: 'part', type: 'scratch', description: 'tiny scratch on the rim', editPrompt: 'add a scratch', targetBox: { x: 20, y: 20, width: 3, height: 3 }, partConcept: 'outer rim' };
const SMALL: PlannedChange = { id: 'small', regionId: 'part', type: 'scratch', description: 'small scratch on the face', editPrompt: 'add a scratch', targetBox: { x: 20, y: 20, width: 6, height: 6 }, partConcept: 'flat face' };
const BIG: PlannedChange = { id: 'big', regionId: 'part', type: 'scratch', description: 'long scratch across the flange', editPrompt: 'add a scratch', targetBox: { x: 90, y: 60, width: 24, height: 18 }, partConcept: 'flange face' };

const cropProviders = (candidates: PlannedChange[], seen: { planDifficulty?: string; verifyCalls: number }): Providers => ({
  segmentation: { name: 'fake', isMock: true, segment: async () => [{ id: 'part', bbox: { x: 10, y: 10, width: 180, height: 140 } }] },
  vision: {
    name: 'fake', isMock: true,
    moderate: async () => ({ ok: true, reason: 'ok' }),
    plan: async (_img: string, _regions: unknown, _mode: string, _count: number, difficulty?: string) => { seen.planDifficulty = difficulty; return candidates; },
    verify: async () => { seen.verifyCalls++; return { ok: true, notes: 'ok' }; },
  },
  // No editFullImage: one-pass unavailable, so the crop pipeline must deliver.
  imageEdit: { name: 'fake', isMock: true, editMaskedRegion: paintPatternBlue, generateScene: async () => ({ image: '' }) },
});

describe('QC area floor constants', () => {
  it('easy 0.25%, medium 0.12%, hard none', () => {
    expect(QC_AREA_FLOOR).toEqual({ easy: 0.0025, medium: 0.0012, hard: 0 });
  });
});

describe('QC inspector floor in candidate selection (fake providers)', () => {
  it('medium: a below-floor defect is discarded and the next candidate replaces it', async () => {
    const seen = { verifyCalls: 0 } as { planDifficulty?: string; verifyCalls: number };
    const job = createJob('qc', true, 1, 'medium');
    await runGeneration(job, { imageDataUrl: await solidPng(200, 160, [120, 120, 120]) }, 1, cropProviders([TINY, BIG], seen));
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
    const diffs = getDifferences(job.levelId!)!;
    expect(diffs).toHaveLength(1);
    expect(diffs[0].description).toBe(BIG.description); // the tiny one never landed
    expect(seen.verifyCalls).toBe(1); // discarded BEFORE spending a Spark verify call
    expect(seen.planDifficulty).toBe('medium'); // difficulty reached the QC planner
    expect(getLevelPayload(job.levelId!)!.difficulty).toBe('medium'); // stored on the level
  });

  it('easy: a medium-sized defect (above the medium floor, below easy) is discarded too', async () => {
    const seen = { verifyCalls: 0 } as { planDifficulty?: string; verifyCalls: number };
    const job = createJob('qc', true, 1, 'easy');
    await runGeneration(job, { imageDataUrl: await solidPng(200, 160, [120, 120, 120]) }, 1, cropProviders([SMALL, BIG], seen));
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
    const diffs = getDifferences(job.levelId!)!;
    expect(diffs).toHaveLength(1);
    expect(diffs[0].description).toBe(BIG.description);
    expect(seen.verifyCalls).toBe(1);
    expect(seen.planDifficulty).toBe('easy');
    expect(getLevelPayload(job.levelId!)!.difficulty).toBe('easy');
  });

  it('hard: no floor — a component-scale defect is accepted', async () => {
    const seen = { verifyCalls: 0 } as { planDifficulty?: string; verifyCalls: number };
    const job = createJob('qc', true, 1, 'hard');
    await runGeneration(job, { imageDataUrl: await solidPng(200, 160, [120, 120, 120]) }, 1, cropProviders([TINY], seen));
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
    const diffs = getDifferences(job.levelId!)!;
    expect(diffs).toHaveLength(1);
    expect(diffs[0].description).toBe(TINY.description);
    expect(seen.planDifficulty).toBe('hard');
    expect(getLevelPayload(job.levelId!)!.difficulty).toBe('hard');
  });
});

describe('QC inspector floor in the one-pass path (fake providers)', () => {
  it('medium: a below-floor painted defect is never published; the big one is', async () => {
    const RED: [number, number, number] = [230, 30, 30];
    const descriptions = ['a long scratch across the flange face', 'a tiny scratch on the rim'];
    const fake: Providers = {
      segmentation: { name: 'fake', isMock: true, segment: async () => [] }, // crop prep unused: one-pass is the path under test
      vision: {
        name: 'fake', isMock: true,
        moderate: async () => ({ ok: true, reason: 'ok' }),
        plan: async () => [],
        verify: async () => ({ ok: true, notes: 'ok' }),
        reviewDifferences: async (pairs: { index: number }[]) => pairs.map(p => ({ index: p.index, ok: true, description: descriptions[p.index] ?? descriptions[0], type: 'scratch', notes: 'fake review ok', sameChangeAs: -1 })),
      },
      imageEdit: {
        name: 'fake', isMock: true,
        editMaskedRegion: paintPatternBlue, generateScene: async () => ({ image: '' }),
        // 400x320 = 128000 px: medium floor = 154 measured px, absolute speck floor
        // = 102 px. An 8x8 painted square measures ~125 px (blur halo included) —
        // between the two, so ONLY the QC inspector floor can discard it. The
        // 30x20 square measures ~600 px, comfortably above. Distinct descriptions
        // keep the description dedupe out of the way: the floor must do the work.
        editFullImage: async (imageRef: string) => paintRects(imageRef, [
          { x: 30, y: 30, width: 8, height: 8, rgb: RED },
          { x: 240, y: 180, width: 30, height: 20, rgb: RED },
        ]),
      },
    };
    const job = createJob('qc', true, 2, 'medium');
    await runGeneration(job, { imageDataUrl: await solidPng(400, 320, [120, 120, 120]) }, 2, fake);
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
    const diffs = getDifferences(job.levelId!)!;
    expect(diffs).toHaveLength(1); // asked for 2: the below-floor one was discarded, not counted
    expect(diffs[0].description).toBe(descriptions[0]);
    expect(diffs[0].bbox.x).toBeLessThanOrEqual(252); // the big square (240..270), ± alignment slack
    expect(diffs[0].bbox.x + diffs[0].bbox.width).toBeGreaterThanOrEqual(258);
    // The below-floor defect's pixels never reached the published image:
    const payload = getLevelPayload(job.levelId!)!;
    expect(payload.difficulty).toBe('medium');
    expect(payload.notice).toBe('Generated 1 of 2 defects'); // partial QC level — the discard is visible
    const { data, width } = await rawPixels(payload.modified);
    const px = (x: number, y: number) => { const o = (y * width + x) * 3; return [data[o], data[o + 1], data[o + 2]] as const; };
    const [sr, sg, sb] = px(34, 34); // center of the small painted square
    expect(sr > 200 && sg < 80 && sb < 80).toBe(false);
    const [br, bg, bb] = px(255, 190); // center of the big painted square
    expect(br > 200 && bg < 80 && bb < 80).toBe(true);
  });
});

describe('QC planner prompt rule (fake fetch — no real call)', () => {
  const capturePlanPrompt = async (mode: 'qc' | 'game', difficulty: 'easy' | 'medium' | 'hard') => {
    vi.stubEnv('META_REAL_CALLS_ENABLED', 'true');
    vi.stubEnv('MODEL_API_KEY', 'test-key');
    let prompt = '';
    const fetchFn = (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { input: { content: { type: string; text?: string }[] }[] };
      prompt = body.input[0].content.find(c => c.type === 'input_text')?.text ?? '';
      return { ok: true, status: 200, json: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ changes: [] }) }] }] }) } as unknown as Response;
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchFn);
    const { providers } = selectProviders({ AI_PROVIDER: 'meta' });
    await providers.vision.plan('data:image/png;base64,AA', [{ id: 'part', bbox: { x: 0, y: 0, width: 100, height: 80 } }], mode, 2, difficulty);
    return prompt;
  };

  it('easy and medium demand clearly visible defects on the largest surfaces; hard and game do not', async () => {
    const RULE = 'defects must be clearly visible at normal viewing size, on the largest surfaces of the part';
    expect(await capturePlanPrompt('qc', 'easy')).toContain(RULE);
    expect(await capturePlanPrompt('qc', 'medium')).toContain(RULE);
    expect(await capturePlanPrompt('qc', 'hard')).not.toContain(RULE);
    expect(await capturePlanPrompt('game', 'easy')).not.toContain(RULE);
  });
});

describe('QC difficulty on the level + reveal', () => {
  const diff = (id: string): Difference => ({
    id, type: 'scratch', description: `${id} defect`, bbox: { x: 10, y: 10, width: 20, height: 12 },
    bbox_normalized: { x: 0.05, y: 0.06, width: 0.1, height: 0.075 }, mask_url: null,
    severity: 'medium', verification_status: 'verified', verifier_notes: 'ok',
  });
  const img = 'data:image/png;base64,iVBORw0KGgo=';

  it('is stored by saveImageLevel and exposed by /api/qc-reveal', async () => {
    const id = saveImageLevel({ differences: [diff('q1')], original: img, modified: img, width: 200, height: 160, isMock: true, mode: 'qc', difficulty: 'easy' });
    expect(getLevelPayload(id)!.difficulty).toBe('easy');
    const res = await qcRevealGET(new Request(`http://localhost/api/qc-reveal?levelId=${id}`));
    expect(res.status).toBe(200);
    expect((await res.json()).difficulty).toBe('easy'); // "Inspector level: Easy"
  });

  it('levels saved without a difficulty reveal null — never a fabricated level', async () => {
    const id = saveImageLevel({ differences: [diff('q1')], original: img, modified: img, width: 200, height: 160, isMock: true, mode: 'qc' });
    const res = await qcRevealGET(new Request(`http://localhost/api/qc-reveal?levelId=${id}`));
    expect(res.status).toBe(200);
    expect((await res.json()).difficulty).toBeNull();
  });
});
