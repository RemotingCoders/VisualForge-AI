import { describe, it, expect, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sparkCostUsd, museImageCostUsd, SAM_USD_PER_IMAGE, MUSE_IMAGE_USD_PER_IMAGE } from '../src/lib/engine/pricing';
import { metaPost } from '../src/lib/engine/providers';
import { META_MODELS } from '../src/lib/engine/meta';
import { requireMetaAccess, META_ACCESS_MESSAGE } from '../src/lib/server/access';
import { spendCapConfig, recordSpend, spendTotalUsd, SPEND_CAP_EXHAUSTED_MESSAGE } from '../src/lib/server/spend';
import { POST as generatePOST } from '../src/app/api/generate/route';
import { POST as aiInspectPOST } from '../src/app/api/ai-inspect/route';

/** Credit-saving mode: real Meta prices, the single access rule on EVERY
 *  Meta-calling route, and the VF_SPEND_CAP_USD global budget. All offline —
 *  fake fetch, MOCK providers, in-memory spend ledger (Supabase is disabled
 *  under NODE_ENV=test). Unique IPs per test so rate-limit windows never bleed. */

afterEach(() => { vi.unstubAllEnvs(); });

describe('real Meta prices (dev.meta.ai/docs/pricing-rate-limits)', () => {
  it('Spark: $1.25 input / $4.25 output per 1M tokens, cached input $0.15', () => {
    expect(sparkCostUsd({ input_tokens: 1_000_000, output_tokens: 0 })).toBeCloseTo(1.25, 10);
    expect(sparkCostUsd({ input_tokens: 0, output_tokens: 1_000_000 })).toBeCloseTo(4.25, 10);
    expect(sparkCostUsd({ input_tokens: 2000, output_tokens: 500 })).toBeCloseTo((2000 * 1.25 + 500 * 4.25) / 1_000_000, 10);
    expect(sparkCostUsd({ input_tokens: 1_000_000, output_tokens: 0, input_tokens_details: { cached_tokens: 1_000_000 } })).toBeCloseTo(0.15, 10);
    expect(sparkCostUsd(undefined)).toBe(0);
    expect(sparkCostUsd({})).toBe(0);
  });

  it('SAM is $0.0025 per image and Muse Image $0.01 per returned image', () => {
    expect(SAM_USD_PER_IMAGE).toBe(0.0025);
    expect(MUSE_IMAGE_USD_PER_IMAGE).toBe(0.01);
    expect(museImageCostUsd({ data: [{ b64_json: 'a' }, { b64_json: 'b' }] })).toBeCloseTo(0.02, 10);
    expect(museImageCostUsd({ data: [] })).toBeNull();
    expect(museImageCostUsd(null)).toBeNull();
  });

  it('metaPost records the REAL cost of a Spark call (from usage) and of a Muse edit (per image)', async () => {
    const env = { META_REAL_CALLS_ENABLED: 'true', MODEL_API_KEY: 'test-key', VF_NETWORK_RETRY_DELAY_MS: '0' };
    const before = await spendTotalUsd({ VF_SPEND_CAP_USD: '1000' });
    const sparkFetch = (async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ output: [], usage: { input_tokens: 1000, output_tokens: 1000 } }),
    })) as unknown as typeof fetch;
    await metaPost('/responses', { model: META_MODELS.spark }, env, sparkFetch);
    const editFetch = (async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ data: [{ b64_json: 'x' }] }),
    })) as unknown as typeof fetch;
    await metaPost('/images/edits', { model: META_MODELS.image }, env, editFetch);
    const after = await spendTotalUsd({ VF_SPEND_CAP_USD: '1000' });
    // Spark: (1000×1.25 + 1000×4.25)/1M = $0.0055 · Muse edit: 1 image × $0.01
    expect(after - before).toBeCloseTo(0.0055 + 0.01, 10);
  });
});

describe('VF_SPEND_CAP_USD / VF_SPEND_CAP_SINCE parsing', () => {
  it('unset or invalid cap disables the budget; SINCE defaults to the epoch', () => {
    expect(spendCapConfig({})).toBeNull();
    expect(spendCapConfig({ VF_SPEND_CAP_USD: 'abc' })).toBeNull();
    expect(spendCapConfig({ VF_SPEND_CAP_USD: '0' })).toBeNull();
    expect(spendCapConfig({ VF_SPEND_CAP_USD: '-5' })).toBeNull();
    const cfg = spendCapConfig({ VF_SPEND_CAP_USD: '25' });
    expect(cfg?.capUsd).toBe(25);
    expect(cfg?.since.getTime()).toBe(0); // count everything — never under-count
    expect(spendCapConfig({ VF_SPEND_CAP_USD: '25', VF_SPEND_CAP_SINCE: '2026-11-04' })?.since.toISOString()).toBe('2026-11-04T00:00:00.000Z');
    expect(spendCapConfig({ VF_SPEND_CAP_USD: '25', VF_SPEND_CAP_SINCE: 'garbage' })?.since.getTime()).toBe(0);
  });
});

