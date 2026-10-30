import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { compositeCrop, diffMask, bufferToDataUrl, recolorCrop, squareContextBox, compositeMaskedEdit, estimateAlignment, alignEditedCrop, cropColorStats, targetHueFromColor, cropDominantHue, transformObjectInPaste, duplicateObjectInPaste } from '../src/lib/server/imageOps';
import { maskToBBox, maskCentroid } from '../src/lib/engine/geometry';
import { createJob, getJob, runGeneration } from '../src/lib/server/jobs';
import { getDifferences, getLevelPayload } from '../src/lib/serverStore';
import type { Providers } from '../src/lib/engine/types';
import { buildQCCoco, buildQCYolo } from '../src/lib/coco';

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

describe('G: QC dataset export (measured defect bbox, verified only)', () => {
  const diffs = [
    { type: 'scratch', bbox: { x: 10, y: 10, width: 5, height: 2 }, verification_status: 'verified' },
    { type: 'crack', bbox: { x: 50, y: 50, width: 9, height: 9 }, verification_status: 'needs_review' },
    { type: 'dent', bbox: { x: 20, y: 30, width: 7, height: 7 }, verification_status: 'verified' },
  ];
  it('COCO contains only verified defects with their measured bboxes', () => {
    const coco = buildQCCoco(diffs, 400, 300, 'unit-modified.png');
    expect(coco.annotations).toHaveLength(2);
    expect(coco.annotations[0].bbox).toEqual([10, 10, 5, 2]);
    expect(coco.categories.map(c => c.name)).toContain('scratch');
    const crackId = coco.categories.find(c => c.name === 'crack')!.id;
    expect(coco.annotations.some(a => a.category_id === crackId)).toBe(false); // unverified never enters the dataset
  });
  it('YOLO lines match the same verified-only set', () => {
    const lines = buildQCYolo(diffs, 400, 300).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0].startsWith('0 ')).toBe(true); // scratch = class 0
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

  it('C: alignment is estimated and compensated, not rejected — only residual error gates', async () => {
    const pattern = async (shiftX: number) => {
      const w = 96, h = 96, buf = Buffer.alloc(w * h * 3);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const sx = Math.max(0, Math.min(w - 1, x - shiftX)), o = (y * w + x) * 3;
        buf[o] = sx * 2; buf[o + 1] = y * 2; buf[o + 2] = (sx * 3 + y * 7) % 256;
      }
      return bufferToDataUrl(await sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer());
    };
    const orig = await pattern(0);
    const same = await estimateAlignment(orig, orig);
    expect(same.shiftX).toBe(0); expect(same.scale).toBe(1); expect(same.aligned).toBe(true);
    // A pure 6px shift (Muse's systematic behaviour) is MEASURED with low residual error…
    const shifted = await pattern(6);
    const est = await estimateAlignment(orig, shifted);
    expect(est.shiftX).toBe(6); expect(est.scale).toBe(1); expect(est.error).toBeLessThan(5); expect(est.aligned).toBe(true);
    // …and warping the edit back by the inverse transform re-aligns it onto the original grid.
    const warped = await alignEditedCrop(orig, shifted, est);
    const re = await estimateAlignment(orig, warped);
    expect(Math.abs(re.shiftX)).toBeLessThanOrEqual(1);
    const mask = await diffMask(orig, warped, 96, 96);
    expect(mask.filter(Boolean).length).toBeLessThan(96 * 96 * 0.05);
    // A total repaint has high residual error under every transform -> the only rejection.
    const repaint = await estimateAlignment(orig, await solidPng(96, 96, [30, 200, 90]));
    expect(repaint.aligned).toBe(false); expect(repaint.error).toBeGreaterThan(25);
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

  it('D: dominant hue is the circular mean of saturated pixels', async () => {
    const hue = await cropDominantHue(await solidPng(6, 6, [220, 30, 30]));
    expect(hue).not.toBeNull();
    expect(hue!).toBeGreaterThan(15); expect(hue!).toBeLessThan(45); // red family in OKLCH
    expect(await cropDominantHue(await solidPng(6, 6, [128, 128, 128]))).toBeNull();
  });

  it('local transforms: duplicate copies the object onto a neighbouring flat area', async () => {
    const pasteBuf = await sharp({ create: { width: 40, height: 20, channels: 3, background: { r: 120, g: 120, b: 120 } } })
      .composite([{ input: await sharp({ create: { width: 8, height: 6, channels: 3, background: { r: 220, g: 30, b: 30 } } }).png().toBuffer(), left: 2, top: 7 }])
      .png().toBuffer();
    const out = await rawPixels(await duplicateObjectInPaste(bufferToDataUrl(pasteBuf), { x: 2, y: 7, width: 8, height: 6 }));
    let red = 0;
    for (let i = 0; i < out.data.length; i += 3) if (out.data[i] > 180 && out.data[i + 1] < 80) red++;
    expect(red).toBeGreaterThanOrEqual(96); // original 48px + a full copy somewhere flat
  });

  it('local transforms: resize and rotate measurably change the object canvas', async () => {
    const paste = await solidPng(30, 30, [120, 120, 120]);
    const rel = { x: 10, y: 10, width: 10, height: 10 };
    // Asymmetric pattern (a solid square scaled/rotated back into its own bbox would be identical).
    const objPx = Buffer.alloc(10 * 10 * 3);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) {
      const o = (y * 10 + x) * 3, red = x < 3 || y < 3;
      objPx[o] = red ? 220 : 30; objPx[o + 1] = 30; objPx[o + 2] = red ? 30 : 220;
    }
    const objBuf = await sharp(objPx, { raw: { width: 10, height: 10, channels: 3 } }).png().toBuffer();
    const redBuf = await sharp(Buffer.from(paste.split(',')[1], 'base64'))
      .composite([{ input: objBuf, left: 10, top: 10 }])
      .png().toBuffer();
    const withObj = bufferToDataUrl(redBuf);
    for (const kind of ['resize', 'rotate'] as const) {
      const out = kind === 'resize'
        ? await transformObjectInPaste(withObj, rel, 'resize', { resizeFactor: 1.2 })
        : await transformObjectInPaste(withObj, rel, 'rotate', { rotateDeg: 12 });
      expect((await diffMask(withObj, out, 30, 30)).filter(Boolean).length).toBeGreaterThan(10);
    }
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

  it('area criterion: oversized SAM boxes are center-cropped to 8% of image AREA and marked fragment', async () => {
    let seenWhole: Record<string, boolean | undefined> = {};
    const fake: Providers = {
      segmentation: {
        name: 'fake', isMock: true,
        segment: async () => [
          { id: 'big', bbox: { x: 0, y: 0, width: 99, height: 79 } },  // ~98% of the 100x80 image area — center-cropped to 8% area, fragment
          { id: 'small', bbox: { x: 5, y: 5, width: 10, height: 8 } },  // 1% of area — whole object
        ],
      },
      vision: {
        name: 'fake', isMock: true,
        moderate: async () => ({ ok: true, reason: 'ok' }),
        plan: async (_i, regions) => { seenWhole = Object.fromEntries(regions.map(r => [r.id, r.wholeObject])); return regions.map(r => ({ id: `c-${r.id}`, regionId: r.id, type: 'change color', description: `change in ${r.id}`, editPrompt: 'edit' })); },
        verify: async () => ({ ok: true, notes: 'ok' }),
      },
      imageEdit: { name: 'fake', isMock: true, editMaskedRegion: async (imageRef: string, region: { bbox: { x: number; y: number; width: number; height: number } }) => paintPatternBlue(imageRef, region), generateScene: async () => { throw new Error('not used'); } },
    };
    const job = createJob('game', true);
    await runGeneration(job, await solidPng(100, 80, [120, 120, 120]), 2, fake);
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
    expect(seenWhole).toEqual({ big: false, small: true });
    const diffs = getDifferences(job.levelId!)!;
    expect(diffs.map(d => d.id).sort()).toEqual(['c-big', 'c-small']);
    for (const d of diffs) {
      expect(d.bbox.width * d.bbox.height).toBeLessThanOrEqual(100 * 80 * 0.15); // measured cap is AREA-based too
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

  it('local flip runs deterministically — no Muse, no Spark verify — on an area-whole object', async () => {
    let museCalled = false, verifyCalls = 0;
    // Object 28x22 on a 100x80 image = 7.7% of AREA: whole object under the area criterion
    // (the old 10%-of-SIDE cap would have marked it a fragment and downgraded flip to color).
    const objBuf = await sharp({ create: { width: 28, height: 22, channels: 3, background: { r: 220, g: 30, b: 30 } } })
      .composite([{ input: await sharp({ create: { width: 14, height: 22, channels: 3, background: { r: 30, g: 30, b: 220 } } }).png().toBuffer(), left: 14, top: 0 }])
      .png().toBuffer();
    const base = await sharp({ create: { width: 100, height: 80, channels: 3, background: { r: 120, g: 120, b: 120 } } })
      .composite([{ input: objBuf, left: 36, top: 29 }])
      .png().toBuffer();
    const fake: Providers = {
      segmentation: { name: 'fake', isMock: true, segment: async () => [{ id: 'r1', bbox: { x: 36, y: 29, width: 28, height: 22 }, label: 'flag' }] },
      vision: {
        name: 'fake', isMock: true,
        moderate: async () => ({ ok: true, reason: 'ok' }),
        plan: async () => [{ id: 'c1', regionId: 'r1', type: 'flip', description: 'the flag is mirrored', editPrompt: 'Flip the flag horizontally.' }],
        verify: async () => { verifyCalls++; return { ok: true, notes: 'ok' }; },
      },
      imageEdit: { name: 'fake', isMock: true, editMaskedRegion: async () => { museCalled = true; throw new Error('must not be called for local transforms'); }, generateScene: async () => '' },
    };
    const job = createJob('game', true);
    await runGeneration(job, bufferToDataUrl(base), 1, fake);
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
    expect(museCalled).toBe(false);
    expect(verifyCalls).toBe(0); // deterministic: measured locally, no Spark call
    const diffs = getDifferences(job.levelId!)!;
    expect(diffs).toHaveLength(1);
    expect(diffs[0].type).toBe('flip');
    expect(diffs[0].verifier_notes).toContain('local deterministic flip');
  });

  it('executor walks the candidate list: a discarded candidate does not sink the level', async () => {
    let editCalls = 0;
    const fake: Providers = {
      segmentation: { name: 'fake', isMock: true, segment: async () => [{ id: 'r1', bbox: { x: 40, y: 25, width: 10, height: 8 } }] },
      vision: {
        name: 'fake', isMock: true,
        moderate: async () => ({ ok: true, reason: 'ok' }),
        // count=1 but the planner returns extra candidates (jobs asks for count+3): c1 comes
        // back unchanged (no measurable diff -> discarded), c2 must still deliver the level.
        plan: async () => [
          { id: 'c1', regionId: 'r1', type: 'remove object', description: 'first attempt', editPrompt: 'Remove the block.' },
          { id: 'c2', regionId: 'r1', type: 'remove object', description: 'second attempt', editPrompt: 'Remove the block.' },
        ],
        verify: async () => ({ ok: true, notes: 'ok' }),
      },
      imageEdit: { name: 'fake', isMock: true, editMaskedRegion: async (imageRef: string, region: { bbox: { x: number; y: number; width: number; height: number } }) => { editCalls++; return editCalls === 1 ? imageRef : paintPatternBlue(imageRef, region); }, generateScene: async () => '' },
    };
    const job = createJob('game', true);
    await runGeneration(job, await solidPng(100, 80, [120, 120, 120]), 1, fake);
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
    expect(editCalls).toBe(2);
    expect(getDifferences(job.levelId!)!.map(d => d.id)).toEqual(['c2']); // stopped after 1 achieved
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

  it('F: spacing runs on the FINAL paste boxes — overlapping pastes drop the later region', async () => {
    const fake: Providers = {
      // bboxes are 8px apart (passes bbox spacing), but paste boxes (+15%) overlap: 34..86 vs 82..134.
      segmentation: { name: 'fake', isMock: true, segment: async () => [
        { id: 'r1', bbox: { x: 40, y: 40, width: 40, height: 30 } },
        { id: 'r2', bbox: { x: 88, y: 40, width: 40, height: 30 } },
      ] },
      vision: {
        name: 'fake', isMock: true,
        moderate: async () => ({ ok: true, reason: 'ok' }),
        plan: async (_i, regions) => regions.map(r => ({ id: `c-${r.id}`, regionId: r.id, type: 'change color', description: `change in ${r.id}`, editPrompt: 'edit' })),
        verify: async () => ({ ok: true, notes: 'ok' }),
      },
      imageEdit: { name: 'fake', isMock: true, editMaskedRegion: async (imageRef: string, region: { bbox: { x: number; y: number; width: number; height: number } }) => paintPatternBlue(imageRef, region), generateScene: async () => '' },
    };
    const job = createJob('game', true);
    await runGeneration(job, await solidPng(400, 300, [120, 120, 120]), 2, fake);
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
    expect(getDifferences(job.levelId!)!.map(d => d.id)).toEqual(['c-r1']); // r2 dropped before planning
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

  it('color: recolors to the EXACT planned targetColor hue (yellow stays yellow)', async () => {
    const base = await sharp({ create: { width: 100, height: 80, channels: 3, background: { r: 120, g: 120, b: 120 } } })
      .composite([{ input: await sharp({ create: { width: 12, height: 10, channels: 3, background: { r: 220, g: 30, b: 30 } } }).png().toBuffer(), left: 40, top: 25 }])
      .png().toBuffer();
    let museCalled = false;
    const fake: Providers = {
      segmentation: { name: 'fake', isMock: true, segment: async () => [{ id: 'r1', bbox: { x: 40, y: 25, width: 12, height: 10 } }] },
      vision: {
        name: 'fake', isMock: true,
        moderate: async () => ({ ok: true, reason: 'ok' }),
        plan: async () => [{ id: 'c1', regionId: 'r1', type: 'change color', description: 'square turned yellow', editPrompt: 'turn it yellow', targetColor: 'yellow' }],
        verify: async () => ({ ok: true, notes: 'ok' }),
      },
      imageEdit: { name: 'fake', isMock: true, editMaskedRegion: async () => { museCalled = true; throw new Error('local recolor must handle an exact target hue'); }, generateScene: async () => '' },
    };
    const job = createJob('game', true);
    await runGeneration(job, bufferToDataUrl(base), 1, fake);
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
    expect(museCalled).toBe(false);
    const diffs = getDifferences(job.levelId!)!;
    expect(diffs).toHaveLength(1);
    expect(diffs[0].verifier_notes).toContain('target hue 100°'); // yellow in OKLCH
    const payload = getLevelPayload(job.levelId!)!;
    const { data, width } = await rawPixels(payload.modified);
    const o = (30 * width + 45) * 3; // inside the recolored square
    const [r, g, b] = [data[o], data[o + 1], data[o + 2]];
    // Yellow family at the object's preserved lightness: R≈G, both far above B.
    // (Green would be G>>R, red would be R>>G — the exact regression from the field.)
    expect(r).toBeGreaterThan(120); expect(g).toBeGreaterThan(110); expect(b).toBeLessThan(110);
    expect(Math.abs(r - g)).toBeLessThan(60); expect(b).toBeLessThan(Math.min(r, g) - 50);
  });

  it('verifier compares BEFORE-this-change (current) vs candidate, cropped — accumulated changes do not leak in', async () => {
    const seen: { before: string; after: string }[] = [];
    const fake: Providers = {
      segmentation: { name: 'fake', isMock: true, segment: async () => [{ id: 'r1', bbox: { x: 40, y: 25, width: 10, height: 8 } }] },
      vision: {
        name: 'fake', isMock: true,
        moderate: async () => ({ ok: true, reason: 'ok' }),
        plan: async () => [{ id: 'c1', regionId: 'r1', type: 'remove object', description: 'remove block', editPrompt: 'remove it' }],
        verify: async (before: string, after: string) => { seen.push({ before, after }); return { ok: true, notes: 'ok' }; },
      },
      imageEdit: { name: 'fake', isMock: true, editMaskedRegion: async (imageRef: string, region: { bbox: { x: number; y: number; width: number; height: number } }) => paintPatternBlue(imageRef, region), generateScene: async () => '' },
    };
    const job = createJob('game', true);
    await runGeneration(job, await solidPng(100, 80, [120, 120, 120]), 1, fake);
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
    expect(seen).toHaveLength(1);
    // Crops are square context boxes, NOT the full 100x80 frame:
    const info = await rawPixels(seen[0].before);
    expect(info.width).toBe(info.height);
    expect(info.width).toBeLessThan(100);
    // BEFORE crop is the untouched gray scene (no blue yet): center pixel ~gray
    const { data, width } = info; const o = ((width / 2 | 0) * width + (width / 2 | 0)) * 3;
    expect(Math.abs(data[o] - data[o + 2])).toBeLessThan(30);
  });

  it('one-pass is the main game path: 1 full-image call + 1 batched review, crop executor never runs', async () => {
    let fullImageCalls = 0, segmentCalls = 0, reviewCalls = 0, cropEditCalls = 0;
    // Fake Muse full-image edit: paint a solid red square at (60,50,14x12) on the gray scene.
    const editFull = async (imageRef: string) => {
      fullImageCalls++;
      const { data, width, height } = await rawPixels(imageRef);
      const out = Buffer.from(data);
      for (let y = 50; y < 62; y++) for (let x = 60; x < 74; x++) { const o = (y * width + x) * 3; out[o] = 230; out[o + 1] = 30; out[o + 2] = 30; }
      return bufferToDataUrl(await sharp(out, { raw: { width, height, channels: 3 } }).png().toBuffer());
    };
    const fake: Providers = {
      segmentation: { name: 'fake', isMock: true, segment: async () => { segmentCalls++; return []; } },
      vision: {
        name: 'fake', isMock: true,
        moderate: async () => ({ ok: true, reason: 'ok' }),
        plan: async () => [], verify: async () => ({ ok: true, notes: 'ok' }),
        reviewDifferences: async (pairs: { index: number }[]) => { reviewCalls++; return pairs.map(p => ({ index: p.index, ok: true, description: 'A red square appeared', type: 'add object', notes: 'fake review ok' })); },
      },
      imageEdit: { name: 'fake', isMock: true, editMaskedRegion: async () => { cropEditCalls++; throw new Error('crop edit must not run when one-pass delivers'); }, editFullImage: editFull, generateScene: async () => '' },
    };
    const job = createJob('game', true);
    await runGeneration(job, await solidPng(100, 80, [120, 120, 120]), 1, fake);
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
    expect(fullImageCalls).toBe(1);
    expect(reviewCalls).toBe(1);
    expect(cropEditCalls).toBe(0); // crop executor never ran
    expect(segmentCalls).toBe(1); // segmentation+planning launched in parallel, result unused
    const diffs = getDifferences(job.levelId!)!;
    expect(diffs).toHaveLength(1);
    expect(diffs[0].id).toContain('onepass');
    expect(diffs[0].description).toBe('A red square appeared');
    expect(diffs[0].bbox.x).toBeGreaterThanOrEqual(55); expect(diffs[0].bbox.x).toBeLessThanOrEqual(65);
    // Outside the composed component the modified image stays pixel-identical to the original:
    const payload = getLevelPayload(job.levelId!)!;
    const { data } = await rawPixels(payload.modified);
    expect([data[0], data[1], data[2]]).toEqual([120, 120, 120]);
  });
});
