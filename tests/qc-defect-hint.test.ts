import { describe, it, expect, vi, afterEach } from 'vitest';
import sharp from 'sharp';
import { createJob, getJob, runGeneration } from '../src/lib/server/jobs';
import { getDifferences, getLevelPayload } from '../src/lib/serverStore';
import { bufferToDataUrl } from '../src/lib/server/imageOps';
import { selectProviders } from '../src/lib/engine/providers';
import { GET as qcRevealGET } from '../src/app/api/qc-reveal/route';
import { POST as generatePOST } from '../src/app/api/generate/route';
import type { PlannedChange, Providers } from '../src/lib/engine/types';

// QC "What defects should appear?" (defectHint) — fake providers only, no real
// calls:
//  - empty/absent = today's behavior (prompts byte-identical, nothing stored);
//  - with a hint, the SAME text moderation as themes gates it, the planner
//    receives the inspector sentence and its candidate order is respected,
//    and the one-pass + crop edit prompts carry the requested-defect text;
//  - descriptions/classification still come from what was measured — never
//    from the hint — and the hint is stored on the level (migration 0008),
//    shown by the reveal as "Requested: …";
//  - POST /api/generate accepts it in QC mode only, max 300 characters.

const HINT = 'rust on the bolt heads, a loose solder joint';
const SENTENCE = `The inspector asked for these defects, in priority order: ${HINT}.`;

