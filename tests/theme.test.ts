import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';
import { museImageGenerateScene, sparkStructured, anonymousUserId, ThemeRejectedError, MockProviders, SPARK_SCHEMAS, selectProviders } from '../src/lib/engine/providers';
import { createJob, getJob, runGeneration } from '../src/lib/server/jobs';
import { issueThemeTicket, consumeThemeTicket } from '../src/lib/server/themeTickets';
import { getDifferences, getLevelPayload } from '../src/lib/serverStore';
import { bufferToDataUrl } from '../src/lib/server/imageOps';
import type { Providers } from '../src/lib/engine/types';

// Capability 4 (VF_THEME_GENERATION): theme -> Spark text moderation -> Muse Image
// generation -> the usual pipeline. ALL tests are offline (stub fetch / fake
// providers) — no paid calls.

const env = { META_REAL_CALLS_ENABLED: 'true', MODEL_API_KEY: 'test-key-for-hash' };

const captureFetch = (respond: () => { ok: boolean; status: number; json?: unknown; text?: string }) => {
  const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const fetchFn = async (url: string, init: { body: string; headers: Record<string, string> }) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const r = respond();
    return { ok: r.ok, status: r.status, json: async () => r.json, text: async () => r.text ?? '' };
  };
  return { calls, fetchFn: fetchFn as unknown as typeof fetch };
};

describe('museImageGenerateScene (stub fetch, offline)', () => {
  it('sends the docs-verified generation request and maps revised_prompt back', async () => {
    const { calls, fetchFn } = captureFetch(() => ({ ok: true, status: 200, json: { data: [{ b64_json: 'QUJD', revised_prompt: 'a red fox in an autumn garden' }], output_format: 'webp' } }));
    const scene = await museImageGenerateScene('un jardín otoñal con un zorro', env, fetchFn);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.meta.ai/v1/images/generations');
    expect(calls[0].headers.Authorization).toBe('Bearer test-key-for-hash');
    const b = calls[0].body;
    expect(b.model).toBe('muse-image-1.0');
    expect(b.prompt).toContain('un jardín otoñal con un zorro');
    expect(b.prompt).toContain('at least 8'); // scene brief: segmentable material for SAM
    expect(b.prompt).toContain('no people');
    expect(b.n).toBe(1);
    expect(b.size).toBe('1024x768'); // aspect only per docs (longest edge <= 1024)
    expect(b.reasoning_strength).toBe('high');
    expect(b.tool_enablement).toEqual({ web_search: false, use_entertainment_tool: false, use_sports_tool: false });
    expect(b.user).toMatch(/^vf-[0-9a-f]{24}$/); // stable opaque id, never PII
    expect(b).not.toHaveProperty('moderation'); // muse-image-1.0 rejects it with 400 — Spark-only enum
    expect(scene.image).toBe('data:image/webp;base64,QUJD');
    expect(scene.revisedPrompt).toBe('a red fox in an autumn garden');
  });

  it('kind "part" (QC describe-a-part) asks for ONE part photo, not a game scene', async () => {
    const { calls, fetchFn } = captureFetch(() => ({ ok: true, status: 200, json: { data: [{ b64_json: 'QUJD' }], output_format: 'webp' } }));
    await museImageGenerateScene('una brida de acero con seis agujeros', env, fetchFn, 'part');
    const p = String(calls[0].body.prompt);
    expect(p).toContain('una brida de acero con seis agujeros');
    expect(p).toContain('single manufactured part');
    expect(p).toContain('One part only');
    expect(p).not.toContain('spot-the-difference');
    expect(p).not.toContain('at least 8');
  });

  it('honors VF_SCENE_REASONING and keeps the anonymous user id stable per key', async () => {
    const { calls, fetchFn } = captureFetch(() => ({ ok: true, status: 200, json: { data: [{ b64_json: 'QUJD' }], output_format: 'png' } }));
    const scene = await museImageGenerateScene('una playa al atardecer', { ...env, VF_SCENE_REASONING: 'low' }, fetchFn);
    expect(calls[0].body.reasoning_strength).toBe('low');
    expect(scene.revisedPrompt).toBeUndefined(); // absent in response -> absent in result
    expect(anonymousUserId(env)).toBe(anonymousUserId(env));
    expect(anonymousUserId(env)).not.toContain('test-key');
  });

  it('maps a 400 content_policy_violation to ThemeRejectedError (and only that)', async () => {
    const blocked = captureFetch(() => ({ ok: false, status: 400, text: '{"error":{"code":"content_policy_violation","message":"blocked"}}' }));
    await expect(museImageGenerateScene('tema bloqueado', env, blocked.fetchFn)).rejects.toBeInstanceOf(ThemeRejectedError);
    const boom = captureFetch(() => ({ ok: false, status: 500, text: 'server exploded' }));
    const err = await museImageGenerateScene('tema cualquiera', env, boom.fetchFn).catch(e => e);
    expect(err).toBeInstanceOf(Error); expect(err).not.toBeInstanceOf(ThemeRejectedError);
    expect(String(err.message)).toContain('HTTP 500');
  });
});

