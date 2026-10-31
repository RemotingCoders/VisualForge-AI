import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import sharp from 'sharp';
import { parseSseOutputText, parseSamOutput, decodeMaskToRaster, decodeMaskToRLE, decodeMaskToSVGPath, maskRasterToFrame, type SamMask } from '../src/lib/engine/meta';
import { maskToPolygon } from '../src/lib/engine/geometry';
import { recolorCrop, bufferToDataUrl } from '../src/lib/server/imageOps';
import { createJob, getJob, runGeneration } from '../src/lib/server/jobs';
import { getDifferences, getLevelPayload } from '../src/lib/serverStore';
import { buildQCCoco } from '../src/lib/coco';
import type { Providers } from '../src/lib/engine/types';

// Capability 1 (VF_SAM_MASKS): real SAM masks via the official @meta-sam/parser.
// ALL tests are offline — paid-call free: they decode the spike's saved SSE and use
// one of its REAL masks as the fake provider's mask. (The parser's encoder,
// encodeSegmentationMask, exists in mask-codec.js but is NOT re-exported from the
// package index, so tests cannot fabricate masks with it.)

const rawPixels = async (dataUrl: string) => {
  const { data, info } = await sharp(Buffer.from(dataUrl.split(',')[1], 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width };
};
const shoelace = (poly: number[]) => {
  let a = 0;
  for (let i = 0; i < poly.length; i += 2) { const j = (i + 2) % poly.length; a += poly[i] * poly[j + 1] - poly[j] * poly[i + 1]; }
  return Math.abs(a / 2);
};

const ssePath = 'spike-output/sam-raw.txt';
describe.skipIf(!existsSync(ssePath))('SAM masks from the saved spike SSE (offline)', () => {
  const objects = parseSamOutput(parseSseOutputText(readFileSync(ssePath, 'utf8')));
  const withMask = objects.filter(o => o.mask);

  it('decodes at least one REAL mask: declared size, sane foreground fraction, non-empty SVG path', () => {
    expect(withMask.length).toBeGreaterThan(0);
    const mask = withMask[0].mask!;
    const raster = decodeMaskToRaster(mask);
    expect(raster.length).toBe(mask.width * mask.height);
    const ones = raster.reduce((a, v) => a + v, 0) / raster.length;
    expect(ones).toBeGreaterThan(0.05); expect(ones).toBeLessThan(0.95);
    const svg = decodeMaskToSVGPath(mask);
    expect(svg.length).toBeGreaterThan(10); expect(svg).toContain('M');
    const rle = decodeMaskToRLE(mask);
    expect(rle.size).toEqual([mask.height, mask.width]);
  });

  it('maskRasterToFrame scales the raster into the box and leaves the outside at 0', () => {
    const mask = withMask[0].mask!;
    const box = { x: 4, y: 3, width: 20, height: 10 };
    const frame = maskRasterToFrame(mask, box, 40, 30);
    expect(frame.length).toBe(40 * 30);
    expect(frame[0]).toBe(0); // far outside the box
    const ones = frame.reduce((a, v) => a + v, 0);
    expect(ones).toBeGreaterThan(0); expect(ones).toBeLessThanOrEqual(20 * 10);
  });

  it('decode is deterministic and maskRasterToFrame at native size reproduces the raster', () => {
    const mask = withMask[0].mask!;
    const a = decodeMaskToRaster(mask);
    const b = decodeMaskToRaster(mask);
    expect(Array.from(a)).toEqual(Array.from(b));
    const frame = maskRasterToFrame(mask, { x: 0, y: 0, width: mask.width, height: mask.height }, mask.width, mask.height);
    expect(Array.from(frame)).toEqual(Array.from(a));
  });
});

describe('SAM mask helpers', () => {
  it('maskToPolygon traces the real outline (shoelace area ~= pixel count)', () => {
    const w = 8, h = 8; const mask = new Array<boolean>(w * h).fill(false);
    for (let y = 2; y < 5; y++) for (let x = 3; x < 6; x++) mask[y * w + x] = true; // 3x3 block
    const poly = maskToPolygon(mask, w, h)!;
    expect(poly.length).toBeGreaterThanOrEqual(8); // at least 4 corners
    expect(shoelace(poly)).toBe(9);
    expect(maskToPolygon(new Array<boolean>(w * h).fill(false), w, h)).toBeNull();
  });

  it('recolorCrop with a mask recolors ONLY masked pixels', async () => {
    const px = Buffer.from([220, 30, 30, 220, 30, 30]); // 2x1 red, red
    const img = bufferToDataUrl(await sharp(px, { raw: { width: 2, height: 1, channels: 3 } }).png().toBuffer());
    const out = await rawPixels(await recolorCrop(img, 0, 100, [true, false]));
    expect([out.data[3], out.data[4], out.data[5]]).toEqual([220, 30, 30]); // unmasked untouched
    expect(out.data[0]).not.toBe(220); // masked pixel moved toward yellow
  });
});

describe('VF_SAM_MASKS in runGeneration (fake providers, offline)', () => {
  it.skipIf(!existsSync(ssePath))('local recolor is confined to the SAM mask; unmasked object pixels stay original', async () => {
    // A REAL mask from the saved spike SSE stands in for the fake provider's SAM output.
    const objects = parseSamOutput(parseSseOutputText(readFileSync(ssePath, 'utf8')));
    const samMask = objects.find(o => o.mask)?.mask as SamMask;
    expect(samMask, 'saved spike SSE must carry a mask').toBeTruthy();
    const raster = decodeMaskToRaster(samMask);
    const mw = samMask.width, mh = samMask.height;
    // Assertion pixels chosen from the decoded raster itself: a deep-interior 1
    // (whole 3x3 neighborhood is 1) and an isolated 0 (whole neighborhood 0, so the
    // 1px dilation in the recolor path cannot reach it either).
    const at = (x: number, y: number) => (x < 0 || y < 0 || x >= mw || y >= mh ? 0 : raster[y * mw + x]);
    let inside: [number, number] | null = null, outside: [number, number] | null = null;
    for (let y = 1; y < mh - 1 && (!inside || !outside); y++) for (let x = 1; x < mw - 1; x++) {
      let ones = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) ones += at(x + dx, y + dy);
      if (!inside && ones === 9) inside = [x, y];
      if (!outside && ones === 0) outside = [x, y];
    }
    expect(inside, 'real mask needs an interior 1-pixel').toBeTruthy();
    expect(outside, 'real mask needs an isolated 0-pixel').toBeTruthy();
    // Frame 4x the mask so the object is 1/16 of the image area (whole object, <= 8%).
    const W = mw * 4, H = mh * 4, ox = mw, oy = mh;
    const base = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 120, g: 120, b: 120 } } })
      .composite([{ input: await sharp({ create: { width: mw, height: mh, channels: 3, background: { r: 220, g: 30, b: 30 } } }).png().toBuffer(), left: ox, top: oy }])
      .png().toBuffer();
    const fake: Providers = {
      segmentation: { name: 'fake', isMock: true, segment: async () => [{ id: 'r1', bbox: { x: ox, y: oy, width: mw, height: mh }, samMask }] },
      vision: {
        name: 'fake', isMock: true,
        moderate: async () => ({ ok: true, reason: 'ok' }),
        plan: async () => [{ id: 'c1', regionId: 'r1', type: 'change color', description: 'square turned yellow', editPrompt: 'turn it yellow', targetColor: 'yellow' }],
        verify: async () => ({ ok: true, notes: 'ok' }),
      },
      imageEdit: { name: 'fake', isMock: true, editMaskedRegion: async () => { throw new Error('local recolor must handle it'); }, generateScene: async () => ({ image: '' }) },
    };
    process.env.VF_SAM_MASKS = 'true';
    try {
      const job = createJob('game', true);
      await runGeneration(job, { imageDataUrl: bufferToDataUrl(base) }, 1, fake);
      expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
      const payload = getLevelPayload(job.levelId!)!;
      const { data, width } = await rawPixels(payload.modified);
      const pxAt = (x: number, y: number) => { const o = (y * width + x) * 3; return [data[o], data[o + 1], data[o + 2]]; };
      expect(pxAt(ox + inside![0], oy + inside![1])).not.toEqual([220, 30, 30]); // inside mask: recolored
      expect(pxAt(ox + outside![0], oy + outside![1])).toEqual([220, 30, 30]);    // outside mask (but inside bbox): untouched red
      const diffs = getDifferences(job.levelId!)!;
      expect(diffs[0].segmentation!.length).toBeGreaterThanOrEqual(8);
      expect(diffs[0].area_px!).toBeGreaterThan(30);
    } finally { delete process.env.VF_SAM_MASKS; }
  });

  it('QC COCO export carries the polygon segmentation and the REAL measured area', () => {
    const coco = buildQCCoco([
      { type: 'scratch', bbox: { x: 10, y: 10, width: 5, height: 2 }, verification_status: 'verified', segmentation: [10, 10, 15, 10, 15, 12, 10, 12], area_px: 7 },
      { type: 'dent', bbox: { x: 20, y: 30, width: 7, height: 7 }, verification_status: 'verified' },
    ], 400, 300, 'defective.png');
    expect(coco.annotations[0].segmentation).toEqual([[10, 10, 15, 10, 15, 12, 10, 12]]);
    expect(coco.annotations[0].area).toBe(7); // measured mask area, not bbox area (10)
    expect(coco.annotations[1].segmentation).toBeUndefined(); // absent -> bbox-only as before
    expect(coco.annotations[1].area).toBe(49);
  });
});
