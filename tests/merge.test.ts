import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { bufferToDataUrl, extractOnePassComponents } from '../src/lib/server/imageOps';
import { createJob, getJob, runGeneration } from '../src/lib/server/jobs';
import { getDifferences, getLevelPayload } from '../src/lib/serverStore';
import { bboxGap, unionBBox } from '../src/lib/engine/geometry';
import { normalizeChangeDescription, changeDescriptionKey } from '../src/lib/engine/descriptions';
import type { Providers } from '../src/lib/engine/types';

/** Moon-flag regression (fake providers only, no real calls): ONE red flag was
 *  counted as THREE differences — cloth, pole and base extracted as separate
 *  components (the pole is too thin to bridge them) and Spark described each
 *  with the same phrase at a different location, so exact-text dedupe missed.
 *  Fixes under test: 10px grouping dilation in extraction, Spark sameChangeAs,
 *  location-stripped description dedupe, and the 6%-of-smaller-side
 *  minimum-separation fusion after review. */

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
const RED: [number, number, number] = [230, 30, 30];

describe('location-stripped description dedupe', () => {
  it('three descriptions equal except for the location phrase normalize identically', () => {
    const a = normalizeChangeDescription('A small red flag appeared at the lower right');
    const b = normalizeChangeDescription('A small red flag appeared next to the rock');
    const c = normalizeChangeDescription('A small red flag appeared in front of the large rock');
    expect(a).toBe('a small red flag appeared');
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(changeDescriptionKey('add object', 'A small red flag appeared at the lower right'))
      .toBe(changeDescriptionKey('add object', 'A small red flag appeared next to the rock'));
  });

  it('keeps genuinely different descriptions distinct', () => {
    expect(normalizeChangeDescription('The white wolf turned gray')).toBe('the white wolf turned gray');
    expect(changeDescriptionKey('add object', 'A red flag appeared'))
      .not.toBe(changeDescriptionKey('add object', 'A blue flag appeared'));
  });
});

describe('bboxGap / unionBBox (minimum separation)', () => {
  it('measures the gap between close boxes and unions them', () => {
    const cloth = { x: 100, y: 50, width: 36, height: 18 };
    const pole = { x: 115, y: 73, width: 6, height: 30 };
    expect(bboxGap(cloth, pole)).toBe(5);
    expect(bboxGap(cloth, cloth)).toBe(0);
    expect(unionBBox(cloth, pole)).toEqual({ x: 100, y: 50, width: 36, height: 53 });
  });
});

describe('one-pass grouping dilation (thin connectors)', () => {
  it('three vertically aligned components 5px apart produce ONE component; a far edit stays separate', async () => {
    const original = await solidPng(240, 200, [120, 120, 120]);
    // A "flag": cloth, thin pole, base — 5px gaps a thin connector cannot bridge
    // undilated; plus one unrelated far-away edit.
    const edited = await paintRects(original, [
      { x: 100, y: 50, width: 36, height: 18, rgb: RED },
      { x: 115, y: 73, width: 6, height: 30, rgb: RED },
      { x: 104, y: 108, width: 28, height: 12, rgb: RED },
      { x: 190, y: 150, width: 20, height: 20, rgb: [30, 30, 230] },
    ]);
    const { components } = await extractOnePassComponents(original, edited);
    expect(components).toHaveLength(2);
    const flag = components.find(c => c.bbox.x <= 106 && c.bbox.y <= 56)!;
    expect(flag).toBeDefined();
    // The fused component spans cloth (y=50) through base (y=120), measured mask
    // undilated: its bbox hugs the painted parts (± a few px of blur slack).
    expect(flag.bbox.y + flag.bbox.height).toBeGreaterThanOrEqual(116);
    expect(flag.bbox.width).toBeLessThanOrEqual(44);
  });
});

const flagSquares = [
  { x: 10, y: 10, width: 14, height: 12, rgb: RED },
  { x: 90, y: 60, width: 14, height: 12, rgb: RED },
  { x: 160, y: 10, width: 14, height: 12, rgb: RED },
];
const fakeProviders = (review: (pairs: { index: number }[]) => unknown[]): Providers => ({
  segmentation: { name: 'fake', isMock: true, segment: async () => [] },
  vision: {
    name: 'fake', isMock: true,
    moderate: async () => ({ ok: true, reason: 'ok' }),
    plan: async () => [], verify: async () => ({ ok: true, notes: 'ok' }),
    reviewDifferences: async (pairs: { index: number }[]) => review(pairs) as never,
  },
  imageEdit: {
    name: 'fake', isMock: true,
    editMaskedRegion: async () => { throw new Error('crop edit must not run when one-pass delivers'); },
    editFullImage: async (imageRef: string) => paintRects(imageRef, flagSquares),
    generateScene: async () => ({ image: '' }),
  },
});

describe('one flag, one difference (generation, fake providers)', () => {
  it('three descriptions equal except location dedupe to a single difference', async () => {
    const descriptions = [
      'A small red flag appeared at the lower right',
      'A small red flag appeared next to the rock',
      'A small red flag appeared in front of the large rock',
    ];
    const fake = fakeProviders(pairs => pairs.map(p => ({ index: p.index, ok: true, description: descriptions[p.index] ?? descriptions[0], type: 'add object', notes: 'fake review ok', sameChangeAs: -1 })));
    const job = createJob('game', true);
    await runGeneration(job, { imageDataUrl: await solidPng(200, 160, [120, 120, 120]) }, 1, fake);
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
    const diffs = getDifferences(job.levelId!)!;
    expect(diffs).toHaveLength(1);
    expect(diffs[0].description).toBe(descriptions[0]); // equal areas: first (strongest) kept
  });

  it('Spark sameChangeAs fuses parts of one change even with different descriptions — no pixels lost', async () => {
    const fake = fakeProviders(pairs => pairs.map(p => ({
      index: p.index, ok: true,
      description: ['A red square appeared', 'A crimson block materialized', 'A scarlet tile showed up'][p.index] ?? 'A red square appeared',
      type: 'add object', notes: 'fake review ok', sameChangeAs: p.index === 0 ? -1 : 0,
    })));
    const job = createJob('game', true);
    await runGeneration(job, { imageDataUrl: await solidPng(200, 160, [120, 120, 120]) }, 1, fake);
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
    const diffs = getDifferences(job.levelId!)!;
    expect(diffs).toHaveLength(1);
    // Union box spans all three squares (10..174 x 10..72), with the alignment
    // slack the flat synthetic scene induces (±10 px, calibration-test style):
    expect(diffs[0].bbox.x).toBeLessThanOrEqual(20);
    expect(diffs[0].bbox.x + diffs[0].bbox.width).toBeGreaterThanOrEqual(164);
    expect(diffs[0].bbox.y).toBeLessThanOrEqual(20);
    expect(diffs[0].bbox.y + diffs[0].bbox.height).toBeGreaterThanOrEqual(62);
    // And every part's pixels survived the fusion in the modified image (one
    // lone square would measure ~160 red px; the three fused parts ~480):
    const payload = getLevelPayload(job.levelId!)!;
    const { data } = await rawPixels(payload.modified);
    let redPx = 0;
    for (let i = 0; i < data.length; i += 3) if (data[i] > 200 && data[i + 1] < 80 && data[i + 2] < 80) redPx++;
    expect(redPx).toBeGreaterThan(400);
  });
});