describe('theme moderation plumbing', () => {
  it('sparkStructured with no images sends a text-only content array', async () => {
    const { calls, fetchFn } = captureFetch(() => ({ ok: true, status: 200, json: { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ ok: true, reason: 'fine' }) }] }] } }));
    const out = await sparkStructured<{ ok: boolean; reason: string }>({ prompt: 'judge this theme', schemaName: 'Moderation', schema: SPARK_SCHEMAS.moderation, env, fetchFn });
    expect(out).toEqual({ ok: true, reason: 'fine' });
    const input = calls[0].body.input as { content: unknown[] }[];
    expect(input[0].content).toEqual([{ type: 'input_text', text: 'judge this theme' }]); // no input_image parts
  });

  it('MockProviders labels its theme moderation as MOCK and echoes the theme as cleanTheme', async () => {
    const m = new MockProviders();
    const mod = await m.moderateTheme!('un castillo de arena');
    expect(mod.ok).toBe(true); expect(mod.reason).toContain('MOCK');
    expect(mod.cleanTheme).toBe('un castillo de arena'); // no real tidy-up offline — never invented
    const scene = await m.generateScene('un castillo de arena');
    expect(scene.image).toContain('mock-scene:');
  });

  it('Meta moderateTheme returns cleanTheme from the SAME structured call (stub fetch)', async () => {
    const prevKey = process.env.MODEL_API_KEY; const prevKill = process.env.META_REAL_CALLS_ENABLED;
    process.env.MODEL_API_KEY = 'test-key-for-hash'; process.env.META_REAL_CALLS_ENABLED = 'true';
    const { calls, fetchFn } = captureFetch(() => ({ ok: true, status: 200, json: { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ ok: true, reason: 'fine', cleanTheme: 'una brida de acero con seis agujeros' }) }] }] } }));
    vi.stubGlobal('fetch', fetchFn);
    try {
      const { providers } = selectProviders({ AI_PROVIDER: 'meta' });
      const mod = await providers.vision.moderateTheme!('ehm una brida… no, mejor una brida de acero con seis agujeros');
      expect(mod).toEqual({ ok: true, reason: 'fine', cleanTheme: 'una brida de acero con seis agujeros' });
      expect(calls).toHaveLength(1); // moderation + tidy-up ride ONE Spark call
      expect(calls[0].url).toContain('/v1/responses');
      const fmt = (calls[0].body.text as { format: { name: string; schema: unknown } }).format;
      expect(fmt.name).toBe('ThemeModeration');
      expect(JSON.stringify(fmt.schema)).toContain('cleanTheme');
      const prompt = String((calls[0].body.input as { content: { text: string }[] }[])[0].content[0].text);
      expect(prompt).toContain('SAME language'); // rewrite keeps the dictated language
      expect(prompt).toContain('self-corrections');
    } finally {
      vi.unstubAllGlobals();
      if (prevKey === undefined) delete process.env.MODEL_API_KEY; else process.env.MODEL_API_KEY = prevKey;
      if (prevKill === undefined) delete process.env.META_REAL_CALLS_ENABLED; else process.env.META_REAL_CALLS_ENABLED = prevKill;
    }
  });

  it('themeModeration schema requires cleanTheme (the shared moderation schema stays untouched)', () => {
    expect(SPARK_SCHEMAS.themeModeration.required).toEqual(['ok', 'reason', 'cleanTheme']);
    expect(SPARK_SCHEMAS.moderation.required).toEqual(['ok', 'reason']); // image moderation must not change
  });
});

const scenePng = async () => {
  const base = await sharp({ create: { width: 100, height: 80, channels: 3, background: { r: 120, g: 120, b: 120 } } })
    .composite([{ input: await sharp({ create: { width: 10, height: 8, channels: 3, background: { r: 220, g: 30, b: 30 } } }).png().toBuffer(), left: 40, top: 25 }])
    .png().toBuffer();
  return bufferToDataUrl(base);
};

