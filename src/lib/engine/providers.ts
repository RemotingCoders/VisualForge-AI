import type { Providers, Region, PlannedChange, Mode, BBox, SegmentationProvider, VisionReasoningProvider, ImageEditProvider } from './types';
import { META_BASE_URL, META_MODELS, META_ENDPOINTS, metaApiKey, parseSamOutput, parseSseOutputText, type SamObject } from './meta';
import { logAiCall } from '../server/db';

export class MetaNotConfiguredError extends Error {
  constructor(missing: string[]) { super(`Meta provider not configured (missing: ${missing.join(', ')})`); this.name = 'MetaNotConfiguredError'; }
}
export function assertMetaConfigured(env: Record<string, string | undefined> = process.env): void {
  if (env.META_REAL_CALLS_ENABLED !== 'true') throw new MetaNotConfiguredError(['META_REAL_CALLS_ENABLED=true (paid-call kill switch is off)']);
  if (!metaApiKey(env)) throw new MetaNotConfiguredError(['MODEL_API_KEY in .env.local']);
}

type FetchFn = typeof fetch;
/** Hard ceiling per Meta call (spike latencies were 3-17s; big photos can be slower).
 *  Without this, a stalled connection/stream hangs a generation job forever with no error. */
export const META_CALL_TIMEOUT_MS = 180_000;
export async function metaPost(path: string, body: unknown, env: Record<string, string | undefined> = process.env, fetchFn: FetchFn = fetch): Promise<unknown> {
  assertMetaConfigured(env);
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetchFn(`${META_BASE_URL}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${metaApiKey(env)}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(META_CALL_TIMEOUT_MS) });
  } catch (e) {
    const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
    throw new Error(`Meta ${path} fetch failed: ${(e as Error).message}${cause ? ` (cause: ${cause.code ?? cause.message ?? 'unknown'})` : ''}`);
  }
  void logAiCall(path.includes('images') ? META_MODELS.image : META_MODELS.spark, path, Date.now() - t0);
  if (!res.ok) throw new Error(`Meta API ${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  return res.json();
}

/** Real Muse Image edit — VERIFIED shape: POST /images/edits {model, prompt, images:[{image_url:"data:..."}], n}. No mask param in docs (crop+composite strategy in pipeline). */
export async function museImageEdit(dataUrl: string, prompt: string, n = 1, env: Record<string, string | undefined> = process.env, fetchFn: FetchFn = fetch): Promise<unknown> {
  return metaPost(META_ENDPOINTS.imageEdits, { model: META_MODELS.image, prompt, images: [{ image_url: dataUrl }], n }, env, fetchFn);
}

/** Edit response VERIFIED in spike call 3/6 (2026-10-29): {created, data:[{b64_json}], output_format:"webp", background, usage}.
 *  Output came back 1600x1600 WebP regardless of input crop — caller resizes back before compositing. */
export function extractEditedImage(res: unknown): string {
  const r = res as { data?: { b64_json?: string }[]; output_format?: string };
  const b64 = r?.data?.[0]?.b64_json;
  if (!b64) throw new Error('Muse Image: no data[0].b64_json in edit response');
  return `data:image/${r.output_format ?? 'webp'};base64,${b64}`;
}

/**
 * One SAM 3.1 concept segmentation — VERIFIED (https://dev.meta.ai/docs/sam/segmenting):
 * POST /v1/responses, stream:true, ONE short noun phrase per request (lists return zero matches).
 * Zero matches is valid: the stream completes with empty output_text -> [].
 */
export async function samSegmentConcept(imageUrl: string, concept: string, env: Record<string, string | undefined> = process.env, fetchFn: FetchFn = fetch): Promise<SamObject[]> {
  assertMetaConfigured(env);
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetchFn(`${META_BASE_URL}${META_ENDPOINTS.responses}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${metaApiKey(env)}` },
      body: JSON.stringify({
        model: META_MODELS.sam,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: concept }, { type: 'input_image', image_url: imageUrl }] }],
        stream: true,
        metadata: { include_confidence: 'true', mask_encoding: 'one_bit' },
      }),
      signal: AbortSignal.timeout(META_CALL_TIMEOUT_MS),
    });
  } catch (e) {
    const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
    throw new Error(`Meta SAM fetch failed: ${(e as Error).message}${cause ? ` (cause: ${cause.code ?? cause.message ?? 'unknown'})` : ''}`);
  }
  if (!res.ok) throw new Error(`Meta API SAM → HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  void logAiCall(META_MODELS.sam, 'sam.segment', Date.now() - t0);
  const raw = await res.text();
  let outputText = parseSseOutputText(raw);
  if (!outputText && raw.trim().startsWith('{')) {
    try { outputText = (JSON.parse(raw) as { output_text?: string }).output_text ?? ''; } catch { /* keep empty */ }
  }
  return parseSamOutput(outputText);
}

/** Strict-subset-safe schemas (docs: additionalProperties:false + required lists EVERY property, no recursion). */
export const SPARK_SCHEMAS = {
  moderation: {
    type: 'object',
    properties: { ok: { type: 'boolean' }, reason: { type: 'string' } },
    required: ['ok', 'reason'], additionalProperties: false,
  },
  concepts: {
    type: 'object',
    properties: { concepts: { type: 'array', items: { type: 'string' } } },
    required: ['concepts'], additionalProperties: false,
  },
  plan: {
    type: 'object',
    properties: {
      changes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' }, regionId: { type: 'string' }, type: { type: 'string' },
            description: { type: 'string' }, editPrompt: { type: 'string' },
            severity: { type: 'string', enum: ['low', 'medium', 'high'] },
          },
          required: ['id', 'regionId', 'type', 'description', 'editPrompt', 'severity'], additionalProperties: false,
        },
      },
    },
    required: ['changes'], additionalProperties: false,
  },
  verification: {
    type: 'object',
    properties: { ok: { type: 'boolean' }, notes: { type: 'string' } },
    required: ['ok', 'notes'], additionalProperties: false,
  },
} as const;

/**
 * Muse Spark structured output — VERIFIED (https://dev.meta.ai/docs/structured-output):
 * Responses API uses `text.format` (NOT `response_format`). In the RAW REST response there is
 * NO top-level `output_text` (the SDK adds it): the JSON string lives in
 * output[] -> {type:"message"} -> content[] -> {type:"output_text", text} (spike call 2/6, 2026-10-29).
 */
export async function sparkStructured<T>(opts: {
  prompt: string; images?: string[]; schemaName: string; schema: object;
  env?: Record<string, string | undefined>; fetchFn?: FetchFn;
}): Promise<T> {
  const env = opts.env ?? process.env;
  const content: unknown[] = [{ type: 'input_text', text: opts.prompt }];
  for (const img of opts.images ?? []) if (/^(https?:|data:)/.test(img)) content.push({ type: 'input_image', image_url: img });
  const res = await metaPost(META_ENDPOINTS.responses, {
    model: META_MODELS.spark,
    input: [{ type: 'message', role: 'user', content }],
    text: { format: { type: 'json_schema', name: opts.schemaName, schema: opts.schema, strict: true } },
  }, env, opts.fetchFn ?? fetch) as {
    output_text?: string;
    output?: { type?: string; content?: { type?: string; text?: string }[] }[];
  };
  const text = res?.output_text
    ?? res?.output?.find(o => o.type === 'message')?.content?.find(c => c.type === 'output_text')?.text;
  if (!text) throw new Error('Muse Spark: no output_text in Responses result');
  return JSON.parse(text) as T;
}

class MetaProvider implements SegmentationProvider, VisionReasoningProvider, ImageEditProvider {
  readonly name = 'meta'; readonly isMock = false;
  async segment(imageRef: string, _w: number, _h: number, concepts?: string[]): Promise<Region[]> {
    assertMetaConfigured();
    let labels = (concepts ?? []).map(s => s.trim()).filter(Boolean);
    if (!labels.length) {
      // Docs: "For understanding a scene, use Muse Spark... then pass a concept to SAM."
      const listed = await sparkStructured<{ concepts: string[] }>({
        prompt: 'List up to 8 distinct, clearly visible objects in this image. Each concept must be ONE short noun phrase suitable for segmentation (e.g. "red chair"). No lists inside an item, no negation, no questions.',
        images: [imageRef], schemaName: 'SegmentConcepts', schema: SPARK_SCHEMAS.concepts,
      });
      labels = listed.concepts;
    }
    const regions: Region[] = [];
    for (const label of labels.slice(0, 8)) {
      const objects = await samSegmentConcept(imageRef, label);
      for (const o of objects) regions.push({ id: `sam-${label.replace(/\s+/g, '-').toLowerCase()}-${o.id}`, bbox: o.bbox, label });
    }
    return regions;
  }
  async moderate(imageRef: string): Promise<{ ok: boolean; reason: string }> {
    return sparkStructured({
      prompt: 'Is this image safe and appropriate for a spot-the-difference game for a general audience? Answer ok=false for sexual, violent, graphic, hateful or otherwise unsafe content, with a short reason.',
      images: [imageRef], schemaName: 'Moderation', schema: SPARK_SCHEMAS.moderation,
    });
  }
  async plan(imageRef: string, regions: Region[], mode: Mode, count: number): Promise<PlannedChange[]> {
    const rules = mode === 'qc'
      ? 'Change types allowed (QC defects): scratch, crack, dent, missing component, corrosion, misalignment, wrong color, foreign object. Defects must be localized and realistic, not covering the whole part.'
      : 'Change types allowed (game) — ONLY these three: "change color", "remove object", "replace object". Difficulty: every change must be SUBTLE and hard to spot at a glance. Never use shape deformation, never add large new elements, never partially transform an object. "change color": same object, same shape, clearly different color (can use ANY region). "remove object": the whole object disappears and the background is filled naturally, as if it had never been there — ONLY on regions with wholeObject=true. "replace object": the whole object is swapped for a DIFFERENT but similar object of similar size in the same place — ONLY on regions with wholeObject=true. MIX: about half "change color"; the rest split between remove/replace on wholeObject regions only. Each editPrompt must describe the change applied COMPLETELY and cleanly to the entire object — never a half-changed, split or broken-looking result.';
    const out = await sparkStructured<{ changes: PlannedChange[] }>({
      prompt: `Plan exactly ${count} realistic, localized visual changes to this image. ${rules} Use ONLY these regionIds, at most one change per region, regions must not overlap: ${JSON.stringify(regions.map(r => ({ regionId: r.id, bbox: r.bbox, label: r.label ?? '', wholeObject: r.wholeObject ?? true })))}. Each editPrompt must describe a precise, subtle image edit confined to that region, preserving the region's overall appearance except for the one small change.`,
      images: [imageRef], schemaName: 'ChangePlan', schema: SPARK_SCHEMAS.plan,
    });
    return out.changes.slice(0, count);
  }
  async verify(imageRef: string, modifiedRef: string, change: PlannedChange, measured: BBox): Promise<{ ok: boolean; notes: string }> {
    return sparkStructured({
      prompt: `Compare the first image (original) with the second (modified). Was this change successfully and realistically applied inside the measured region ${JSON.stringify(measured)}? Change: ${change.type} — ${change.description}. Answer ok=true only if the change is visible, realistic, and confined to that region.`,
      images: [imageRef, modifiedRef], schemaName: 'Verification', schema: SPARK_SCHEMAS.verification,
    });
  }
  async editMaskedRegion(imageRef: string, _r: Region, prompt: string): Promise<string> {
    // Crop+margin -> edit crop -> resize back -> feathered composite happens in the worker (worker/composite.py);
    // the verified Muse Image call itself has no mask parameter and returns 1600x1600 WebP (spike 3/6).
    // Preservation clause: Muse repaints what it returns, so the prompt must pin everything else down.
    const guarded = `${prompt}. IMPORTANT: change ONLY what is described and keep every other element exactly the same — identical shapes, positions, colors, lighting, shadows and photographic style. If the described change removes or replaces an object, apply it to the object COMPLETELY and cleanly (fully removed with naturally filled background, or fully replaced) — never a half-changed or split object. If the described change is instead a localized surface defect (scratch, crack, dent, corrosion or similar damage), render that defect realistically and confined to the described area only. Do not redraw, move or deform anything else.`;
    return extractEditedImage(await museImageEdit(imageRef, guarded));
  }
  async generateScene(_theme: string): Promise<string> {
    assertMetaConfigured();
    throw new MetaNotConfiguredError(['Muse Image generation request shape not yet verified in official docs — not guessed']);
  }
}

