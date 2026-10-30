import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { normalizeImage, estimateAlignment, alignEditedCrop, extractOnePassComponents, bufferToDataUrl } from '../src/lib/server/imageOps';

/**
 * Offline calibration for one-pass extraction (step 3) — NO paid calls.
 * Uses the saved Muse one-pass output in debug-runs/ (git-ignored) against test.jpeg.
 * Goal: EXACTLY 3 components — the droplet on the upper petal, the ladybug on the stem,
 * and the vanished bud at the top. Skipped automatically when the debug files are absent.
 */
const RETURNED = 'debug-runs/muse-one-pass-2026-10-30T21-10-54-350Z.png';
const available = existsSync(RETURNED) && existsSync('test.jpeg');

describe.skipIf(!available)('one-pass extraction calibration (offline, saved spike output)', () => {
  it('separates exactly the 3 real edits from re-render noise', async () => {
    const original = await normalizeImage(`data:image/jpeg;base64,${readFileSync('test.jpeg').toString('base64')}`, 1024);
    const edited = bufferToDataUrl(readFileSync(RETURNED));
    const est = await estimateAlignment(original.dataUrl, edited);
    console.log(`alignment: shift (${est.shiftX}, ${est.shiftY}) scale ${est.scale} residual ${est.error.toFixed(1)}`);
    const aligned = await alignEditedCrop(original.dataUrl, edited, est);
    const { components, discarded } = await extractOnePassComponents(original.dataUrl, aligned);
    for (const d of discarded) console.log(`discarded: ${d.area}px amp ${d.meanAmp.toFixed(1)} bbox (${d.bbox.x},${d.bbox.y}) ${d.bbox.width}x${d.bbox.height} — ${d.reason}`);
    for (const c of components) console.log(`component: ${c.area}px amp ${c.meanAmp.toFixed(1)} score ${Math.round(c.score)} bbox (${c.bbox.x},${c.bbox.y}) ${c.bbox.width}x${c.bbox.height}`);
    expect(components).toHaveLength(3);
    // The three known edits (554x554 coordinate space, loose boxes):
    const has = (x0: number, y0: number, x1: number, y1: number) => components.some(c => c.bbox.x >= x0 && c.bbox.y >= y0 && c.bbox.x + c.bbox.width <= x1 && c.bbox.y + c.bbox.height <= y1);
    expect(has(360, 70, 470, 170), 'droplet on the upper petal').toBe(true);
    expect(has(430, 450, 554, 554), 'ladybug on the stem').toBe(true);
    expect(has(200, 0, 360, 130), 'vanished bud at the top').toBe(true);
  }, 60_000);
});
