import { describe, it, expect, vi, afterEach } from 'vitest';
import sharp from 'sharp';
import { createJob, getJob, runGeneration, QC_AREA_FLOOR } from '../src/lib/server/jobs';
import { getDifferences, getLevelPayload, saveImageLevel } from '../src/lib/serverStore';
import { bufferToDataUrl } from '../src/lib/server/imageOps';
import { selectProviders } from '../src/lib/engine/providers';
import { GET as qcRevealGET } from '../src/app/api/qc-reveal/route';
import type { Difference, PlannedChange, Providers } from '../src/lib/engine/types';

// QC difficulty = inspector level (fake providers only — no real calls):
//  - the floor is a PRIORITY, not a gate: defects whose MEASURED area is below
//    it (easy 0.10% / medium 0.05% of the image; hard: none) are HELD and the
//    next candidate is tried first; once candidates are exhausted, the best
//    held defects deliver as the last resort instead of failing the level;
//  - three consecutive below-floor candidates relax the floor one tier for
//    the rest of the job (logged), so paid calls are not burned on the floor;
//  - easy asks for LARGE defects in the planner prompt and the edit prompts;
//  - the difficulty reaches the QC planner, is stored on the level and is
//    exposed by the QC reveal.

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

// 320x240 = 76800 px: medium floor = 38.4 measured px, easy floor = 76.8 px.
// targetBox 3x3 -> paste ~4x4 (<=16 px, below both floors); 6x6 -> ~8x8
// (~49-64 px, below easy only); 24x18 -> ~31x23 (hundreds of px, above both).
const TINY: PlannedChange = { id: 'tiny', regionId: 'part', type: 'scratch', description: 'tiny scratch on the rim', editPrompt: 'add a scratch', targetBox: { x: 20, y: 20, width: 3, height: 3 }, partConcept: 'outer rim' };
const SMALL: PlannedChange = { id: 'small', regionId: 'part', type: 'scratch', description: 'small scratch on the face', editPrompt: 'add a scratch', targetBox: { x: 20, y: 20, width: 6, height: 6 }, partConcept: 'flat face' };
const BIG: PlannedChange = { id: 'big', regionId: 'part', type: 'scratch', description: 'long scratch across the flange', editPrompt: 'add a scratch', targetBox: { x: 150, y: 110, width: 24, height: 18 }, partConcept: 'flange face' };
const tinyAt = (id: string, x: number): PlannedChange => ({ id, regionId: 'part', type: 'scratch', description: `tiny scratch ${id}`, editPrompt: 'add a scratch', targetBox: { x, y: 20, width: 3, height: 3 }, partConcept: 'outer rim' });

const cropProviders = (candidates: PlannedChange[], seen: { planDifficulty?: string; verifyCalls: number }): Providers => ({
  segmentation: { name: 'fake', isMock: true, segment: async () => [{ id: 'part', bbox: { x: 10, y: 10, width: 300, height: 220 } }] },
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
  it('easy 0.10%, medium 0.05%, hard none', () => {
    expect(QC_AREA_FLOOR).toEqual({ easy: 0.0010, medium: 0.0005, hard: 0 });
  });
});

