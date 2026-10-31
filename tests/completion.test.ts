import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { createJob, getJob, runGeneration } from '../src/lib/server/jobs';
import { getDifferences } from '../src/lib/serverStore';
import { bufferToDataUrl } from '../src/lib/server/imageOps';
import type { Providers } from '../src/lib/engine/types';

// Completion guarantee (game mode): a level NEVER ships with fewer differences
// than requested. If one-pass + crop candidates run out short, the generator
// spends ONE more full-image Muse call asking only for the missing differences,
// then a fresh segmentation + plan round; still short -> the job FAILS loudly
// instead of delivering a short level (field case: asked 5, playable 4).
// ALL offline with fake providers — no paid calls.

const solidPng = async (w: number, h: number, rgb: [number, number, number]) =>
  bufferToDataUrl(await sharp({ create: { width: w, height: h, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer());

const rawPixels = async (dataUrl: string) => {
  const { data, info } = await sharp(Buffer.from(dataUrl.split(',')[1], 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
};

describe('completion guarantee (fake providers)', () => {
  it('a second one-pass call adds ONLY the missing difference when crops cannot top up', async () => {
    let fullCalls = 0;
    const editFullImage = async (imageRef: string) => {
      fullCalls++;
      const { data, width, height } = await rawPixels(imageRef);
      const out = Buffer.from(data);
      const paint = (x0: number, y0: number, r: number, g: number, b: number) => {
        for (let y = y0; y < y0 + 12; y++) for (let x = x0; x < x0 + 14; x++) { const o = (y * width + x) * 3; out[o] = r; out[o + 1] = g; out[o + 2] = b; }
      };
      // pass 1 paints the red square; the completion pass paints a blue one elsewhere.
      if (fullCalls === 1) paint(60, 50, 230, 30, 30); else paint(10, 10, 30, 30, 230);
      return bufferToDataUrl(await sharp(out, { raw: { width, height, channels: 3 } }).png().toBuffer());
    };
    const fake: Providers = {
      // The only SAM region sits exactly ON the pass-1 difference, so the crop
      // candidate is discarded for overlapping it — crops deliver 0.
      segmentation: { name: 'fake', isMock: true, segment: async () => [{ id: 'r1', bbox: { x: 60, y: 50, width: 14, height: 12 } }] },
      vision: {
        name: 'fake', isMock: true,
        moderate: async () => ({ ok: true, reason: 'ok' }),
        plan: async () => [{ id: 'c1', regionId: 'r1', type: 'remove object', description: 'the square disappeared', editPrompt: 'remove it' }],
        verify: async () => ({ ok: true, notes: 'ok' }),
        reviewDifferences: async (pairs: { index: number; bbox: { x: number } }[]) => pairs.map(p => ({ index: p.index, ok: true, description: `change near x=${p.bbox.x}`, type: 'add object', notes: 'ok' })),
      },
      imageEdit: { name: 'fake', isMock: true, editMaskedRegion: async () => { throw new Error('not used'); }, editFullImage, generateScene: async () => ({ image: '' }) },
    };
    const job = createJob('game', true, 2, 'medium');
    await runGeneration(job, { imageDataUrl: await solidPng(100, 80, [120, 120, 120]) }, 2, fake);
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
    expect(fullCalls).toBe(2); // pass 1 + exactly one completion call
    const diffs = getDifferences(job.levelId!)!;
    expect(diffs).toHaveLength(2);
    expect(diffs.every(d => d.id.startsWith('onepass-'))).toBe(true);
    expect(diffs[1].bbox.x).toBeLessThan(30); // the blue square, added by the completion pass
  });

  it('fails loudly instead of shipping a short level when the count is unreachable', async () => {
    const base = await sharp({ create: { width: 100, height: 80, channels: 3, background: { r: 120, g: 120, b: 120 } } })
      .composite([{ input: await sharp({ create: { width: 10, height: 8, channels: 3, background: { r: 220, g: 30, b: 30 } } }).png().toBuffer(), left: 40, top: 25 }])
      .png().toBuffer();
    const fake: Providers = {
      segmentation: {
        name: 'fake', isMock: true,
        segment: async () => [
          { id: 'r1', bbox: { x: 40, y: 25, width: 10, height: 8 } }, // red square: local recolor succeeds
          { id: 'r2', bbox: { x: 70, y: 10, width: 10, height: 8 } }, // Muse edit always fails
        ],
      },
      vision: {
        name: 'fake', isMock: true,
        moderate: async () => ({ ok: true, reason: 'ok' }),
        plan: async () => [
          { id: 'c1', regionId: 'r1', type: 'change color', description: 'square turned yellow', editPrompt: 'turn it yellow', targetColor: 'yellow' },
          { id: 'c2', regionId: 'r2', type: 'remove object', description: 'something disappeared', editPrompt: 'remove it' },
        ],
        verify: async () => ({ ok: true, notes: 'ok' }),
      },
      // No editFullImage: one-pass unavailable, so only crops can deliver — and they cap at 1/2.
      imageEdit: { name: 'fake', isMock: true, editMaskedRegion: async () => { throw new Error('edit unavailable'); }, generateScene: async () => ({ image: '' }) },
    };
    const job = createJob('game', true, 2, 'medium');
    await runGeneration(job, { imageDataUrl: bufferToDataUrl(base) }, 2, fake);
    expect(getJob(job.id)?.status).toBe('failed');
    expect(getJob(job.id)?.error).toContain('1 of the 2 differences');
    expect(getJob(job.id)?.levelId).toBeUndefined(); // no short level was published
  });

  it('below-floor components are HELD and delivered only as the last resort (after crops + completion pass)', async () => {
    // A STRONG but TINY change: amp ~110 (way above the easy amp floor of 40) yet its
    // measured area (~0.1% of this 400x300 image) is below the easy area floor of
    // 0.25% — but above the easy ABSOLUTE floor (0.08% / amp 30), so it is held, not
    // rejected. Nothing else can deliver (the crop candidate's edit throws, the
    // completion pass re-extracts the same component), so the last-resort step —
    // held below-floor components, tried only after every other path — ships it.
    const editFullImage = async (imageRef: string) => {
      const { data, width, height } = await rawPixels(imageRef);
      const out = Buffer.from(data);
      for (let y = 150; y < 160; y++) for (let x = 200; x < 210; x++) { const o = (y * width + x) * 3; out[o] = 230; out[o + 1] = 30; out[o + 2] = 30; }
      return bufferToDataUrl(await sharp(out, { raw: { width, height, channels: 3 } }).png().toBuffer());
    };
    const fake: Providers = {
      segmentation: { name: 'fake', isMock: true, segment: async () => [{ id: 'r1', bbox: { x: 200, y: 150, width: 10, height: 10 } }] },
      vision: {
        name: 'fake', isMock: true,
        moderate: async () => ({ ok: true, reason: 'ok' }),
        plan: async () => [{ id: 'c1', regionId: 'r1', type: 'remove object', description: 'x', editPrompt: 'x' }],
        verify: async () => ({ ok: true, notes: 'ok' }),
        reviewDifferences: async (pairs: { index: number }[]) => pairs.map(p => ({ index: p.index, ok: true, description: 'a small red square appeared', type: 'add object', notes: 'ok' })),
      },
      imageEdit: { name: 'fake', isMock: true, editMaskedRegion: async () => { throw new Error('not used'); }, editFullImage, generateScene: async () => ({ image: '' }) },
    };
    const job = createJob('game', true, 1, 'easy');
    await runGeneration(job, { imageDataUrl: await solidPng(400, 300, [120, 120, 120]) }, 1, fake);
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
    const diffs = getDifferences(job.levelId!)!;
    expect(diffs).toHaveLength(1);
    // Sanity: the delivered difference really is below the easy area floor (0.25%).
    expect(diffs[0].bbox_normalized.width * diffs[0].bbox_normalized.height).toBeLessThan(0.0025);
  });

  it('replacement plan: ONE extra Spark call over FREE regions only completes the count', async () => {
    const base = await sharp({ create: { width: 100, height: 80, channels: 3, background: { r: 120, g: 120, b: 120 } } })
      .composite([
        { input: await sharp({ create: { width: 10, height: 8, channels: 3, background: { r: 220, g: 30, b: 30 } } }).png().toBuffer(), left: 40, top: 25 },
        { input: await sharp({ create: { width: 10, height: 8, channels: 3, background: { r: 30, g: 200, b: 30 } } }).png().toBuffer(), left: 70, top: 40 },
      ])
      .png().toBuffer();
    let planCalls = 0;
    const fake: Providers = {
      segmentation: {
        name: 'fake', isMock: true,
        segment: async () => [
          { id: 'r1', bbox: { x: 40, y: 25, width: 10, height: 8 } },
          { id: 'r2', bbox: { x: 70, y: 40, width: 10, height: 8 } },
        ],
      },
      vision: {
        name: 'fake', isMock: true,
        moderate: async () => ({ ok: true, reason: 'ok' }),
        // First plan wastes its second candidate on the SAME region (discarded once
        // c1 lands there); the replan — asked with free regions only — targets r2.
        plan: async () => {
          planCalls++;
          if (planCalls === 1) return [
            { id: 'c1', regionId: 'r1', type: 'change color', description: 'square turned yellow', editPrompt: 'turn it yellow', targetColor: 'yellow' },
            { id: 'c2', regionId: 'r1', type: 'remove object', description: 'square disappeared', editPrompt: 'remove it' },
          ];
          return [{ id: 'c3', regionId: 'r2', type: 'change color', description: 'square turned red', editPrompt: 'turn it red', targetColor: 'red' }];
        },
        verify: async () => ({ ok: true, notes: 'ok' }),
      },
      imageEdit: { name: 'fake', isMock: true, editMaskedRegion: async () => { throw new Error('local recolor must handle it'); }, generateScene: async () => ({ image: '' }) },
    };
    const job = createJob('game', true, 2, 'medium');
    await runGeneration(job, { imageDataUrl: bufferToDataUrl(base) }, 2, fake);
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
    expect(planCalls).toBe(2); // initial plan + exactly one replacement call
    expect(getDifferences(job.levelId!)!.map(d => d.id).sort()).toEqual(['c1', 'c3']);
  });
});
