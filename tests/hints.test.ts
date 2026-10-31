import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';
import { createJob, getJob, runGeneration } from '../src/lib/server/jobs';
import { getDifferences } from '../src/lib/serverStore';
import { bufferToDataUrl } from '../src/lib/server/imageOps';
import { pickNextHint, fallbackDifficulty, fallbackHints } from '../src/lib/server/hints';
import { MockProviders } from '../src/lib/engine/providers';
import type { Providers, Difference } from '../src/lib/engine/types';

// Capability 2 (hints + per-difference difficulty) and the one-pass visibility floor.
// ALL offline with fake providers — no paid calls.

const diff = (id: string, difficulty: number | undefined, hints?: string[]): Difference => ({
  id, type: 'add object', description: `desc ${id}`,
  bbox: { x: 0, y: 0, width: 10, height: 10 }, bbox_normalized: { x: 0, y: 0, width: 0.1, height: 0.1 },
  mask_url: null, severity: 'medium', verification_status: 'verified', verifier_notes: '',
  ...(difficulty !== undefined ? { difficulty } : {}), ...(hints ? { hints } : {}),
});

describe('pickNextHint (capability 2)', () => {
  const diffs = [
    diff('hard-one', 5, ['h1', 'h2', 'h3']),
    diff('easy-one', 1, ['e1', 'e2', 'e3']),
    diff('mid-one', 3, ['m1', 'm2', 'm3']),
  ];
  it('targets the pending difference with the LOWEST difficulty first', () => {
    expect(pickNextHint(diffs, [], {})).toMatchObject({ differenceId: 'easy-one', hint: 'e1', hintNumber: 1, difficulty: 1, provisional: false });
  });
  it('progresses 1→2→3 within that difference, then moves to the next easiest', () => {
    expect(pickNextHint(diffs, [], { 'easy-one': 1 })).toMatchObject({ differenceId: 'easy-one', hint: 'e2', hintNumber: 2 });
    expect(pickNextHint(diffs, [], { 'easy-one': 3 })).toMatchObject({ differenceId: 'mid-one', hint: 'm1', hintNumber: 1 });
  });
  it('skips found differences and returns null when everything is exhausted', () => {
    expect(pickNextHint(diffs, ['easy-one'], {})).toMatchObject({ differenceId: 'mid-one', hint: 'm1' });
    expect(pickNextHint(diffs, ['easy-one', 'mid-one', 'hard-one'], {})).toBeNull();
    expect(pickNextHint(diffs, [], { 'easy-one': 3, 'mid-one': 3, 'hard-one': 3 })).toBeNull();
  });
  it('falls back to positional hints + area-estimated difficulty (demo / pre-capability levels)', () => {
    const bare = diff('bare', undefined);
    expect(fallbackDifficulty(bare)).toBe(4); // 1% of the image = small, hard to spot
    const hints = fallbackHints(bare);
    expect(hints).toHaveLength(3);
    expect(hints[2]).toBe('desc bare'); // last resort names the change
    expect(pickNextHint([bare], [], {})).toMatchObject({ differenceId: 'bare', hintNumber: 1, provisional: true }); // no Spark hints yet -> positional, marked provisional
  });
  it('MockProviders writes labeled MOCK hints (offline only)', async () => {
    const m = new MockProviders();
    const out = await m.generateHints([{ index: 0, description: 'x', type: 'other', bbox_normalized: { x: 0.75, y: 0.75, width: 0.02, height: 0.02 } }]);
    expect(out[0].hints).toHaveLength(3);
    expect(out[0].hints[0]).toContain('MOCK');
    expect(out[0].difficulty).toBe(4);
  });
});