describe('QC inspector floor in candidate selection (fake providers)', () => {
  it('medium: a below-floor defect is held back and the next candidate replaces it', async () => {
    const seen = { verifyCalls: 0 } as { planDifficulty?: string; verifyCalls: number };
    const job = createJob('qc', true, 1, 'medium');
    await runGeneration(job, { imageDataUrl: await solidPng(320, 240, [120, 120, 120]) }, 1, cropProviders([TINY, BIG], seen));
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
    const diffs = getDifferences(job.levelId!)!;
    expect(diffs).toHaveLength(1);
    expect(diffs[0].description).toBe(BIG.description); // the held tiny one was NOT used — count was reached without it
    expect(seen.verifyCalls).toBe(1); // held BEFORE spending a Spark verify call on it
    expect(seen.planDifficulty).toBe('medium'); // difficulty reached the QC planner
    expect(getLevelPayload(job.levelId!)!.difficulty).toBe('medium'); // stored on the level
  });

  it('medium last resort: with no above-floor candidate left, the best held defect delivers instead of failing', async () => {
    const seen = { verifyCalls: 0 } as { planDifficulty?: string; verifyCalls: number };
    const job = createJob('qc', true, 1, 'medium');
    await runGeneration(job, { imageDataUrl: await solidPng(320, 240, [120, 120, 120]) }, 1, cropProviders([TINY], seen));
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done'); // NOT "no change survived"
    const diffs = getDifferences(job.levelId!)!;
    expect(diffs).toHaveLength(1);
    expect(diffs[0].description).toBe(TINY.description); // the held defect, delivered last
    expect(diffs[0].verification_status).toBe('verified'); // verified at last-resort time
    expect(seen.verifyCalls).toBe(1); // exactly one verify, spent only when the held defect is used
  });

  it('easy: a medium-sized defect (above the medium floor, below easy) is held back too', async () => {
    const seen = { verifyCalls: 0 } as { planDifficulty?: string; verifyCalls: number };
    const job = createJob('qc', true, 1, 'easy');
    await runGeneration(job, { imageDataUrl: await solidPng(320, 240, [120, 120, 120]) }, 1, cropProviders([SMALL, BIG], seen));
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
    const diffs = getDifferences(job.levelId!)!;
    expect(diffs).toHaveLength(1);
    expect(diffs[0].description).toBe(BIG.description);
    expect(seen.verifyCalls).toBe(1);
    expect(seen.planDifficulty).toBe('easy');
    expect(getLevelPayload(job.levelId!)!.difficulty).toBe('easy');
  });

  it('easy last resort: a lone below-floor defect still delivers the level', async () => {
    const seen = { verifyCalls: 0 } as { planDifficulty?: string; verifyCalls: number };
    const job = createJob('qc', true, 1, 'easy');
    await runGeneration(job, { imageDataUrl: await solidPng(320, 240, [120, 120, 120]) }, 1, cropProviders([SMALL], seen));
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
    const diffs = getDifferences(job.levelId!)!;
    expect(diffs).toHaveLength(1);
    expect(diffs[0].description).toBe(SMALL.description);
    expect(seen.verifyCalls).toBe(1);
  });

  it('three consecutive below-floor candidates relax the floor for the rest of the job (logged)', async () => {
    const seen = { verifyCalls: 0 } as { planDifficulty?: string; verifyCalls: number };
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const job = createJob('qc', true, 1, 'medium');
      const candidates = [tinyAt('t1', 20), tinyAt('t2', 60), tinyAt('t3', 100), tinyAt('t4', 140)];
      await runGeneration(job, { imageDataUrl: await solidPng(320, 240, [120, 120, 120]) }, 1, cropProviders(candidates, seen));
      expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
      const diffs = getDifferences(job.levelId!)!;
      expect(diffs).toHaveLength(1);
      expect(diffs[0].description).toBe('tiny scratch t4'); // accepted through the relaxed floor, not the last resort
      expect(seen.verifyCalls).toBe(1); // t1–t3 were held without burning verify calls
      expect(infoSpy.mock.calls.some(args => String(args[0]).includes('floor relaxed'))).toBe(true);
    } finally { infoSpy.mockRestore(); }
  });

  it('hard: no floor — a component-scale defect is accepted', async () => {
    const seen = { verifyCalls: 0 } as { planDifficulty?: string; verifyCalls: number };
    const job = createJob('qc', true, 1, 'hard');
    await runGeneration(job, { imageDataUrl: await solidPng(320, 240, [120, 120, 120]) }, 1, cropProviders([TINY], seen));
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
    const diffs = getDifferences(job.levelId!)!;
    expect(diffs).toHaveLength(1);
    expect(diffs[0].description).toBe(TINY.description);
    expect(seen.planDifficulty).toBe('hard');
    expect(getLevelPayload(job.levelId!)!.difficulty).toBe('hard');
  });
});

