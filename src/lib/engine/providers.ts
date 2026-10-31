import { createHash } from 'node:crypto';
import type { Providers, Region, PlannedChange, Mode, Difficulty, BBox, SegmentationProvider, VisionReasoningProvider, ImageEditProvider, DifferenceReview, DifferenceHints, GeneratedScene, DefectClassification } from './types';
import { QC_DEFECT_CATEGORIES } from './types';
import { META_BASE_URL, META_MODELS, META_ENDPOINTS, metaApiKey, parseSamOutput, parseSseOutputText, type SamObject } from './meta';
import { logAiCall } from '../server/db';

export class MetaNotConfiguredError extends Error {
  constructor(missing: string[]) { super(`Meta provider not configured (missing: ${missing.join(', ')})`); this.name = 'MetaNotConfiguredError'; }
}
/** A theme was rejected — by Spark text moderation or by Muse Image's own safety system
 *  (400 content_policy_violation). Jobs map this to the `theme_rejected` sentinel so the
 *  UI can show a friendly "pick another theme" message instead of a raw API error. */
export class ThemeRejectedError extends Error {
  constructor(reason: string) { super(reason); this.name = 'ThemeRejectedError'; }
}
export function assertMetaConfigured(env: Record<string, string | undefined> = process.env): void {
  if (env.META_REAL_CALLS_ENABLED !== 'true') throw new MetaNotConfiguredError(['META_REAL_CALLS_ENABLED=true (paid-call kill switch is off)']);
  if (!metaApiKey(env)) throw new MetaNotConfiguredError(['MODEL_API_KEY in .env.local']);
}

type FetchFn = typeof fetch;
/** Hard ceiling per Meta call (spike latencies were 3-17s; big photos can be slower).
 *  Without this, a stalled connection/stream hangs a generation job forever with no error. */
export const META_CALL_TIMEOUT_MS = 180_000;
/** Transient transport failures worth ONE retry (2s wait): a dropped socket must not
 *  burn the per-change Muse budget (max 2 calls) on a network hiccup. HTTP errors
 *  are NOT retried — the API answered, the request itself is the problem. */