const solidPng = async (w: number, h: number, rgb: [number, number, number]) =>
  bufferToDataUrl(await sharp({ create: { width: w, height: h, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer());

const rawPixels = async (dataUrl: string) => {
  const { data, info } = await sharp(Buffer.from(dataUrl.split(',')[1], 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
};

describe('runGeneration: hints call + visibility floor (fake providers)', () => {
  it('level publishes BEFORE the ONE background generateHints call lands hints + difficulty', async () => {
    let hintCalls = 0;
    const fake: Providers = {
      segmentation: { name: 'fake', isMock: true, segment: async () => [{ id: 'r1', bbox: { x: 40, y: 25, width: 10, height: 8 } }] },
      vision: {
        name: 'fake', isMock: true,
        moderate: async () => ({ ok: true, reason: 'ok' }),
        plan: async () => [{ id: 'c1', regionId: 'r1', type: 'change color', description: 'square turned yellow', editPrompt: 'turn it yellow', targetColor: 'yellow' }],
        verify: async () => ({ ok: true, notes: 'ok' }),
        generateHints: async (items: { index: number }[]) => { hintCalls++; return items.map(i => ({ index: i.index, difficulty: 4, hints: ['vague', 'narrower', 'precise'] })); },
      },
      imageEdit: { name: 'fake', isMock: true, editMaskedRegion: async () => { throw new Error('local recolor must handle it'); }, generateScene: async () => ({ image: '' }) },
    };
    const scene = await sharp({ create: { width: 100, height: 80, channels: 3, background: { r: 120, g: 120, b: 120 } } })
      .composite([{ input: await sharp({ create: { width: 10, height: 8, channels: 3, background: { r: 220, g: 30, b: 30 } } }).png().toBuffer(), left: 40, top: 25 }])
      .png().toBuffer();
    const job = createJob('game', true);
    await runGeneration(job, { imageDataUrl: bufferToDataUrl(scene) }, 1, fake);
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done'); // published immediately — hints must not block
    // The background call lands the hints on the stored difference objects.
    await vi.waitFor(() => {
      const d = getDifferences(job.levelId!)![0];
      expect(d.hints).toEqual(['vague', 'narrower', 'precise']);
      expect(d.difficulty).toBe(4);
    });
    expect(hintCalls).toBe(1);
  });

  it('medium visibility floor is a PRIORITY: the strong component ships first, the faint one is only held as last resort', async () => {
    // Fake Muse paints a STRONG red square (amp ~110, above the medium floor of 35)
    // and a FAINT gray one (amp ~30, below it): with count=1 the strong one ships in
    // the pass itself and the faint one is merely held — the count is already met,
    // so the last-resort step never runs.
    const editFull = async (imageRef: string) => {
      const { data, width, height } = await rawPixels(imageRef);
      const out = Buffer.from(data);
      for (let y = 50; y < 62; y++) for (let x = 60; x < 74; x++) { const o = (y * width + x) * 3; out[o] = 230; out[o + 1] = 30; out[o + 2] = 30; }
      for (let y = 10; y < 22; y++) for (let x = 10; x < 24; x++) { const o = (y * width + x) * 3; out[o] = 150; out[o + 1] = 150; out[o + 2] = 150; }
      return bufferToDataUrl(await sharp(out, { raw: { width, height, channels: 3 } }).png().toBuffer());
    };
    const fake: Providers = {
      segmentation: { name: 'fake', isMock: true, segment: async () => [] },
      vision: {
        name: 'fake', isMock: true,
        moderate: async () => ({ ok: true, reason: 'ok' }),
        plan: async () => [], verify: async () => ({ ok: true, notes: 'ok' }),
        reviewDifferences: async (pairs: { index: number }[]) => pairs.map(p => ({ index: p.index, ok: true, description: `change ${p.index}`, type: 'add object', notes: 'ok' })),
      },
      imageEdit: { name: 'fake', isMock: true, editMaskedRegion: async () => { throw new Error('not used'); }, editFullImage: editFull, generateScene: async () => ({ image: '' }) },
    };
    const job = createJob('game', true, 1, 'medium');
    await runGeneration(job, { imageDataUrl: await solidPng(100, 80, [120, 120, 120]) }, 1, fake);
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
    const diffs = getDifferences(job.levelId!)!;
    expect(diffs).toHaveLength(1);
    expect(diffs[0].bbox.x).toBeGreaterThanOrEqual(55); // the strong red square, not the faint one
  });
});
