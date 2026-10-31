// Verified by Damian from dev.meta.ai/docs (2026-10-28). Do NOT change without re-verifying in official docs.
export const META_BASE_URL = 'https://api.meta.ai/v1';
export const META_MODELS = { image: 'muse-image-1.0', sam: 'sam-3.1', spark: 'muse-spark-1.3' } as const;
// META_BASE_URL already ends in /v1 — endpoints must NOT repeat it (tests caught a /v1/v1 double-prefix).
export const META_ENDPOINTS = { imageEdits: '/images/edits', imageGenerations: '/images/generations', responses: '/responses', chatCompletions: '/chat/completions' } as const;

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
 * Mask decoding via the OFFICIAL @meta-sam/parser (installed 0.1.0; Damian verified the
 * client-libraries page). One shape difference from our SamMask: the codec expects the
 * payload WITH its leading encoding marker ('!' one_bit / '~' lossless) — it validates
 * `payload.startsWith('!')` and decodes `payload.slice(1)`. Our SamMask stores the
 * payload stripped with `encoding` separate, so toParserMask reattaches the marker.
 * Pure ESM package — if Next/Vitest ever refuse the static import, switch these to
 * dynamic imports. Throws InvalidSegmentationMaskError on malformed payloads: callers
 * must catch and fall back to bbox behavior.
 */
import {
  decodeMaskToRaster as parserDecodeRaster,
  decodeMaskToRLE as parserDecodeRLE,
  decodeMaskToSVGPath as parserDecodeSVGPath,
  InvalidSegmentationMaskError,
} from '@meta-sam/parser';
export { InvalidSegmentationMaskError };

const toParserMask = (mask: SamMask) => {
  // SamMask contract: payload is stored WITHOUT the encoding marker (parseSamOutput
  // strips it); the codec wants it back on. Always prepend by encoding — a stripped
  // one_bit payload can itself legitimately start with '!' (base85 digit 0), so a
  // startsWith check would wrongly skip the prepend.
  const marker = mask.encoding === 'lossless' ? '~' : '!';
  return { encoding: mask.encoding, width: mask.width, height: mask.height, payload: marker + mask.payload };
};

/** Decode a SAM mask payload to its native-resolution raster: Uint8Array of
 *  mask.width * mask.height values 0/1, row-major. Covers the object's box. */
export function decodeMaskToRaster(mask: SamMask): Uint8Array {
  return parserDecodeRaster(toParserMask(mask));
}
/** COCO RLE ({ counts, size }) for a SAM mask, via the official parser. */
export function decodeMaskToRLE(mask: SamMask) {
  return parserDecodeRLE(toParserMask(mask));
}
/** SVG path string for a SAM mask, via the official parser ('' when the mask is empty). */
export function decodeMaskToSVGPath(mask: SamMask): string {
  return parserDecodeSVGPath(toParserMask(mask));
}

/**
 * Bring a SAM mask to the image frame: decode, scale the raster to the box's
 * width/height (nearest neighbor), and place it at (box.x, box.y) in a
 * frameW*frameH 0/1 raster. Outside the box everything is 0.
 */
export function maskRasterToFrame(mask: SamMask, box: { x: number; y: number; width: number; height: number }, frameW: number, frameH: number): Uint8Array {
  const raster = decodeMaskToRaster(mask);
  const out = new Uint8Array(frameW * frameH);
  const bw = Math.max(1, Math.round(box.width)), bh = Math.max(1, Math.round(box.height));
  for (let dy = 0; dy < bh; dy++) {
    const fy = Math.round(box.y) + dy;
    if (fy < 0 || fy >= frameH) continue;
    const sy = Math.min(mask.height - 1, Math.floor(dy * mask.height / bh));
    for (let dx = 0; dx < bw; dx++) {
      const fx = Math.round(box.x) + dx;
      if (fx < 0 || fx >= frameW) continue;
      const sx = Math.min(mask.width - 1, Math.floor(dx * mask.width / bw));
      out[fy * frameW + fx] = raster[sy * mask.width + sx];
    }
  }
  return out;
}
