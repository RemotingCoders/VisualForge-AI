import { describe, it, expect } from 'vitest';
import { maskToBBox, normalizeBBox, clickHits, scoreGame, enforceSpacing } from '../src/lib/engine/geometry';
import { measureDifferences, compositePixel, runPipeline } from '../src/lib/engine/pipeline';
import { MockProviders, selectProviders, MetaNotConfiguredError } from '../src/lib/engine/providers';
import { toCOCO, toYOLO } from '../src/lib/coco';
import { checkLimits, estimateCostUSD } from '../src/lib/limits';
import { RaceBook } from '../src/lib/race';

describe('mask→bbox (real measured bbox)', () => {
  it('finds tight bbox and null for empty', () => {
    const m = new Array(16).fill(false); m[1 * 4 + 2] = true; m[2 * 4 + 3] = true;
    expect(maskToBBox(m, 4, 4)).toEqual({ x: 2, y: 1, width: 2, height: 2 });
    expect(maskToBBox(new Array(16).fill(false), 4, 4)).toBeNull();
  });
  it('normalizes to 0–1', () => { expect(normalizeBBox({ x: 50, y: 25, width: 100, height: 50 }, 200, 100)).toEqual({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 }); });
});
describe('composite invariant', () => {
  it('outside mask stays pixel-identical', () => { expect(compositePixel(200, 10, false)).toBe(200); expect(compositePixel(200, 10, true)).toBe(10); });
  it('measure detects only changed pixels', () => {
    const a = new Uint8Array([10, 10, 10, 10]), b = new Uint8Array([10, 99, 10, 10]);
    expect(measureDifferences(a, b, 2, 2, 12)).toEqual([false, true, false, false]);
  });
});
describe('click + scoring', () => {
  it('tolerance hits near edge, misses far', () => {
    const bb = { x: 100, y: 100, width: 20, height: 20 };
    expect(clickHits({ x: 90, y: 110 }, bb, 14)).toBe(true); expect(clickHits({ x: 10, y: 10 }, bb, 14)).toBe(false);
  });
  it('score rewards finds, punishes mistakes/hints', () => { expect(scoreGame(7, 7, 0, 0, 0)).toBeGreaterThan(scoreGame(7, 7, 3, 1, 60)); expect(scoreGame(0, 7, 99, 0, 0)).toBe(0); });
  it('spacing drops overlapping changes', () => { expect(enforceSpacing([{ bbox: { x: 0, y: 0, width: 50, height: 50 } }, { bbox: { x: 10, y: 10, width: 50, height: 50 } }, { bbox: { x: 200, y: 200, width: 20, height: 20 } }])).toHaveLength(2); });
});
describe('pipeline with MOCK provider (tests only)', () => {
  it('runs all stages and measures real bbox', async () => {
    const m = new MockProviders(); const stages: string[] = [];
    const res = await runPipeline({ imageRef: 'x', width: 400, height: 300, mode: 'game', count: 3, providers: { segmentation: m, vision: m, imageEdit: m },
      measure: async () => { const a = new Array(400 * 300).fill(false); a[10 * 400 + 10] = true; return a; }, onStage: s => stages.push(s) });
    expect(res.isMock).toBe(true); expect(res.differences).toHaveLength(3); expect(stages).toContain('verifying'); expect(res.differences[0].bbox).toEqual({ x: 10, y: 10, width: 1, height: 1 });
  });
});
describe('providers + limits (credit protection)', () => {
  it('defaults to labeled mock; meta without kill-switch refuses', () => {
    expect(selectProviders({ AI_PROVIDER: 'mock' }).label).toContain('MOCK');
    expect(() => selectProviders({ AI_PROVIDER: 'meta' })).not.toThrow(); // construction ok
    const meta = selectProviders({ AI_PROVIDER: 'meta' }).providers;
    return expect(meta.segmentation.segment('x', 10, 10)).rejects.toBeInstanceOf(MetaNotConfiguredError);
  });
  it('limits + cost estimate', () => {
    expect(checkLimits({ changes: 99, jobsToday: 0 }).ok).toBe(false);
    expect(checkLimits({ changes: 3, jobsToday: 20 }).ok).toBe(false);
    expect(estimateCostUSD(7)).toBeGreaterThan(0);
  });
});
describe('multiplayer race: simultaneous clicks → one winner', () => {
  it('first valid write wins', () => { const r = new RaceBook(); expect(r.claim('rd1', 'd1', 'ana').alreadyClaimed).toBe(false); const s = r.claim('rd1', 'd1', 'ben'); expect(s.alreadyClaimed).toBe(true); expect(s.winner).toBe('ana'); });
});
describe('Meta verified shapes (no paid calls)', () => {
  it('parses SAM records per the verified grammar (frame, sparse ids, c=, data=H,W,enc)', async () => {
    const { parseSamOutput } = await import('../src/lib/engine/meta');
    // Real example shape from /docs/sam/reading-segmentation (H=rows first in data=)
    const out = parseSamOutput('<0f>0<|box;x1=353;y1=382;x2=453;y2=427;w=537;h=561|><|mask;x=0;y=0;data=46,101,~abc~def|>,2<|box;x1=516;y1=117;x2=536;y2=150;w=537;h=561;c=0.96|><|mask;x=0;y=0;c=0.96;data=34,21,!xyz|>');
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe('0'); expect(out[0].bbox).toEqual({ x: 353, y: 382, width: 100, height: 45 });
    expect(out[0].mask).toMatchObject({ height: 46, width: 101, encoding: 'lossless' });
    expect(out[1].id).toBe('2'); expect(out[1].confidence).toBeCloseTo(0.96);
    expect(out[1].mask).toMatchObject({ height: 34, width: 21, encoding: 'one_bit', confidence: 0.96 });
    expect(parseSamOutput('')).toEqual([]); // zero matches is valid, not an error
  });
  it('SAM request sends the verified /v1/responses streaming payload; SSE deltas accumulate', async () => {
    const { samSegmentConcept } = await import('../src/lib/engine/providers');
    let seen: any;
    const sse = 'data: {"type":"response.output_text.delta","delta":"<0f>0<|box;x1=10;y1=20;x2=110;y2=70;w=200;h=100|><|mask;x=0;y=0;data=5,5,!aa|>"}\n\ndata: {"type":"response.completed"}\n\ndata: [DONE]\n';
    const fakeFetch = async (url: string, init: any) => { seen = { url, init }; return { ok: true, text: async () => sse }; };
    const out = await samSegmentConcept('data:image/png;base64,AA', 'glasses', { META_REAL_CALLS_ENABLED: 'true', MODEL_API_KEY: 'test-key' }, fakeFetch as any);
    expect(seen.url).toBe('https://api.meta.ai/v1/responses');
    expect(JSON.parse(seen.init.body)).toEqual({ model: 'sam-3.1', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'glasses' }, { type: 'input_image', image_url: 'data:image/png;base64,AA' }] }], stream: true, metadata: { include_confidence: 'true', mask_encoding: 'one_bit' } });
    expect(seen.init.headers.Authorization).toBe('Bearer test-key');
    expect(out).toHaveLength(1); expect(out[0].bbox).toEqual({ x: 10, y: 20, width: 100, height: 50 });
  });
  it('Spark structured output uses text.format (Responses) and parses output_text JSON', async () => {
    const { sparkStructured, SPARK_SCHEMAS } = await import('../src/lib/engine/providers');
    let seen: any;
    const fakeFetch = async (url: string, init: any) => { seen = { url, init }; return { ok: true, json: async () => ({ output_text: '{"ok":true,"reason":"safe"}' }) }; };
    const out = await sparkStructured<{ ok: boolean; reason: string }>({ prompt: 'check', images: ['data:image/png;base64,AA'], schemaName: 'Moderation', schema: SPARK_SCHEMAS.moderation, env: { META_REAL_CALLS_ENABLED: 'true', MODEL_API_KEY: 'test-key' }, fetchFn: fakeFetch as any });
    expect(out).toEqual({ ok: true, reason: 'safe' });
    const body = JSON.parse(seen.init.body);
    expect(body.model).toBe('muse-spark-1.3');
    expect(body.text.format).toMatchObject({ type: 'json_schema', name: 'Moderation', strict: true });
    expect(body.input[0].content).toContainEqual({ type: 'input_image', image_url: 'data:image/png;base64,AA' });
  });
  it('muse-image edit sends the verified payload + Bearer key', async () => {
    const { museImageEdit } = await import('../src/lib/engine/providers');
    let seen: any; const fakeFetch = async (url: string, init: any) => { seen = { url, init }; return { ok: true, json: async () => ({}) }; };
    await museImageEdit('data:image/png;base64,AA', 'make it red', 1, { META_REAL_CALLS_ENABLED: 'true', MODEL_API_KEY: 'test-key' }, fakeFetch as any);
    expect(seen.url).toBe('https://api.meta.ai/v1/images/edits');
    expect(JSON.parse(seen.init.body)).toEqual({ model: 'muse-image-1.0', prompt: 'make it red', images: [{ image_url: 'data:image/png;base64,AA' }], n: 1 });
    expect(seen.init.headers.Authorization).toBe('Bearer test-key');
  });
});
describe('COCO/YOLO export', () => {
  it('produces valid COCO + normalized YOLO', () => {
    const c = toCOCO([{ id: 1, file_name: 'a.png', width: 100, height: 100 }], [{ imageId: 1, categoryId: 2, bbox: { x: 10, y: 20, width: 30, height: 40 } }], [{ id: 2, name: 'scratch' }]);
    expect(c.annotations[0].bbox).toEqual([10, 20, 30, 40]); expect(c.info.synthetic).toBe(true);
    expect(toYOLO({ x: 25, y: 25, width: 50, height: 50 }, 100, 100, 1)).toBe('1 0.500000 0.500000 0.500000 0.500000');
  });
});