const solidPng = async (w: number, h: number, rgb: [number, number, number]) =>
  bufferToDataUrl(await sharp({ create: { width: w, height: h, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer());
const paintPatternBlue = async (imageRef: string, region?: { bbox: { x: number; y: number; width: number; height: number } }) => {
  const { data, info } = await sharp(Buffer.from(imageRef.split(',')[1], 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.from(data);
  const b = region?.bbox ?? { x: 12, y: 12, width: Math.max(1, info.width - 24), height: Math.max(1, info.height - 24) };
  for (let y = Math.max(0, b.y); y < Math.min(info.height, b.y + b.height); y++) for (let x = Math.max(0, b.x); x < Math.min(info.width, b.x + b.width); x++) {
    const o = (y * info.width + x) * 3; out[o] = 30; out[o + 1] = 30; out[o + 2] = 220;
  }
  return bufferToDataUrl(await sharp(out, { raw: { width: info.width, height: info.height, channels: 3 } }).png().toBuffer());
};
const paintRects = async (imageRef: string, rects: { x: number; y: number; width: number; height: number; rgb: [number, number, number] }[]) => {
  const { data, info } = await sharp(Buffer.from(imageRef.split(',')[1], 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.from(data);
  for (const r of rects) for (let y = r.y; y < r.y + r.height; y++) for (let x = r.x; x < r.x + r.width; x++) {
    const o = (y * info.width + x) * 3; out[o] = r.rgb[0]; out[o + 1] = r.rgb[1]; out[o + 2] = r.rgb[2];
  }
  return bufferToDataUrl(await sharp(out, { raw: { width: info.width, height: info.height, channels: 3 } }).png().toBuffer());
};

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

// Two large candidates (above the medium floor), in the hint's priority
// order: the requested corrosion first, then an extra scratch.
const RUST: PlannedChange = { id: 'rust', regionId: 'part', type: 'corrosion', description: 'rust bloom on the bolt heads', editPrompt: 'add rust on the bolt heads', targetBox: { x: 30, y: 30, width: 24, height: 18 }, partConcept: 'bolt heads' };
const SCRATCH: PlannedChange = { id: 'scratch', regionId: 'part', type: 'scratch', description: 'long scratch across the flange', editPrompt: 'add a scratch', targetBox: { x: 180, y: 140, width: 24, height: 18 }, partConcept: 'flange face' };

const cropProviders = (seen: { planHint?: string; planCalls: number; editPrompts: string[]; moderateThemeCalls: string[] }, rejectHint = false): Providers => ({
  segmentation: { name: 'fake', isMock: true, segment: async () => [{ id: 'part', bbox: { x: 10, y: 10, width: 300, height: 220 } }] },
  vision: {
    name: 'fake', isMock: true,
    moderate: async () => ({ ok: true, reason: 'ok' }),
    moderateTheme: async (text: string) => { seen.moderateThemeCalls.push(text); return rejectHint && text === HINT ? { ok: false, reason: 'disallowed content' } : { ok: true, reason: 'ok' }; },
    plan: async (_img: string, _regions: unknown, _mode: string, _count: number, _difficulty?: string, defectHint?: string) => { seen.planCalls++; seen.planHint = defectHint; return [RUST, SCRATCH]; },
    verify: async () => ({ ok: true, notes: 'ok' }),
  },
  // No editFullImage: the crop pipeline must deliver.
  imageEdit: {
    name: 'fake', isMock: true,
    editMaskedRegion: async (imageRef: string, region: { bbox: { x: number; y: number; width: number; height: number } }, prompt: string) => { seen.editPrompts.push(prompt); return paintPatternBlue(imageRef, region); },
    generateScene: async () => ({ image: '' }),
  },
});
const newSeen = () => ({ planCalls: 0, editPrompts: [] as string[], moderateThemeCalls: [] as string[] }) as { planHint?: string; planCalls: number; editPrompts: string[]; moderateThemeCalls: string[] };

describe('QC defect hint — job flow (fake providers)', () => {
  it('with a hint: planner receives it, candidate order is respected, hint is stored and revealed', async () => {
    const seen = newSeen();
    const job = createJob('qc', true, 2, 'medium', HINT);
    await runGeneration(job, { imageDataUrl: await solidPng(320, 240, [120, 120, 120]) }, 2, cropProviders(seen));
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
    expect(seen.moderateThemeCalls).toEqual([HINT]); // moderated like a theme, before planning
    expect(seen.planHint).toBe(HINT);
    const diffs = getDifferences(job.levelId!)!;
    expect(diffs.map(d => d.description)).toEqual([RUST.description, SCRATCH.description]); // plan order = publish order
    expect(diffs.every(d => d.description !== HINT)).toBe(true); // descriptions from the plan/measurement, not the hint verbatim
    expect(seen.editPrompts.length).toBeGreaterThan(0);
    expect(seen.editPrompts.every(p => p.includes(SENTENCE))).toBe(true); // crop edits carry the request
    expect(getLevelPayload(job.levelId!)!.defectHint).toBe(HINT); // stored on the level
    const res = await qcRevealGET(new Request(`http://localhost/api/qc-reveal?levelId=${job.levelId}`));
    expect(res.status).toBe(200);
    const reveal = await res.json();
    expect(reveal.defectHint).toBe(HINT); // "Requested: …"
    expect(reveal.differences.map((d: { label: string }) => d.label)).toEqual([RUST.description, SCRATCH.description]);
  });

  it('without a hint: no theme moderation, planner gets undefined, nothing is stored', async () => {
    const seen = newSeen();
    const job = createJob('qc', true, 2, 'medium');
    await runGeneration(job, { imageDataUrl: await solidPng(320, 240, [120, 120, 120]) }, 2, cropProviders(seen));
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
    expect(seen.moderateThemeCalls).toEqual([]);
    expect(seen.planHint).toBeUndefined();
    expect(seen.editPrompts.every(p => !p.includes('The inspector asked'))).toBe(true);
    expect(getLevelPayload(job.levelId!)!.defectHint).toBeUndefined();
    const res = await qcRevealGET(new Request(`http://localhost/api/qc-reveal?levelId=${job.levelId}`));
    expect((await res.json()).defectHint).toBeNull();
  });

  it('a hint the theme moderation would reject fails the job before any planning spend', async () => {
    const seen = newSeen();
    const job = createJob('qc', true, 2, 'medium', HINT);
    await runGeneration(job, { imageDataUrl: await solidPng(320, 240, [120, 120, 120]) }, 2, cropProviders(seen, true));
    expect(getJob(job.id)?.status).toBe('failed');
    expect(getJob(job.id)?.error).toContain('rejected by moderation');
    expect(seen.planCalls).toBe(0); // rejected before the planner (paid calls saved)
    expect(seen.editPrompts).toEqual([]);
  });

  it('one-pass QC prompt carries the requested defects', async () => {
    const seen: { editPrompt?: string } = {};
    const providers: Providers = {
      segmentation: { name: 'fake', isMock: true, segment: async () => [] },
      vision: {
        name: 'fake', isMock: true,
        moderate: async () => ({ ok: true, reason: 'ok' }),
        moderateTheme: async () => ({ ok: true, reason: 'ok' }),
        plan: async () => [],
        verify: async () => ({ ok: true, notes: 'ok' }),
        reviewDifferences: async (pairs: { index: number }[]) => pairs.map(p => ({ index: p.index, ok: true, description: 'a rust bloom on the bolt head', type: 'corrosion', notes: 'fake review ok', sameChangeAs: -1 })),
      },
      imageEdit: {
        name: 'fake', isMock: true,
        editMaskedRegion: paintPatternBlue, generateScene: async () => ({ image: '' }),
        editFullImage: async (imageRef: string, prompt: string) => { seen.editPrompt = prompt; return paintRects(imageRef, [{ x: 400, y: 300, width: 40, height: 30, rgb: [230, 30, 30] }]); },
      },
    };
    const job = createJob('qc', true, 1, 'medium', HINT);
    await runGeneration(job, { imageDataUrl: await solidPng(800, 600, [120, 120, 120]) }, 1, providers);
    expect(getJob(job.id)?.status, getJob(job.id)?.error).toBe('done');
    expect(seen.editPrompt).toContain(SENTENCE);
    expect(getLevelPayload(job.levelId!)!.defectHint).toBe(HINT);
  });
});

describe('QC defect hint — planner prompt (fake fetch, no real call)', () => {
  const capturePlanPrompt = async (mode: 'qc' | 'game', defectHint?: string) => {
    vi.stubEnv('META_REAL_CALLS_ENABLED', 'true');
    vi.stubEnv('MODEL_API_KEY', 'test-key');
    let prompt = '';
    const fetchFn = (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { input: { content: { type: string; text?: string }[] }[] };
      prompt = body.input[0].content.find(c => c.type === 'input_text')?.text ?? '';
      return { ok: true, status: 200, json: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ changes: [] }) }] }] }) } as unknown as Response;
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchFn);
    const { providers } = selectProviders({ AI_PROVIDER: 'meta' });
    await providers.vision.plan('data:image/png;base64,AA', [{ id: 'part', bbox: { x: 0, y: 0, width: 100, height: 80 } }], mode, 2, 'medium', defectHint);
    return prompt;
  };

  it('with a hint, the QC plan prompt contains the inspector sentence verbatim', async () => {
    const prompt = await capturePlanPrompt('qc', HINT);
    expect(prompt).toContain(`${SENTENCE} Plan them first, mapped to the closest allowed defect types, on the parts where they physically make sense; only after them add other defect types if more are needed.`);
  });

  it('without a hint the prompt is identical to today (absent === empty), and game mode never gets the sentence', async () => {
    const absent = await capturePlanPrompt('qc', undefined);
    const empty = await capturePlanPrompt('qc', '');
    expect(empty).toBe(absent); // byte-identical: zero behavior change
    expect(absent).not.toContain('The inspector asked');
    expect(await capturePlanPrompt('game', HINT)).not.toContain('The inspector asked'); // QC scope only
  });
});

describe('POST /api/generate defectHint validation', () => {
  const genReq = (body: Record<string, unknown>) => generatePOST(new Request('http://localhost/api/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '10.7.0.1' }, body: JSON.stringify(body),
  }));

  it('over 300 characters → 400; exactly 300 proceeds; non-string is ignored', async () => {
    const tooLong = await genReq({ mode: 'qc', count: 1, defectHint: 'x'.repeat(301) });
    expect(tooLong.status).toBe(400);
    expect((await tooLong.json()).error).toContain('max 300');
    const exact = await genReq({ mode: 'qc', count: 1, defectHint: 'x'.repeat(300) });
    expect(exact.status).toBe(200); // mock/demo path offline — validation passed
    const nonString = await genReq({ mode: 'qc', count: 1, defectHint: 42 });
    expect(nonString.status).toBe(200);
    const gameHint = await genReq({ mode: 'game', count: 1, defectHint: 'x'.repeat(301) });
    expect(gameHint.status).toBe(200); // ignored outside QC — never a 400 there
  });
});
