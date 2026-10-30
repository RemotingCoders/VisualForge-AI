// Verified by Damian from dev.meta.ai/docs (2026-10-28). Do NOT change without re-verifying in official docs.
export const META_BASE_URL = 'https://api.meta.ai/v1';
export const META_MODELS = { image: 'muse-image-1.0', sam: 'sam-3.1', spark: 'muse-spark-1.3' } as const;
// META_BASE_URL already ends in /v1 — endpoints must NOT repeat it (tests caught a /v1/v1 double-prefix).
export const META_ENDPOINTS = { imageEdits: '/images/edits', responses: '/responses', chatCompletions: '/chat/completions' } as const;

/** Key lives in .env.local as MODEL_API_KEY (docs naming) or META_API_KEY (alias). Never NEXT_PUBLIC_. */
export function metaApiKey(env: Record<string, string | undefined> = process.env): string | null {
  return env.MODEL_API_KEY || env.META_API_KEY || null;
}

export interface SamMask {
  /** Raster height in rows — comes FIRST in `data=H,W,...` (docs example: data=37,51 = 37 rows x 51 cols). */
  height: number;
  /** Raster width in cols. Raster is smaller than the frame and must be scaled up. */
  width: number;
  /** '~' = lossless (default), '!' = one_bit. Only the FIRST char after H,W, is the marker; payload may contain ~ or !. */
  encoding: 'lossless' | 'one_bit';
  /** base85 payload (NOT base64). */
  payload: string;
  confidence?: number;
}

export interface SamObject {
  /** Stable per-object id within a response. NOT dense, NOT necessarily 0-based (e.g. 0, 2). Never key by line position. */
  id: string;
  frame: number;
  bbox: { x: number; y: number; width: number; height: number };
  confidence?: number;
  mask: SamMask | null;
  /** Raw `H,W,<enc>payload` string (back-compat), or null when no mask token was present. */
  maskToken: string | null;
}

/** Parse `k=v;k=v` token fields BY KEY (docs: tokens read the same with/without `;c=`, so never parse by position). */
function parseFields(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

/**
 * Parse SAM 3.1 output_text — VERIFIED grammar (https://dev.meta.ai/docs/sam/reading-segmentation):
 *   line   ::= FRAME record ( "," record )*
 *   FRAME  ::= "<" INT "f>"                     e.g. <0f>
 *   record ::= OBJECT_ID box mask
 *   box    ::= "<|box;x1=I;y1=I;x2=I;y2=I;w=I;h=I[;c=D]|>"   pixels in the SOURCE image; w/h = source dims
 *   mask   ::= "<|mask;x=0;y=0[;c=D];data=H,W,ENC PAYLOAD|>" ENC '~' lossless | '!' one_bit, payload base85
 * Zero matches is valid: empty output_text -> []. Frames may skip / arrive out of order.
 */
export function parseSamOutput(outputText: string): SamObject[] {
  const out: SamObject[] = [];
  if (!outputText?.trim()) return out;
  // Walk the stream token by token: frame markers set the current frame; records start with an integer id.
  const tokenRe = /<(\d+)f>|(\d+)\s*<\|box;([^|]*)\|>(?:\s*<\|mask;([^|]*)\|>)?/g;
  let frame = 0;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(outputText)) !== null) {
    if (m[1] !== undefined) { frame = Number(m[1]); continue; }
    const box = parseFields(m[3]);
    const x1 = Number(box.x1), y1 = Number(box.y1), x2 = Number(box.x2), y2 = Number(box.y2);
    if (![x1, y1, x2, y2].every(Number.isFinite)) continue;
    let mask: SamMask | null = null;
    let maskToken: string | null = null;
    if (m[4] !== undefined) {
      const f = parseFields(m[4]);
      const data = f.data ?? '';
      const first = data.indexOf(','), second = data.indexOf(',', first + 1);
      if (first > 0 && second > first) {
        const height = Number(data.slice(0, first)), width = Number(data.slice(first + 1, second));
        const rest = data.slice(second + 1);
        const enc = rest.startsWith('!') ? 'one_bit' : 'lossless';
        mask = { height, width, encoding: enc, payload: rest.slice(1), ...(f.c !== undefined ? { confidence: Number(f.c) } : {}) };
        maskToken = data;
      }
    }
    out.push({
      id: m[2], frame,
      bbox: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 },
      ...(box.c !== undefined ? { confidence: Number(box.c) } : {}),
      mask, maskToken,
    });
  }
  return out;
}

/** Accumulate `response.output_text.delta` events from a SAM/Spark SSE body (`data: {...}` lines, `[DONE]` ends it). */
export function parseSseOutputText(sseText: string): string {
  let out = '';
  for (const line of sseText.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const ev = JSON.parse(payload) as { type?: string; delta?: string };
      if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') out += ev.delta;
    } catch { /* non-JSON keep-alive lines are ignored */ }
  }
  return out;
}

/**
 * SAM mask payloads are base85 at LOWER resolution than the image and must be rescaled.
 * The byte->raster algorithm lives ONLY in the official client libraries
 * (@meta-sam/parser >= 0.0.13 / meta-sam-parser >= 0.0.6) per /docs/sam/client-libraries —
 * that page has NOT been verified yet, so this stays a loud stub instead of a guess.
 * The pipeline does not depend on it: real masks/bboxes come from pixel-diff measurement.
 */
export function decodeMaskToRaster(_mask: SamMask, _targetW: number, _targetH: number): Uint8Array {
  throw new Error('decodeMaskToRaster pending verification of https://dev.meta.ai/docs/sam/client-libraries (official @meta-sam/parser) — not guessed. Pipeline measures real masks from pixel diff instead.');
}
