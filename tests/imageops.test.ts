import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { compositeCrop, diffMask, bufferToDataUrl } from '../src/lib/server/imageOps';
import { maskToBBox } from '../src/lib/engine/geometry';
import { createJob, getJob, runGeneration } from '../src/lib/server/jobs';
import { getDifferences, getLevelPayload } from '../src/lib/serverStore';
import type { Providers } from '../src/lib/engine/types';

const solidPng = async (w: number, h: number, rgb: [number, number, number]) =>
  bufferToDataUrl(await sharp({ create: { width: w, height: h, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer());
const rawPixels = async (dataUrl: string) => {
  const { data, info } = await sharp(Buffer.from(dataUrl.split(',')[1], 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
};

describe('server imageOps (sharp)', () => {
  it('compositeCrop leaves pixels outside the crop pixel-identical and changes inside', async () => {
    const original = await solidPng(40, 30, [120, 120, 120]);
    const edited = await solidPng(20, 20, [220, 30, 30]); // Muse returns a different size — must be resized back
    const out = await compositeCrop(original, edited, { x: 10, y: 5, width: 12, height: 10 }, 0);
    const a = await rawPixels(original); const b = await rawPixels(out);
    const px = (img: typeof a, x: number, y: number) => { const o = (y * img.width + x) * 3; return [img.data[o], img.data[o + 1], img.data[o + 2]]; };
    expect(px(b, 0, 0)).toEqual(px(a, 0, 0));       // outside: identical
    expect(px(b, 39, 29)).toEqual(px(a, 39, 29));   // outside: identical
    expect(px(b, 16, 10)).not.toEqual(px(a, 16, 10)); // inside: edited
  });

  it('diffMask + maskToBBox measure a painted change exactly', async () => {
    const a = await solidPng(30, 20, [100, 100, 100]);
    const bBuf = await sharp(Buffer.from(a.split(',')[1], 'base64'))
      .composite([{ input: await sharp({ create: { width: 6, height: 4, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer(), left: 7, top: 5 }])
      .png().toBuffer();
    const mask = await diffMask(a, bufferToDataUrl(bBuf), 30, 20);
    expect(maskToBBox(mask, 30, 20)).toEqual({ x: 7, y: 5, width: 6, height: 4 });
  });
});

describe('runGeneration with fake providers (offline, no paid calls)', () => {
  it('produces a playable level with a measured, verified difference', async () => {
    const edited = await solidPng(24, 24, [30, 30, 220]);
    const fake: Providers = {
      segmentation: { name: 'fake', isMock: true, segment: async () => [{ id: 'r1', bbox: { x: 16, y: 10, width: 6, height: 5 } }] },
      vision: {
        name: 'fake', isMock: true,
        moderate: async () => ({ ok: true, reason: 'ok' }),
        plan: async () => [{ id: 'c1', regionId: 'r1', type: 'change color', description: 'block turned blue', editPrompt: 'make it blue' }],
        verify: async () => ({ ok: true, notes: 'verified by fake verifier' }),
      },
      imageEdit: { name: 'fake', isMock: true, editMaskedRegion: async () => edited, generateScene: async () => { throw new Error('not used'); } },
    };
    const job = createJob('game', true);
    await runGeneration(job, await solidPng(40, 30, [120, 120, 120]), 1, fake);
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
    const diffs = getDifferences(job.levelId!)!;
    expect(diffs).toHaveLength(1);
    expect(diffs[0].verification_status).toBe('verified');
    expect(diffs[0].bbox.width).toBeGreaterThan(0);
    // Measured bbox must sit inside the expanded crop region (16,10,6x5 @ +25% -> ~14,8,9x8)
    expect(diffs[0].bbox.x).toBeGreaterThanOrEqual(14);
    expect(diffs[0].bbox.y).toBeGreaterThanOrEqual(8);
    expect(diffs[0].bbox.x + diffs[0].bbox.width).toBeLessThanOrEqual(23);
    expect(diffs[0].bbox.y + diffs[0].bbox.height).toBeLessThanOrEqual(16);
    const payload = getLevelPayload(job.levelId!)!;
    expect(payload.total).toBe(1);
    expect(payload).not.toHaveProperty('differences'); // anti-cheat: annotations never in the client payload
  });

  it('excludes oversized regions so Muse can never repaint the whole photo', async () => {
    const edited = await solidPng(24, 24, [30, 30, 220]);
    const fake: Providers = {
      segmentation: {
        name: 'fake', isMock: true,
        segment: async () => [
          { id: 'big', bbox: { x: 0, y: 0, width: 39, height: 29 } },  // ~whole 40x30 image — must be filtered out
          { id: 'small', bbox: { x: 8, y: 6, width: 6, height: 5 } },  // within the 20% side cap (8x6)
        ],
      },
      vision: {
        name: 'fake', isMock: true,
        moderate: async () => ({ ok: true, reason: 'ok' }),
        plan: async (_i, regions) => regions.map((r, i) => ({ id: `c-${r.id}`, regionId: r.id, type: 'change color', description: `change in ${r.id}`, editPrompt: 'edit' })),
        verify: async () => ({ ok: true, notes: 'ok' }),
      },
      imageEdit: { name: 'fake', isMock: true, editMaskedRegion: async () => edited, generateScene: async () => { throw new Error('not used'); } },
    };
    const job = createJob('game', true);
    await runGeneration(job, await solidPng(40, 30, [120, 120, 120]), 2, fake);
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
    const diffs = getDifferences(job.levelId!)!;
    expect(diffs.map(d => d.id)).toEqual(['c-small']); // the whole-image region never became a difference
  });

  it('marks the job failed when moderation rejects (no silent fallback)', async () => {
    const fake: Providers = {
      segmentation: { name: 'fake', isMock: true, segment: async () => [] },
      vision: {
        name: 'fake', isMock: true,
        moderate: async () => ({ ok: false, reason: 'blocked content' }),
        plan: async () => [], verify: async () => ({ ok: false, notes: '' }),
      },
      imageEdit: { name: 'fake', isMock: true, editMaskedRegion: async () => '', generateScene: async () => '' },
    };
    const job = createJob('game', true);
    await runGeneration(job, await solidPng(20, 20, [0, 0, 0]), 1, fake);
    expect(getJob(job.id)?.status).toBe('failed');
    expect(getJob(job.id)?.error).toContain('moderation rejected');
  });
});