const NETWORK_ERROR = /terminated|econnreset|econnrefused|etimedout|fetch failed|socket|network|und_err/i;
export async function metaPost(path: string, body: unknown, env: Record<string, string | undefined> = process.env, fetchFn: FetchFn = fetch, estimatedCostUsd = 0): Promise<unknown> {
  assertMetaConfigured(env);
  const retryDelayMs = Math.max(0, Number(env.VF_NETWORK_RETRY_DELAY_MS ?? 2000) || 0);
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetchFn(`${META_BASE_URL}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${metaApiKey(env)}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(META_CALL_TIMEOUT_MS) });
    } catch (e) {
      const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
      const detail = `${(e as Error).message} ${cause?.code ?? ''} ${cause?.message ?? ''}`;
      lastError = new Error(`Meta ${path} fetch failed: ${(e as Error).message}${cause ? ` (cause: ${cause.code ?? cause.message ?? 'unknown'})` : ''}`);
      if (attempt === 1 && NETWORK_ERROR.test(detail)) {
        console.info(`[meta] ${path} network error (${detail.trim().slice(0, 120)}) — retrying once in ${retryDelayMs}ms`);
        await new Promise(r => setTimeout(r, retryDelayMs));
        continue;
      }
      throw lastError;
    }
    void logAiCall(path.includes('images') ? META_MODELS.image : META_MODELS.spark, path, Date.now() - t0, false, estimatedCostUsd);
    if (!res.ok) throw new Error(`Meta API ${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
    return res.json();
  }
  throw lastError ?? new Error(`Meta ${path} fetch failed`);
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

/** Generation response also carries data[].revised_prompt — the prompt Muse Image
 *  actually used (docs, Image generation page). Surfaced in the UI as the scene caption. */
export function extractGeneratedScene(res: unknown): GeneratedScene {
  const r = res as { data?: { b64_json?: string; revised_prompt?: string }[]; output_format?: string };
  const d = r?.data?.[0];
  if (!d?.b64_json) throw new Error('Muse Image: no data[0].b64_json in generation response');
  return { image: `data:image/${r.output_format ?? 'webp'};base64,${d.b64_json}`, ...(d.revised_prompt ? { revisedPrompt: d.revised_prompt } : {}) };
}

/** Docs recommend a stable opaque per-user id (never PII). Ours derives from the API key
 *  itself: stable across calls, reveals nothing, rotates with the key. */
export function anonymousUserId(env: Record<string, string | undefined> = process.env): string {
  return `vf-${createHash('sha256').update(metaApiKey(env) ?? '').digest('hex').slice(0, 24)}`;
}

/**
 * Real Muse Image GENERATION (theme -> scene) — shape VERIFIED in official docs
 * (dev.meta.ai/docs/muse-image, Image generation page, read 2026-10-30):
 * POST /images/generations {model, prompt, n, size, reasoning_strength, tool_enablement,
 * user}. `size` is ASPECT ONLY (longest edge <= 1024) so "1024x768" yields a 4:3 scene.
 * NO `moderation` field: muse-image-1.0 rejects it with 400 (enum is Spark-only) — safety
 * is Spark pre-moderation (moderateTheme) + a 400 content_policy_violation mapped to
 * ThemeRejectedError. Flat $0.01/image. The scene brief demands >= 8 clearly separated
 * objects and forbids people/text so SAM + the planner get segmentable material.
 */
export async function museImageGenerateScene(theme: string, env: Record<string, string | undefined> = process.env, fetchFn: FetchFn = fetch, kind: 'scene' | 'part' = 'scene'): Promise<GeneratedScene> {
  const prompt = kind === 'part'
    ? `A photorealistic product photo of a single manufactured part for quality-control inspection: ${theme}. One part only, complete and centered, fully visible on a clean plain workbench or conveyor background, even studio lighting, sharp focus, realistic materials and surface detail, no people, no hands, no text, no watermark.`
    : `A rich, detailed scene for a spot-the-difference game: ${theme}. Show at least 8 clearly separated, distinct objects, no people, no text, no watermark, static scene seen from a fixed camera.`;
  let res: unknown;
  try {
    res = await metaPost(META_ENDPOINTS.imageGenerations, {
      model: META_MODELS.image, prompt, n: 1, size: '1024x768',
      reasoning_strength: env.VF_SCENE_REASONING || 'high',
      tool_enablement: { web_search: false, use_entertainment_tool: false, use_sports_tool: false },
      user: anonymousUserId(env),
    }, env, fetchFn, 0.01);
  } catch (e) {
    if ((e as Error).message.includes('content_policy_violation'))
      throw new ThemeRejectedError('Muse Image safety system rejected this theme (content_policy_violation)');
    throw e;
  }
  return extractGeneratedScene(res);
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
            description: { type: 'string' }, editPrompt: { type: 'string' }, targetColor: { type: 'string' },
            severity: { type: 'string', enum: ['low', 'medium', 'high'] },
          },
          required: ['id', 'regionId', 'type', 'description', 'editPrompt', 'targetColor', 'severity'], additionalProperties: false,
        },
      },
    },
    required: ['changes'], additionalProperties: false,
  },
  /** QC plan: same fields plus targetBox (pixels, inside the region) + partConcept —
   *  several defects may share one part, each confined to its own targetBox. */
  planQc: {
    type: 'object',
    properties: {
      changes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' }, regionId: { type: 'string' }, type: { type: 'string' },
            description: { type: 'string' }, editPrompt: { type: 'string' }, targetColor: { type: 'string' },
            severity: { type: 'string', enum: ['low', 'medium', 'high'] },
            targetBox: {
              type: 'object',
              properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } },
              required: ['x', 'y', 'width', 'height'], additionalProperties: false,
            },
            partConcept: { type: 'string' },
          },
          required: ['id', 'regionId', 'type', 'description', 'editPrompt', 'targetColor', 'severity', 'targetBox', 'partConcept'], additionalProperties: false,
        },
      },
    },
    required: ['changes'], additionalProperties: false,
  },
  /** QC defect classification: Spark re-judges each measured defect from its crops. */
  defectClassification: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer' },
            defectType: { type: 'string', enum: QC_DEFECT_CATEGORIES },
            severity: { type: 'integer' }, confidence: { type: 'number' }, label: { type: 'string' },
          },
          required: ['index', 'defectType', 'severity', 'confidence', 'label'], additionalProperties: false,
        },
      },
    },
    required: ['items'], additionalProperties: false,
  },
  verification: {
    type: 'object',
    properties: { ok: { type: 'boolean' }, notes: { type: 'string' } },
    required: ['ok', 'notes'], additionalProperties: false,
  },
  differenceReview: {
    type: 'object',
    properties: {
      reviews: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer' }, ok: { type: 'boolean' },
            description: { type: 'string' }, type: { type: 'string' }, notes: { type: 'string' },
          },
          required: ['index', 'ok', 'description', 'type', 'notes'], additionalProperties: false,
        },
      },
    },
    required: ['reviews'], additionalProperties: false,
  },
  /** Capability 2: per-difference difficulty (1-5) + exactly 3 progressive hints. */
  differenceHints: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer' }, difficulty: { type: 'integer' },
            hints: { type: 'array', items: { type: 'string' } },
          },
          required: ['index', 'difficulty', 'hints'], additionalProperties: false,
        },
      },
    },
    required: ['items'], additionalProperties: false,
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
  async segment(imageRef: string, _w: number, _h: number, concepts?: string[], mode?: Mode): Promise<Region[]> {
    assertMetaConfigured();
    let labels = (concepts ?? []).map(s => s.trim()).filter(Boolean);
    if (!labels.length) {
      // Docs: "For understanding a scene, use Muse Spark... then pass a concept to SAM."
      // QC asks for PARTS/FEATURES of the piece, never the piece itself — segmenting the
      // whole part as one region is what starved the QC planner (1 region, 1 defect).
      const listed = await sparkStructured<{ concepts: string[] }>({
        prompt: mode === 'qc'
          ? 'List up to 8 distinct PARTS or FEATURES of the main manufactured part in this image — NOT the whole part itself. Each concept must be ONE short noun phrase suitable for segmentation, naming a part or feature such as "mounting hole", "central bore", "flange edge", "cylindrical boss", "chamfer", "outer rim", "threaded hole", "flat face". No lists inside an item, no negation, no questions.'
          : 'List up to 8 distinct, clearly visible objects in this image. Each concept must be ONE short noun phrase suitable for segmentation (e.g. "red chair"). No lists inside an item, no negation, no questions.',
        images: [imageRef], schemaName: 'SegmentConcepts', schema: SPARK_SCHEMAS.concepts,
      });
      labels = listed.concepts;
    }
    // One SAM request per concept, ALL IN PARALLEL (they are independent; serial calls
    // cost ~19s of wall time for a full concept list). Order stays deterministic.
    const perConcept = await Promise.all(labels.slice(0, 8).map(async label => {
      const objects = await samSegmentConcept(imageRef, label);
      return objects.map(o => ({ id: `sam-${label.replace(/\s+/g, '-').toLowerCase()}-${o.id}`, bbox: o.bbox, label, ...(o.mask ? { samMask: o.mask } : {}) }));
    }));
    return perConcept.flat();
  }
  async moderate(imageRef: string): Promise<{ ok: boolean; reason: string }> {
    return sparkStructured({
      prompt: 'Is this image safe and appropriate for a spot-the-difference game for a general audience? Answer ok=false for sexual, violent, graphic, hateful or otherwise unsafe content, with a short reason.',
      images: [imageRef], schemaName: 'Moderation', schema: SPARK_SCHEMAS.moderation,
    });
  }
  /** Text-only theme gate (VF_THEME_GENERATION): judges the theme BEFORE any paid image
   *  generation. Same moderation schema, no images — the Responses content then carries a
   *  single input_text part (sparkStructured already omits input_image when images is []). */
  async moderateTheme(text: string): Promise<{ ok: boolean; reason: string }> {
    return sparkStructured({
      prompt: `A user wants to generate a spot-the-difference game scene from this theme: "${text}". Is this theme safe and appropriate for a general audience? Answer ok=false if it requests or implies sexual, violent, graphic, hateful, illegal or otherwise unsafe imagery, with a short reason. Innocent scenes (places, objects, animals, seasons, fantasy worlds without adult content) are ok=true.`,
      schemaName: 'Moderation', schema: SPARK_SCHEMAS.moderation,
    });
  }
  async plan(imageRef: string, regions: Region[], mode: Mode, count: number, difficulty: Difficulty = 'medium'): Promise<PlannedChange[]> {
    const difficultyRule = difficulty === 'easy'
      ? 'Difficulty EASY: prefer the LARGEST suitable objects and the strongest, most clearly visible version of each change.'
      : difficulty === 'hard'
        ? 'Difficulty HARD: prefer the SMALLEST suitable objects and the subtlest version of each change that is still real and measurable.'
        : 'Difficulty MEDIUM: balance object size and change visibility — noticeable when compared side by side, not obvious at a glance.';
    const rules = mode === 'qc'
      ? `Change types allowed (QC defects): scratch, crack, dent, missing component, corrosion, misalignment, wrong color, foreign object. Defects must be localized and realistic, not covering the whole part. ${difficultyRule}`
      : `Change types allowed (game) — ONLY these: "change color", "remove object", "replace object", "add object", "flip", "resize", "rotate", "duplicate". ${difficultyRule} Never use shape deformation or partially transform an object. "change color": same object, same shape, clearly different color (can use ANY region). "remove object": the whole object disappears and the background is filled naturally — ONLY on regions with wholeObject=true. "replace object": the whole object is swapped for a DIFFERENT but similar object of similar size in the same place — ONLY on wholeObject=true. "add object": add ONE small, plausible object similar to the scene inside the region (allowed on any region, in visibly empty space). "flip", "resize", "rotate" and "duplicate" (deterministic local transforms of the whole object) — ONLY on wholeObject=true. VARIETY QUOTA across this ordered candidate list: at most 40% may be "change color"; include at least one "remove object" and at least one "replace object" or "add object" (when a suitable wholeObject region exists). Order candidates by priority: best, most reliable changes first. Each editPrompt must describe the change applied COMPLETELY and cleanly to the entire object — never a half-changed, split or broken-looking result.`;
    const common = ' EVERY editPrompt must be exactly ONE sentence and must explicitly name the object/part using its region label (e.g. "Change the red mug to blue."). Each description must be a short PAST-TENSE statement of the finished change as the player sees it in the modified image (e.g. "The white wolf turned gray", "A red mushroom appeared on the log", "The orange butterfly disappeared") — NEVER an instruction or imperative ("Change the...", "Remove the...", "Add a..."). The player sees ONLY the description, never the editPrompt. For "change color" or "wrong color", set targetColor to one simple color name clearly different from the object\'s current color and make the description/editPrompt use that same color; for all other types set targetColor to "".';
    const placement = mode === 'qc'
      ? ' Several candidates MAY share the same region (the same part): each candidate MUST carry its own targetBox — the exact pixel box inside the region where the defect goes (small and localized; all coordinates, region bboxes included, are image pixels) — and partConcept, the short name of the part or feature the defect sits on (e.g. "flange edge", "central bore", "mounting hole"). The targetBoxes of candidates that share a region must NOT overlap each other. Each editPrompt must name the partConcept and confine the defect to its targetBox.'
      : ' At most one change per region.';
    const out = await sparkStructured<{ changes: PlannedChange[] }>({
      prompt: `Plan exactly ${count} realistic, localized visual-change candidates in priority order. ${rules}${common} Use ONLY these regionIds:${placement} Regions: ${JSON.stringify(regions.map(r => ({ regionId: r.id, bbox: r.bbox, label: r.label ?? '', wholeObject: r.wholeObject ?? true })))}. Each editPrompt must describe a precise image edit confined to that region, with a magnitude consistent with the selected difficulty and preserving everything else in the region.`,
      images: [imageRef], schemaName: 'ChangePlan', schema: mode === 'qc' ? SPARK_SCHEMAS.planQc : SPARK_SCHEMAS.plan,
    });
    const saneBox = (b: PlannedChange['targetBox']): BBox | undefined =>
      b && [b.x, b.y, b.width, b.height].every(v => Number.isFinite(v)) && b.width > 0 && b.height > 0
        ? { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }
        : undefined;
    return out.changes.slice(0, count).map(ch => ({ ...ch, targetBox: saneBox(ch.targetBox), partConcept: typeof ch.partConcept === 'string' && ch.partConcept ? ch.partConcept : undefined }));
  }
  async verify(imageRef: string, modifiedRef: string, change: PlannedChange, measured: BBox): Promise<{ ok: boolean; notes: string }> {
    return sparkStructured({
      prompt: `Compare the first image (original) with the second (modified). Was this change successfully and realistically applied inside the measured region ${JSON.stringify(measured)}? Change: ${change.type} — ${change.description}. Answer ok=true only if the change is visible, realistic, and confined to that region.`,
      images: [imageRef, modifiedRef], schemaName: 'Verification', schema: SPARK_SCHEMAS.verification,
    });
  }
  async reviewDifferences(pairs: { index: number; before: string; after: string; bbox: BBox }[]): Promise<DifferenceReview[]> {
    const images: string[] = [];
    for (const p of pairs) images.push(p.before, p.after);
    const out = await sparkStructured<{ reviews: DifferenceReview[] }>({
      prompt: `You are given ${pairs.length} pairs of image crops for a spot-the-difference game, in this order: pair 0 BEFORE, pair 0 AFTER, pair 1 BEFORE, pair 1 AFTER, and so on. The measured change regions are: ${JSON.stringify(pairs.map(p => ({ index: p.index, bbox: p.bbox })))}. For EACH pair decide: ok=true only if a real, describable visual difference exists between BEFORE and AFTER inside that region (an object added, removed, recolored, swapped or altered) and it looks realistic — ok=false if the two crops are effectively the same scene re-rendered (texture/lighting noise only, no describable change). For ok pairs give a short player-facing description of the difference in PAST TENSE, describing the finished result as seen in the AFTER image (e.g. "A ladybug appeared on the stem", "The white wolf turned gray") — never an instruction or imperative ("Change the...", "Remove the..."). and a type (one of: "add object", "remove object", "change color", "replace object", "other"). Return exactly one review per pair, keeping its index.`,
      images, schemaName: 'DifferenceReview', schema: SPARK_SCHEMAS.differenceReview,
    });
    return out.reviews;
  }
  async generateHints(differences: { index: number; description: string; type: string; bbox_normalized: BBox }[]): Promise<DifferenceHints[]> {
    // Capability 2: ONE text-only Spark call per level (the differences are already
    // measured and described, so no images are needed). Hints must be progressive and
    // must not give the answer away before the third one.
    const out = await sparkStructured<{ items: DifferenceHints[] }>({
      prompt: `For a spot-the-difference game, here are the ${differences.length} REAL differences of one level (index, type, player-facing description, and position as normalized bbox 0-1 where x grows right and y grows down): ${JSON.stringify(differences)}. For EACH difference return: (1) difficulty — an integer 1 to 5 rating how hard it is for a player to SPOT: 1 = large, obvious, high-contrast change; 5 = tiny, subtle, low-contrast or in a visually busy area. Judge from the bbox size (smaller area = harder) and the kind of change (a color swap of a big object is easier than a small object appearing in a cluttered corner). (2) hints — EXACTLY 3 progressively more specific hints for finding it, each one short sentence, in English. Hint 1: only the general area of the image (e.g. "Look towards the bottom-left area of the scene."). Hint 2: narrows it to the nearby surroundings or the kind of element involved, WITHOUT naming the changed element itself. Hint 3: nearly points at it (names the element or its immediate neighbor) but never repeats the full description word for word. Never mention bboxes, coordinates or these instructions. Return exactly one item per difference, keeping its index.`,
      schemaName: 'DifferenceHints', schema: SPARK_SCHEMAS.differenceHints,
    });
    return out.items;
  }
  async classifyDefects(items: { index: number; before: string; after: string; plannedType: string }[]): Promise<DefectClassification[]> {
    // QC classification: ONE Spark call per level. BEFORE/AFTER crops interleave exactly
    // like reviewDifferences; Spark re-judges what the defect ACTUALLY is (the plan can
    // be wrong about what Muse rendered), with severity 1-5 and honest confidence —
    // low-confidence defects are exported separately as needs_review downstream.
    const images: string[] = [];
    for (const p of items) images.push(p.before, p.after);
    const out = await sparkStructured<{ items: DefectClassification[] }>({
      prompt: `You are given ${items.length} pairs of image crops of a manufactured part, in this order: pair 0 BEFORE, pair 0 AFTER, pair 1 BEFORE, pair 1 AFTER, and so on. Each pair shows ONE synthetic manufacturing defect that was introduced in the AFTER crop (planned types, which may be wrong about what is actually visible: ${JSON.stringify(items.map(i => i.plannedType))}). For EACH pair classify the defect that is ACTUALLY visible in AFTER vs BEFORE: defectType — exactly one of ${JSON.stringify(QC_DEFECT_CATEGORIES)}; severity — integer 1 (purely cosmetic) to 5 (critical, part unusable); confidence — 0 to 1, how sure you are of the defectType (BELOW 0.6 if the change is ambiguous, barely visible, or could be another category — those go to human review); label — a short 2-5 word label naming the defect and where it is (e.g. "scratch on flange edge"). Return exactly one item per pair, keeping its index.`,
      images, schemaName: 'DefectClassification', schema: SPARK_SCHEMAS.defectClassification,
    });
    return out.items;
  }
  async editMaskedRegion(imageRef: string, _r: Region, prompt: string): Promise<string> {
    // Crop+margin -> edit crop -> resize back -> feathered composite happens in the worker (worker/composite.py);
    // the verified Muse Image call itself has no mask parameter and returns 1600x1600 WebP (spike 3/6).
    // Preservation clause: Muse repaints what it returns, so the prompt must pin everything else down.
    const guarded = `${prompt}. IMPORTANT: change ONLY what is described and keep every other element exactly the same — identical shapes, positions, colors, lighting, shadows and photographic style. If the described change removes or replaces an object, apply it to the object COMPLETELY and cleanly (fully removed with naturally filled background, or fully replaced) — never a half-changed or split object. If the described change is instead a localized surface defect (scratch, crack, dent, corrosion or similar damage), render that defect realistically and confined to the described area only. Do not redraw, move or deform anything else.`;
    return extractEditedImage(await museImageEdit(imageRef, guarded));
  }
  async editFullImage(imageRef: string, prompt: string): Promise<string> {
    // One-pass mode: the caller's prompt is sent RAW (it carries its own preservation
    // clause); adding the crop-mode guard suffix would contradict its instructions.
    return extractEditedImage(await museImageEdit(imageRef, prompt));
  }
  async generateScene(theme: string, kind: 'scene' | 'part' = 'scene'): Promise<GeneratedScene> {
    // VF_THEME_GENERATION: request shape verified in official docs (see museImageGenerateScene).
    return museImageGenerateScene(theme, process.env, fetch, kind);
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
  async moderateTheme() { return { ok: true, reason: 'MOCK theme moderation — not a real safety check' }; }
  async plan(_i: string, regions: Region[], mode: Mode, count: number): Promise<PlannedChange[]> {
    const types = mode === 'qc'
      ? ['scratch', 'crack', 'dent', 'missing component', 'corrosion']
      : ['remove object', 'change color', 'flip', 'replace object', 'duplicate'];
    return regions.slice(0, count).map((r, i) => ({
      id: `change-${i + 1}`, regionId: r.id, type: types[i % types.length], description: `MOCK change ${i + 1}: ${types[i % types.length]}`, editPrompt: `mock edit ${i + 1}`, targetColor: /colou?r/i.test(types[i % types.length]) ? 'blue' : '',
      // Deterministic sub-box of the region so the QC targetBox path is exercised offline too.
      targetBox: { x: Math.round(r.bbox.x + r.bbox.width * 0.2), y: Math.round(r.bbox.y + r.bbox.height * 0.2), width: Math.max(4, Math.round(r.bbox.width * 0.3)), height: Math.max(4, Math.round(r.bbox.height * 0.3)) },
      partConcept: r.label ?? 'mock part',
    }));
  }
  async verify() { return { ok: true, notes: 'MOCK verification — not real visual verification' }; }
  async reviewDifferences(pairs: { index: number }[]): Promise<DifferenceReview[]> {
    return pairs.map(p => ({ index: p.index, ok: true, description: `MOCK difference ${p.index + 1} — not a real visual description`, type: 'other', notes: 'MOCK review — not real visual verification' }));
  }
  async generateHints(differences: { index: number; bbox_normalized: BBox }[]): Promise<DifferenceHints[]> {
    // Deterministic MOCK hints derived from the measured position only (never a real
    // visual judgement): difficulty from bbox area, hints from the image quadrant.
    const areaName = (b: BBox) => `${b.y + b.height / 2 < 0.34 ? 'top' : b.y + b.height / 2 > 0.67 ? 'bottom' : 'middle'}-${b.x + b.width / 2 < 0.34 ? 'left' : b.x + b.width / 2 > 0.67 ? 'right' : 'center'}`;
    return differences.map(d => {
      const area = d.bbox_normalized.width * d.bbox_normalized.height;
      const difficulty = area > 0.04 ? 2 : area > 0.01 ? 3 : 4;
      const where = areaName(d.bbox_normalized).replace('-', ' ');
      return { index: d.index, difficulty, hints: [`MOCK hint: look at the ${where} of the image.`, `MOCK hint: compare the ${where} carefully, element by element.`, `MOCK hint: the change is in the ${where} — check every object there.`] };
    });
  }
  async classifyDefects(items: { index: number; plannedType: string }[]): Promise<DefectClassification[]> {
    // Deterministic MOCK classification: echoes the planned type at high confidence.
    return items.map(it => {
      const defectType = QC_DEFECT_CATEGORIES.includes(it.plannedType) ? it.plannedType : 'scratch';
      return { index: it.index, defectType, severity: 3, confidence: 0.92, label: `MOCK classification: ${defectType}` };
    });
  }
  async editMaskedRegion(imageRef: string) { return imageRef; }
  async editFullImage(imageRef: string) { return imageRef; } // unchanged image -> one-pass finds 0 edits -> crop fallback
  async generateScene(theme: string, kind: 'scene' | 'part' = 'scene'): Promise<GeneratedScene> { return { image: `mock-scene:${theme}`, revisedPrompt: `MOCK ${kind} prompt for: ${theme}` }; }
}

export function selectProviders(env: Record<string, string | undefined> = process.env): { providers: Providers; label: string } {
  const kind = (env.AI_PROVIDER ?? 'mock').toLowerCase();
  if (kind === 'meta') { const p = new MetaProvider(); return { providers: { segmentation: p, vision: p, imageEdit: p }, label: 'Meta (real)' }; }
  if (kind !== 'mock') throw new Error(`Unknown AI_PROVIDER "${kind}" — expected "mock" or "meta"`);
  const m = new MockProviders();
  return { providers: { segmentation: m, vision: m, imageEdit: m }, label: 'MOCK — tests/offline only, not real Meta output' };
}