/** MOCK — tests/offline ONLY. Always labeled; never a silent fallback in demo. */
export class MockProviders implements SegmentationProvider, VisionReasoningProvider, ImageEditProvider {
  readonly name = 'mock'; readonly isMock = true;
  async segment(_i: string, w: number, h: number): Promise<Region[]> {
    const cols = 4, rows = 3, out: Region[] = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++)
      out.push({ id: `r${r}c${c}`, bbox: { x: (c * w) / cols + 8, y: (r * h) / rows + 8, width: w / cols - 16, height: h / rows - 16 }, label: `mock-region-${r}-${c}` });
    return out;
  }
  async moderate() { return { ok: true, reason: 'MOCK moderation — not a real safety check' }; }
  async plan(_i: string, regions: Region[], mode: Mode, count: number): Promise<PlannedChange[]> {
    const types = mode === 'qc'
      ? ['scratch', 'crack', 'dent', 'missing component', 'corrosion']
      : ['remove object', 'change color', 'replace object'];
    return regions.slice(0, count).map((r, i) => ({ id: `change-${i + 1}`, regionId: r.id, type: types[i % types.length], description: `MOCK change ${i + 1}: ${types[i % types.length]}`, editPrompt: `mock edit ${i + 1}` }));
  }
  async verify() { return { ok: true, notes: 'MOCK verification — not real visual verification' }; }
  async editMaskedRegion(imageRef: string) { return imageRef; }
  async generateScene(theme: string) { return `mock-scene:${theme}`; }
}

export function selectProviders(env: Record<string, string | undefined> = process.env): { providers: Providers; label: string } {
  const kind = (env.AI_PROVIDER ?? 'mock').toLowerCase();
  if (kind === 'meta') { const p = new MetaProvider(); return { providers: { segmentation: p, vision: p, imageEdit: p }, label: 'Meta (real)' }; }
  if (kind !== 'mock') throw new Error(`Unknown AI_PROVIDER "${kind}" — expected "mock" or "meta"`);
  const m = new MockProviders();
  return { providers: { segmentation: m, vision: m, imageEdit: m }, label: 'MOCK — tests/offline only, not real Meta output' };
}