const themeFake = async (over: Partial<{ themeOk: boolean; sceneError?: Error }> = {}) => {
  const order: string[] = [];
  const scene = await scenePng();
  const fake: Providers = {
    segmentation: { name: 'fake', isMock: true, segment: async () => [{ id: 'r1', bbox: { x: 40, y: 25, width: 10, height: 8 } }] },
    vision: {
      name: 'fake', isMock: true,
      moderate: async () => ({ ok: true, reason: 'ok' }),
      moderateTheme: async () => { order.push('moderateTheme'); return over.themeOk === false ? { ok: false, reason: 'unsafe theme' } : { ok: true, reason: 'ok' }; },
      plan: async () => [{ id: 'c1', regionId: 'r1', type: 'change color', description: 'square turned yellow', editPrompt: 'turn it yellow', targetColor: 'yellow' }],
      verify: async () => ({ ok: true, notes: 'ok' }),
    },
    imageEdit: {
      name: 'fake', isMock: true,
      editMaskedRegion: async () => { throw new Error('local recolor must handle it'); },
      generateScene: async () => { order.push('generateScene'); if (over.sceneError) throw over.sceneError; return { image: scene, revisedPrompt: 'revised scene prompt' }; },
    },
  };
  return { fake, order, scene };
};

describe('runGeneration with a theme (fake providers, offline)', () => {
  it('moderates BEFORE generating, then runs the normal pipeline on the scene', async () => {
    const { fake, order, scene } = await themeFake();
    const job = createJob('game', true);
    await runGeneration(job, { theme: 'un jardín otoñal' }, 1, fake);
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
    expect(order).toEqual(['moderateTheme', 'generateScene']); // hard rule: no paid generation before moderation passes
    expect(job.previewImage).toBe(scene); // exposed for Play's live preview
    const payload = getLevelPayload(job.levelId!)!;
    expect(payload.theme).toBe('un jardín otoñal');
    expect(payload.revisedPrompt).toBe('revised scene prompt');
    expect(payload.total).toBe(1);
    expect(getDifferences(job.levelId!)).toHaveLength(1);
  });

  it('a rejected theme fails as theme_rejected and NEVER calls generateScene', async () => {
    const { fake, order } = await themeFake({ themeOk: false });
    const job = createJob('game', true);
    await runGeneration(job, { theme: 'tema inseguro' }, 1, fake);
    expect(getJob(job.id)?.status).toBe('failed');
    expect(getJob(job.id)?.error).toBe('theme_rejected');
    expect(order).toEqual(['moderateTheme']); // generation never attempted — nothing billed
  });

  it('a Muse Image safety rejection also fails as theme_rejected', async () => {
    const { fake } = await themeFake({ sceneError: new ThemeRejectedError('content_policy_violation') });
    const job = createJob('game', true);
    await runGeneration(job, { theme: 'tema límite' }, 1, fake);
    expect(getJob(job.id)?.status).toBe('failed');
    expect(getJob(job.id)?.error).toBe('theme_rejected');
  });

  it('a provider without moderateTheme fails loudly instead of skipping moderation', async () => {
    const { fake } = await themeFake();
    delete (fake.vision as { moderateTheme?: unknown }).moderateTheme;
    const job = createJob('game', true);
    await runGeneration(job, { theme: 'un jardín otoñal' }, 1, fake);
    expect(getJob(job.id)?.status).toBe('failed');
    expect(getJob(job.id)?.error).toContain('moderateTheme missing');
    expect(getJob(job.id)?.error).not.toBe('theme_rejected');
  });

  it('themePreModerated (dictation ticket) skips the in-job moderation call entirely', async () => {
    const { fake, order } = await themeFake();
    (fake.vision as { moderateTheme?: unknown }).moderateTheme = async () => { throw new Error('moderateTheme must NOT be called twice'); };
    const job = createJob('game', true);
    await runGeneration(job, { theme: 'un jardín otoñal', themePreModerated: true }, 1, fake);
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
    expect(order).toEqual(['generateScene']); // moderation happened once, at dictation time
  });
});

describe('theme moderation tickets (dictation pre-check)', () => {
  const t0 = 1_000_000;
  it('consumes for the raw dictated text AND for the accepted cleanTheme', () => {
    expect(consumeThemeTicket(issueThemeTicket('ehm una playa', 'una playa', t0), 'ehm una playa', t0)).toBe(true);
    expect(consumeThemeTicket(issueThemeTicket('ehm una playa', 'una playa', t0), 'una playa', t0)).toBe(true);
  });
  it('rejects edited text (manual edit falls back to in-job moderation)', () => {
    expect(consumeThemeTicket(issueThemeTicket('ehm una playa', 'una playa', t0), 'una playa con palmeras', t0)).toBe(false);
  });
  it('is one-time: a ticket never validates twice', () => {
    const id = issueThemeTicket('una playa', 'una playa', t0);
    expect(consumeThemeTicket(id, 'una playa', t0)).toBe(true);
    expect(consumeThemeTicket(id, 'una playa', t0)).toBe(false);
  });
  it('rejects unknown and expired tickets', () => {
    expect(consumeThemeTicket('no-such-ticket', 'una playa', t0)).toBe(false);
    expect(consumeThemeTicket(undefined, 'una playa', t0)).toBe(false);
    expect(consumeThemeTicket(issueThemeTicket('una playa', 'una playa', t0), 'una playa', t0 + 11 * 60 * 1000)).toBe(false);
  });
});