describe('requireMetaAccess — the single gate', () => {
  it('401s with the exact judge message, passes with the code, open when unset', async () => {
    const env = { VF_ACCESS_CODE: 'judges-2026' };
    const denied = requireMetaAccess(undefined, env);
    expect(denied?.status).toBe(401);
    expect((await denied!.json()).error).toBe(META_ACCESS_MESSAGE);
    expect(META_ACCESS_MESSAGE).toBe("This action uses Meta's models and needs the judge access code from the hackathon submission. The gallery is free to play.");
    expect(requireMetaAccess('wrong', env)?.status).toBe(401);
    expect(requireMetaAccess('judges-2026', env)).toBeNull();
    expect(requireMetaAccess(undefined, {})).toBeNull();
  });
});

const genReq = (ip: string, body: Record<string, unknown>) => generatePOST(new Request('http://localhost/api/generate', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body),
}));
const inspectReq = (ip: string, body: Record<string, unknown>) => aiInspectPOST(new Request('http://localhost/api/ai-inspect', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body),
}));

describe('route gates: access first, then the spend cap (fake providers only)', () => {
  it('POST /api/generate: no code → 401 even when the budget is blown; code + blown budget → 429', async () => {
    vi.stubEnv('VF_ACCESS_CODE', 'judges-2026');
    vi.stubEnv('VF_SPEND_CAP_USD', '1');
    vi.stubEnv('VF_SPEND_CAP_SINCE', new Date(Date.now() - 3600_000).toISOString());
    recordSpend(5); // $5 already spent inside the window, cap is $1
    const noCode = await genReq('10.8.0.1', { count: 3, mode: 'game' });
    expect(noCode.status).toBe(401);
    const blown = await genReq('10.8.0.2', { count: 3, mode: 'game', accessCode: 'judges-2026' });
    expect(blown.status).toBe(429);
    expect((await blown.json()).error).toBe(SPEND_CAP_EXHAUSTED_MESSAGE);
    expect(SPEND_CAP_EXHAUSTED_MESSAGE).toBe('Budget for the judging period is exhausted; the gallery remains playable');
  });

  it('POST /api/generate: budget window in the future (nothing spent in it) → request proceeds', async () => {
    vi.stubEnv('VF_ACCESS_CODE', 'judges-2026');
    vi.stubEnv('VF_SPEND_CAP_USD', '1');
    vi.stubEnv('VF_SPEND_CAP_SINCE', new Date(Date.now() + 86400_000).toISOString());
    const res = await genReq('10.8.0.3', { count: 3, mode: 'game', accessCode: 'judges-2026' });
    expect(res.status).toBe(200);
    expect((await res.json()).isMock).toBe(true); // offline demo path — no paid call
  });

  it('POST /api/ai-inspect: gated like generation (the race/challenge is a paid Spark call)', async () => {
    vi.stubEnv('VF_ACCESS_CODE', 'judges-2026');
    vi.stubEnv('VF_SPEND_CAP_USD', '1');
    vi.stubEnv('VF_SPEND_CAP_SINCE', new Date(Date.now() - 3600_000).toISOString());
    const noCode = await inspectReq('10.9.0.1', { levelId: 'whatever' });
    expect(noCode.status).toBe(401);
    expect((await noCode.json()).error).toBe(META_ACCESS_MESSAGE);
    const blown = await inspectReq('10.9.0.2', { levelId: 'whatever', accessCode: 'judges-2026' });
    expect(blown.status).toBe(429);
    expect((await blown.json()).error).toBe(SPEND_CAP_EXHAUSTED_MESSAGE);
    vi.stubEnv('VF_SPEND_CAP_SINCE', new Date(Date.now() + 86400_000).toISOString());
    const through = await inspectReq('10.9.0.3', { levelId: 'whatever', accessCode: 'judges-2026' });
    expect(through.status).toBe(404); // gates passed — the level simply doesn't exist
  });
});

describe('every Meta-calling API route uses the single gates', () => {
  it('walks src/app/api: a route with Meta calls but no requireMetaAccess/enforceSpendCap fails', () => {
    const apiDir = join(process.cwd(), 'src/app/api');
    const routeFiles = readdirSync(apiDir, { recursive: true })
      .map(String).filter(f => f.endsWith('route.ts')).sort();
    expect(routeFiles.length).toBeGreaterThan(0);
    const META_TOKENS = ['selectProviders', 'runGeneration', 'sparkStructured', 'metaPost', 'inspectImage', 'moderateTheme'];
    const metaRoutes: string[] = [];
    for (const rel of routeFiles) {
      const src = readFileSync(join(apiDir, rel), 'utf8');
      if (!META_TOKENS.some(t => src.includes(t))) continue; // free route: gallery, level, clicks, saved hints, exports…
      metaRoutes.push(rel.replaceAll('\\', '/'));
      expect(src, `${rel} calls Meta but does not gate on the judge access code`).toContain('requireMetaAccess(');
      expect(src, `${rel} calls Meta but does not check the spend cap`).toContain('enforceSpendCap(');
    }
    // The known Meta surface today. A NEW Meta-calling route must be added here
    // consciously — and the two assertions above then apply to it.
    expect(metaRoutes).toEqual(['ai-inspect/route.ts', 'generate/route.ts']);
  });
});
