import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { compositeCrop, diffMask, bufferToDataUrl, recolorCrop, squareContextBox, compositeMaskedEdit, alignmentCheck, cropColorStats, targetHueFromColor } from '../src/lib/server/imageOps';
import { maskToBBox, maskCentroid } from '../src/lib/engine/geometry';
import { createJob, getJob, runGeneration } from '../src/lib/server/jobs';
import { getDifferences, getLevelPayload } from '../src/lib/serverStore';
import type { Providers } from '../src/lib/engine/types';

const solidPng = async (w: number, h: number, rgb: [number, number, number]) =>
  bufferToDataUrl(await sharp({ create: { width: w, height: h, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer());
const rawPixels = async (dataUrl: string) => {
  const { data, info } = await sharp(Buffer.from(dataUrl.split(',')[1], 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
};

/** Realistic fake Muse edit: paints blue exactly in the paste sub-region it is given,
 *  leaving everything else untouched — a whole-image repaint would (correctly) fail the
 *  alignment guard. */
const paintPatternBlue = async (imageRef: string, region?: { bbox: { x: number; y: number; width: number; height: number } }) => {
  const { data, info } = await sharp(Buffer.from(imageRef.split(',')[1], 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.from(data);
  const b = region?.bbox ?? { x: 12, y: 12, width: Math.max(1, info.width - 24), height: Math.max(1, info.height - 24) };
  for (let y = Math.max(0, b.y); y < Math.min(info.height, b.y + b.height); y++) for (let x = Math.max(0, b.x); x < Math.min(info.width, b.x + b.width); x++) {
    const o = (y * info.width + x) * 3; out[o] = 30; out[o + 1] = 30; out[o + 2] = 220;
  }
  return bufferToDataUrl(await sharp(out, { raw: { width: info.width, height: info.height, channels: 3 } }).png().toBuffer());
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

describe('recolorCrop (deterministic color change)', () => {
  it('changes hue but keeps grays and lightness structure untouched', async () => {
    // 4x1: red, gray, dark red, white
    const px = Buffer.from([220, 30, 30, 128, 128, 128, 110, 15, 15, 255, 255, 255]);
    const img = bufferToDataUrl(await sharp(px, { raw: { width: 4, height: 1, channels: 3 } }).png().toBuffer());
    const out = await rawPixels(await recolorCrop(img, 120));
    const at = (x: number) => [out.data[x * 3], out.data[x * 3 + 1], out.data[x * 3 + 2]];
    expect(at(1)).toEqual([128, 128, 128]); // gray untouched
    expect(at(3)).toEqual([255, 255, 255]); // white untouched
    const [r, g, b] = at(0);
    expect(g).toBeGreaterThan(r); // red rotated +120deg -> green-dominant
    expect([r, g, b]).not.toEqual([220, 30, 30]);
  });
});

describe('maskCentroid', () => {
  it('returns the center of mass, not the bbox center', () => {
    const mask = new Array<boolean>(25).fill(false);
    mask[1 * 5 + 0] = true; mask[1 * 5 + 1] = true; mask[1 * 5 + 2] = true; mask[2 * 5 + 0] = true; // L shape in 5x5
    expect(maskCentroid(mask, 5, 5)).toEqual({ x: 0.75, y: 1.25 });
    expect(maskCentroid(new Array<boolean>(25).fill(false), 5, 5)).toBeNull();
  });
});

describe('A/B/C/D: square context, masked composite, alignment guard, OKLCH recolor', () => {
  it('A: square context box is shifted inside the image, never shrunk', () => {
    expect(squareContextBox({ x: 0, y: 0, width: 20, height: 10 }, 800, 600)).toEqual({ x: 0, y: 0, width: 384, height: 384 });
    expect(squareContextBox({ x: 390, y: 290, width: 20, height: 20 }, 800, 600)).toEqual({ x: 208, y: 108, width: 384, height: 384 });
  });

  it('B: masked composite changes only the paste area — context neighbours stay original', async () => {
    const original = await solidPng(80, 60, [120, 120, 120]);
    const editedContext = await solidPng(40, 40, [30, 30, 220]); // Muse repainted its whole square
    const out = await rawPixels(await compositeMaskedEdit(original, editedContext, { x: 10, y: 10, width: 40, height: 40 }, { x: 30, y: 20, width: 20, height: 20 }));
    const px = (x: number, y: number) => { const o = (y * out.width + x) * 3; return [out.data[o], out.data[o + 1], out.data[o + 2]]; };
    expect(px(15, 15)).toEqual([120, 120, 120]); // inside context but OUTSIDE paste box: untouched
    expect(px(40, 30)[2]).toBeGreaterThan(150); // centre of paste: edited blue lands
  });

  it('C: alignment guard accepts identical crops and rejects a 5px shift', async () => {
    const pattern = async (shiftX: number) => {
      const w = 48, h = 48, buf = Buffer.alloc(w * h * 3);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const sx = Math.max(0, Math.min(w - 1, x - shiftX)), o = (y * w + x) * 3;
        buf[o] = sx * 5; buf[o + 1] = y * 5; buf[o + 2] = (sx * 3 + y * 7) % 256;
      }
      return bufferToDataUrl(await sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer());
    };
    const orig = await pattern(0);
    const same = await alignmentCheck(orig, orig);
    expect(same.aligned).toBe(true); expect(same.shiftX).toBe(0);
    const shifted = await alignmentCheck(orig, await pattern(5));
    expect(shifted.aligned).toBe(false); expect(Math.abs(shifted.shiftX)).toBeGreaterThan(2);
  });

  it('D: target color names map to hues; achromatic targets route away from local recolor', () => {
    expect(targetHueFromColor('green')).toBe(145);
    expect(targetHueFromColor('Blue')).toBe(260);
    expect(targetHueFromColor('white')).toBeNull();
    expect(targetHueFromColor(undefined)).toBeNull();
  });

  it('D: low-chroma crops report low chroma (no hue rotation for cream/gray objects)', async () => {
    expect((await cropColorStats(await solidPng(10, 10, [200, 195, 185]))).meanChroma).toBeLessThan(0.04);
    expect((await cropColorStats(await solidPng(10, 10, [220, 30, 30]))).meanChroma).toBeGreaterThan(0.1);
  });

  it('D: recolor to a named target hue lands on that color family', async () => {
    const red = await solidPng(6, 6, [220, 30, 30]);
    const out = await rawPixels(await recolorCrop(red, 0, targetHueFromColor('green')!));
    expect(out.data[1]).toBeGreaterThan(out.data[0]); // green dominant over red
    expect(out.data[1]).toBeGreaterThan(out.data[2]); // and over blue
  });
});

describe('runGeneration with fake providers (offline, no paid calls)', () => {
  it('produces a playable level with a measured, verified difference', async () => {
    const fake: Providers = {
      segmentation: { name: 'fake', isMock: true, segment: async () => [{ id: 'r1', bbox: { x: 40, y: 25, width: 10, height: 8 } }] },
      vision: {
        name: 'fake', isMock: true,
        moderate: async () => ({ ok: true, reason: 'ok' }),
        plan: async () => [{ id: 'c1', regionId: 'r1', type: 'change color', description: 'block turned blue', editPrompt: 'make it blue' }],
        verify: async () => ({ ok: true, notes: 'verified by fake verifier' }),
      },
      imageEdit: { name: 'fake', isMock: true, editMaskedRegion: async (imageRef: string, region: { bbox: { x: number; y: number; width: number; height: number } }) => paintPatternBlue(imageRef, region), generateScene: async () => { throw new Error('not used'); } },
    };
    const job = createJob('game', true);
    await runGeneration(job, await solidPng(100, 80, [120, 120, 120]), 1, fake);
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
    const diffs = getDifferences(job.levelId!)!;
    expect(diffs).toHaveLength(1);
    expect(diffs[0].verification_status).toBe('verified');
    expect(diffs[0].bbox.width).toBeGreaterThan(0);
    // Measured bbox must sit inside the expanded crop region (40,25,10x8 @ +25% -> 37,23,15x12)
    expect(diffs[0].bbox.x).toBeGreaterThanOrEqual(37);
    expect(diffs[0].bbox.y).toBeGreaterThanOrEqual(23);
    expect(diffs[0].bbox.x + diffs[0].bbox.width).toBeLessThanOrEqual(52);
    expect(diffs[0].bbox.y + diffs[0].bbox.height).toBeLessThanOrEqual(35);
    const payload = getLevelPayload(job.levelId!)!;
    expect(payload.total).toBe(1);
    expect(payload).not.toHaveProperty('differences'); // anti-cheat: annotations never in the client payload
  });

  it('shrinks oversized regions so Muse can never repaint the whole photo', async () => {
    const fake: Providers = {
      segmentation: {
        name: 'fake', isMock: true,
        segment: async () => [
          { id: 'big', bbox: { x: 0, y: 0, width: 99, height: 79 } },  // ~whole 100x80 image — must be shrunk to the 10% cap (10x8)
          { id: 'small', bbox: { x: 5, y: 5, width: 10, height: 8 } },  // already within cap
        ],
      },
      vision: {
        name: 'fake', isMock: true,
        moderate: async () => ({ ok: true, reason: 'ok' }),
        plan: async (_i, regions) => regions.map(r => ({ id: `c-${r.id}`, regionId: r.id, type: 'change color', description: `change in ${r.id}`, editPrompt: 'edit' })),
        verify: async () => ({ ok: true, notes: 'ok' }),
      },
      imageEdit: { name: 'fake', isMock: true, editMaskedRegion: async (imageRef: string, region: { bbox: { x: number; y: number; width: number; height: number } }) => paintPatternBlue(imageRef, region), generateScene: async () => { throw new Error('not used'); } },
    };
    const job = createJob('game', true);
    await runGeneration(job, await solidPng(100, 80, [120, 120, 120]), 2, fake);
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
    const diffs = getDifferences(job.levelId!)!;
    expect(diffs.map(d => d.id).sort()).toEqual(['c-big', 'c-small']);
    for (const d of diffs) {
      expect(d.bbox.width).toBeLessThanOrEqual(100 * 0.17);  // no difference may span the photo
      expect(d.bbox.height).toBeLessThanOrEqual(80 * 0.17);
    }
  });

  it('handles color changes locally — Muse edit is never called', async () => {
    let museCalled = false;
    const base = await sharp({ create: { width: 100, height: 80, channels: 3, background: { r: 120, g: 120, b: 120 } } })
      .composite([{ input: await sharp({ create: { width: 10, height: 8, channels: 3, background: { r: 220, g: 30, b: 30 } } }).png().toBuffer(), left: 40, top: 25 }])
      .png().toBuffer();
    const fake: Providers = {
      segmentation: { name: 'fake', isMock: true, segment: async () => [{ id: 'r1', bbox: { x: 40, y: 25, width: 10, height: 8 } }] },
      vision: {
        name: 'fake', isMock: true,
        moderate: async () => ({ ok: true, reason: 'ok' }),
        plan: async () => [{ id: 'c1', regionId: 'r1', type: 'change color', description: 'square changed color', editPrompt: 'recolor it' }],
        verify: async () => ({ ok: true, notes: 'ok' }),
      },
      imageEdit: { name: 'fake', isMock: true, editMaskedRegion: async () => { museCalled = true; throw new Error('must not be called for color changes'); }, generateScene: async () => '' },
    };
    const job = createJob('game', true);
    await runGeneration(job, bufferToDataUrl(base), 1, fake);
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
    expect(museCalled).toBe(false); // pure recolor: zero deformation, zero API cost
    const diffs = getDifferences(job.levelId!)!;
    expect(diffs).toHaveLength(1);
    expect(diffs[0].centroid!.x).toBeGreaterThanOrEqual(40); // centered on the recolored square
    expect(diffs[0].centroid!.x).toBeLessThanOrEqual(50);
    expect(diffs[0].verifier_notes).toContain('no Spark call'); // E: deterministic colors verified locally (ΔE + mask)
  });

  it('never removes/replaces a fragment — downgraded to a color change (no broken objects)', async () => {
    let museCalled = false;
    const base = await sharp({ create: { width: 100, height: 80, channels: 3, background: { r: 120, g: 120, b: 120 } } })
      .composite([{ input: await sharp({ create: { width: 10, height: 8, channels: 3, background: { r: 220, g: 30, b: 30 } } }).png().toBuffer(), left: 44, top: 35 }])
      .png().toBuffer();
    const fake: Providers = {
      // Only ONE huge region: it gets center-shrunk (wholeObject=false), so remove would cut the object in half.
      segmentation: { name: 'fake', isMock: true, segment: async () => [{ id: 'big', bbox: { x: 0, y: 0, width: 99, height: 79 } }] },
      vision: {
        name: 'fake', isMock: true,
        moderate: async () => ({ ok: true, reason: 'ok' }),
        plan: async () => [{ id: 'c1', regionId: 'big', type: 'remove object', description: 'remove it', editPrompt: 'remove it' }],
        verify: async () => ({ ok: true, notes: 'ok' }),
      },
      imageEdit: { name: 'fake', isMock: true, editMaskedRegion: async () => { museCalled = true; throw new Error('must not be called'); }, generateScene: async () => '' },
    };
    const job = createJob('game', true);
    await runGeneration(job, bufferToDataUrl(base), 1, fake);
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
    expect(museCalled).toBe(false);
    expect(getDifferences(job.levelId!)![0].type).toBe('change color');
  });

  it('QC mode keeps localized defects on fragments (scratch on part of a part is the point)', async () => {
    let museCalled = false;
    const fake: Providers = {
      segmentation: { name: 'fake', isMock: true, segment: async () => [{ id: 'big', bbox: { x: 0, y: 0, width: 99, height: 79 } }] }, // fragment after shrink
      vision: {
        name: 'fake', isMock: true,
        moderate: async () => ({ ok: true, reason: 'ok' }),
        plan: async () => [{ id: 'c1', regionId: 'big', type: 'scratch', description: 'scratch across the surface', editPrompt: 'add a realistic scratch' }],
        verify: async () => ({ ok: true, notes: 'ok' }),
      },
      imageEdit: { name: 'fake', isMock: true, editMaskedRegion: async (imageRef: string, region: { bbox: { x: number; y: number; width: number; height: number } }) => { museCalled = true; return paintPatternBlue(imageRef, region); }, generateScene: async () => '' },
    };
    const job = createJob('qc', true);
    await runGeneration(job, await solidPng(100, 80, [120, 120, 120]), 1, fake);
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
    expect(museCalled).toBe(true); // NOT downgraded to a local recolor
    expect(getDifferences(job.levelId!)![0].type).toBe('scratch');
  });

  it('E: a failed verification re-edits once with Muse (never re-asks the same question)', async () => {
    let editCalls = 0, verifyCalls = 0;
    const fake: Providers = {
      segmentation: { name: 'fake', isMock: true, segment: async () => [{ id: 'r1', bbox: { x: 40, y: 25, width: 10, height: 8 } }] },
      vision: {
        name: 'fake', isMock: true,
        moderate: async () => ({ ok: true, reason: 'ok' }),
        plan: async () => [{ id: 'c1', regionId: 'r1', type: 'remove object', description: 'remove the block', editPrompt: 'Remove the block.' }],
        verify: async () => { verifyCalls++; return verifyCalls === 1 ? { ok: false, notes: 'still visible' } : { ok: true, notes: 'gone now' }; },
      },
      imageEdit: { name: 'fake', isMock: true, editMaskedRegion: async (imageRef: string, region: { bbox: { x: number; y: number; width: number; height: number } }) => { editCalls++; return paintPatternBlue(imageRef, region); }, generateScene: async () => '' },
    };
    const job = createJob('game', true);
    await runGeneration(job, await solidPng(100, 80, [120, 120, 120]), 1, fake);
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
    expect(editCalls).toBe(2);   // initial edit + exactly one re-edit
    expect(verifyCalls).toBe(2); // verified the NEW edit, not the same one twice
    expect(getDifferences(job.levelId!)![0].verifier_notes).toBe('gone now');
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