describe('QC inspector floor in the one-pass path (fake providers)', () => {
  const RED: [number, number, number] = [230, 30, 30];
  const BIG_DESC = 'a long scratch across the flange face';
  const SMALL_DESC = 'a tiny scratch on the rim edge';
  // 800x600 = 480000 px: easy QC floor = 480 measured px, absolute speck floor
  // = 384 px. A painted 17x17 square measures ~420 px (blur halo included) —
  // between the two, so ONLY the QC inspector floor can hold it. The 40x30
  // square measures ~1400 px, comfortably above. The fake review keys its
  // description on the measured bbox width so the two reviews never dedupe.
  const onePassProviders = (seen: { editPrompt?: string }): Providers => ({
    segmentation: { name: 'fake', isMock: true, segment: async () => [] }, // crop prep unused: one-pass is the path under test
    vision: {
      name: 'fake', isMock: true,
      moderate: async () => ({ ok: true, reason: 'ok' }),
      plan: async () => [],
      verify: async () => ({ ok: true, notes: 'ok' }),
      reviewDifferences: async (pairs: { index: number; bbox: { width: number } }[]) => pairs.map(p => ({ index: p.index, ok: true, description: p.bbox.width >= 25 ? BIG_DESC : SMALL_DESC, type: 'scratch', notes: 'fake review ok', sameChangeAs: -1 })),
    },
    imageEdit: {
      name: 'fake', isMock: true,
      editMaskedRegion: paintPatternBlue, generateScene: async () => ({ image: '' }),
      editFullImage: async (imageRef: string, prompt: string) => {
        seen.editPrompt = prompt;
        return paintRects(imageRef, [
          { x: 40, y: 40, width: 17, height: 17, rgb: RED },
          { x: 400, y: 300, width: 40, height: 30, rgb: RED },
        ]);
      },
    },
  });
  const isRed = (data: Buffer, width: number, x: number, y: number) => {
    const o = (y * width + x) * 3; return data[o] > 200 && data[o + 1] < 80 && data[o + 2] < 80;
  };
  // Sample points come from the RETURNED bboxes (alignment compensation can
  // shift the painted rects by a few dozen px — the bboxes are the truth).
  const bboxCenterIsRed = (d: Difference, data: Buffer, width: number) =>
    isRed(data, width, Math.round(d.bbox.x + d.bbox.width / 2), Math.round(d.bbox.y + d.bbox.height / 2));
  const countRedOutside = (data: Buffer, width: number, height: number, box: Difference['bbox'], margin: number) => {
    let n = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (x >= box.x - margin && x < box.x + box.width + margin && y >= box.y - margin && y < box.y + box.height + margin) continue;
      if (isRed(data, width, x, y)) n++;
    }
    return n;
  };

  it('easy, count not reached otherwise: the held below-floor defect delivers as last resort', async () => {
    const seen: { editPrompt?: string } = {};
    const job = createJob('qc', true, 2, 'easy');
    await runGeneration(job, { imageDataUrl: await solidPng(800, 600, [120, 120, 120]) }, 2, onePassProviders(seen));
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
    const diffs = getDifferences(job.levelId!)!;
    expect(diffs).toHaveLength(2); // the below-floor defect was NOT discarded — it completed the level
    expect(diffs[0].description).toBe(BIG_DESC); // above-floor first
    expect(diffs[1].description).toBe(SMALL_DESC); // held one, via the last resort
    const payload = getLevelPayload(job.levelId!)!;
    expect(payload.difficulty).toBe('easy');
    expect(payload.notice).toBeFalsy(); // full count — no partial-level notice
    const { data, width } = await rawPixels(payload.modified);
    expect(bboxCenterIsRed(diffs[0], data, width)).toBe(true);
    expect(bboxCenterIsRed(diffs[1], data, width)).toBe(true); // the held defect's pixels ARE published
    expect(seen.editPrompt).toContain('a large, clearly visible defect covering a significant part of the surface, not a small mark');
  });

  it('easy, count reached: the held below-floor defect stays unpublished', async () => {
    const seen: { editPrompt?: string } = {};
    const job = createJob('qc', true, 1, 'easy');
    await runGeneration(job, { imageDataUrl: await solidPng(800, 600, [120, 120, 120]) }, 1, onePassProviders(seen));
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
    const diffs = getDifferences(job.levelId!)!;
    expect(diffs).toHaveLength(1);
    expect(diffs[0].description).toBe(BIG_DESC);
    const { data, width, height } = await rawPixels(getLevelPayload(job.levelId!)!.modified);
    expect(bboxCenterIsRed(diffs[0], data, width)).toBe(true);
    expect(countRedOutside(data, width, height, diffs[0].bbox, 4)).toBe(0); // held ≠ published when not needed
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

  it('easy asks for large defects, not small marks; medium and hard do not', async () => {
    const LARGE = 'a large, clearly visible defect covering a significant part of the surface, not a small mark';
    expect(await capturePlanPrompt('qc', 'easy')).toContain(LARGE);
    expect(await capturePlanPrompt('qc', 'medium')).not.toContain(LARGE);
    expect(await capturePlanPrompt('qc', 'hard')).not.toContain(LARGE);
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
