import sharp from 'sharp';
import type { BBox } from '../engine/types';

/** Server-only image operations (sharp). All public functions take/return PNG data URLs,
 *  except measure which works on raw pixels. Sizes are controlled by callers. */

export function dataUrlToBuffer(dataUrl: string): Buffer {
  const m = /^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/.exec(dataUrl);
  if (!m) throw new Error('expected an image data URL');
  return Buffer.from(m[1], 'base64');
}
export const bufferToDataUrl = (buf: Buffer): string => `data:image/png;base64,${buf.toString('base64')}`;

export async function imageInfo(dataUrl: string): Promise<{ width: number; height: number }> {
  const meta = await sharp(dataUrlToBuffer(dataUrl)).metadata();
  if (!meta.width || !meta.height) throw new Error('could not read image dimensions');
  return { width: meta.width, height: meta.height };
}

/** Downscale (never upscale) so width <= maxW — controls Muse token cost and memory. Returns PNG data URL. */
export async function normalizeImage(dataUrl: string, maxW = 1024): Promise<{ dataUrl: string; width: number; height: number }> {
  const buf = dataUrlToBuffer(dataUrl);
  const meta = await sharp(buf).metadata();
  const w = meta.width ?? 0, h = meta.height ?? 0;
  if (!w || !h) throw new Error('could not read image dimensions');
  const scale = Math.min(1, maxW / w);
  const out = scale < 1 ? await sharp(buf).resize(Math.round(w * scale), Math.round(h * scale)).png().toBuffer() : await sharp(buf).png().toBuffer();
  return { dataUrl: bufferToDataUrl(out), width: Math.round(w * scale), height: Math.round(h * scale) };
}

export const clampBox = (b: BBox, w: number, h: number): BBox => {
  const x = Math.max(0, Math.min(w - 1, Math.floor(b.x))), y = Math.max(0, Math.min(h - 1, Math.floor(b.y)));
  return { x, y, width: Math.max(1, Math.min(w - x, Math.ceil(b.width))), height: Math.max(1, Math.min(h - y, Math.ceil(b.height))) };
};
export const expandBox = (b: BBox, frac: number, w: number, h: number): BBox =>
  clampBox({ x: b.x - b.width * frac, y: b.y - b.height * frac, width: b.width * (1 + 2 * frac), height: b.height * (1 + 2 * frac) }, w, h);

/**
 * A — Square CONTEXT box sent to Muse: side = max(2 x largest bbox side, 384px), SHIFTED to
 * stay inside the image instead of being shrunk, so Muse's square 1600x1600 output maps back
 * 1:1 with no distortion. The PASTE box is separate (object + small margin, see jobs.ts).
 * On images smaller than the desired side the square is limited by the smaller image side.
 */
export function squareContextBox(b: BBox, w: number, h: number, minSide = 384): BBox {
  const desired = Math.max(2 * Math.max(b.width, b.height), minSide);
  const side = Math.max(1, Math.min(desired, w, h));
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  const x = Math.max(0, Math.min(w - side, Math.round(cx - side / 2)));
  const y = Math.max(0, Math.min(h - side, Math.round(cy - side / 2)));
  return { x, y, width: side, height: side };
}

export async function cropDataUrl(dataUrl: string, box: BBox): Promise<{ cropDataUrl: string; cropBox: BBox; width: number; height: number }> {
  const buf = dataUrlToBuffer(dataUrl);
  const { width, height } = await imageInfo(dataUrl);
  const cropBox = clampBox(box, width, height);
  const crop = await sharp(buf).extract({ left: cropBox.x, top: cropBox.y, width: cropBox.width, height: cropBox.height }).png().toBuffer();
  return { cropDataUrl: bufferToDataUrl(crop), cropBox, width, height };
}

/** Feathered alpha ramp (1 inside, fading to 0 at the crop edge over `feather` px). */
function featherAlpha(w: number, h: number, feather: number): Buffer {
  const a = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = Math.min(x, y, w - 1 - x, h - 1 - y);
    a[y * w + x] = Math.round(255 * Math.min(1, feather <= 0 ? 1 : d / feather));
  }
  return a;
}

/**
 * Paste an edited crop back over the original with a feathered edge.
 * INVARIANT: pixels outside cropBox are copied from the original untouched (pixel-identical).
 * The edited image is resized to the crop size first (Muse returns 1600x1600 WebP).
 */
export async function compositeCrop(originalDataUrl: string, editedDataUrl: string, cropBox: BBox, feather = 6): Promise<string> {
  const origBuf = dataUrlToBuffer(originalDataUrl);
  const { width, height } = await imageInfo(originalDataUrl);
  const box = clampBox(cropBox, width, height);
  const editedBuf = await sharp(dataUrlToBuffer(editedDataUrl)).resize(box.width, box.height, { fit: 'fill' }).png().toBuffer();
  const withAlpha = await sharp(editedBuf).joinChannel(featherAlpha(box.width, box.height, feather), { raw: { width: box.width, height: box.height, channels: 1 } }).png().toBuffer();
  const out = await sharp(origBuf).composite([{ input: withAlpha, left: box.x, top: box.y }]).png().toBuffer();
  return bufferToDataUrl(out);
}

const rawOf = async (dataUrl: string, w?: number, h?: number) => {
  let s = sharp(dataUrlToBuffer(dataUrl)).removeAlpha();
  if (w && h) s = s.resize(w, h, { fit: 'fill' });
  const { data, info } = await s.raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
};

/** Connected components (8-connectivity) of a boolean mask; returns per-pixel label + sizes. */
function connectedComponents(mask: boolean[], w: number, h: number): { labels: Int32Array; sizes: number[] } {
  const labels = new Int32Array(w * h).fill(-1); const sizes: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || labels[i] >= 0) continue;
    const id = sizes.length; let size = 0; const stack = [i]; labels[i] = id;
    while (stack.length) {
      const p = stack.pop()!; size++;
      const px = p % w, py = (p / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = px + dx, ny = py + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx; if (mask[q] && labels[q] < 0) { labels[q] = id; stack.push(q); }
      }
    }
    sizes.push(size);
  }
  return { labels, sizes };
}

function dilateMask(mask: boolean[], w: number, h: number, radius: number): boolean[] {
  const out = new Array<boolean>(w * h).fill(false);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!mask[y * w + x]) continue;
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < w && ny < h) out[ny * w + nx] = true;
    }
  }
  return out;
}

function blurAlpha(alpha: Buffer, w: number, h: number, radius = 2): Buffer {
  // Two separable box-blur passes: smooths the dilated mask edge (no hard rectangular seams).
  let cur = Float32Array.from(alpha);
  for (let pass = 0; pass < 2; pass++) {
    const tmp = new Float32Array(cur.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, n = 0; for (let dx = -radius; dx <= radius; dx++) { const nx = x + dx; if (nx >= 0 && nx < w) { s += cur[y * w + nx]; n++; } }
      tmp[y * w + x] = s / n;
    }
    const out = new Float32Array(cur.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, n = 0; for (let dy = -radius; dy <= radius; dy++) { const ny = y + dy; if (ny >= 0 && ny < h) { s += tmp[ny * w + x]; n++; } }
      out[y * w + x] = s / n;
    }
    cur = out;
  }
  return Buffer.from(cur.map(v => Math.max(0, Math.min(255, Math.round(v)))));
}

/**
 * B — Mask-based composition (NOT a rectangle): paste alpha = large connected components of
 * |edited - original| inside the PASTE box, dilated 5px and smoothed. (Union with the decoded
 * SAM mask joins here once `@meta-sam/parser` raster decoding lands; the diff-only version
 * already kills repainted neighbours, straight edges and background jitter.) Pixels outside
 * the paste box are copied from the original untouched.
 * `editedDataUrl` is the full CONTEXT image Muse returned; the paste area is extracted from it.
 */
export async function compositeMaskedEdit(originalDataUrl: string, editedDataUrl: string, contextBox: BBox, pasteBox: BBox): Promise<string> {
  const { width, height } = await imageInfo(originalDataUrl);
  const ctx = clampBox(contextBox, width, height); const paste = clampBox(pasteBox, width, height);
  const rel = { left: paste.x - ctx.x, top: paste.y - ctx.y, width: paste.width, height: paste.height };
  if (rel.left < 0 || rel.top < 0 || rel.left + rel.width > ctx.width || rel.top + rel.height > ctx.height)
    throw new Error('paste box must lie inside the context box');
  const editedCtx = await sharp(dataUrlToBuffer(editedDataUrl)).resize(ctx.width, ctx.height, { fit: 'fill' }).png().toBuffer();
  const editedPasteBuf = await sharp(editedCtx).extract(rel).png().toBuffer();
  const origPasteBuf = await sharp(dataUrlToBuffer(originalDataUrl)).extract({ left: paste.x, top: paste.y, width: paste.width, height: paste.height }).png().toBuffer();
  const [a, b] = [await rawOf(bufferToDataUrl(origPasteBuf)), await rawOf(bufferToDataUrl(editedPasteBuf))];
  const w = paste.width, h = paste.height;
  const rawMask = new Array<boolean>(w * h).fill(false);
  for (let i = 0; i < w * h; i++) { const o = i * 3; rawMask[i] = Math.max(Math.abs(a.data[o] - b.data[o]), Math.abs(a.data[o + 1] - b.data[o + 1]), Math.abs(a.data[o + 2] - b.data[o + 2])) > 12; }
  const { labels, sizes } = connectedComponents(rawMask, w, h);
  const minArea = Math.max(8, Math.floor(w * h * 0.01)); // drop jitter specks, keep the real change
  const kept = new Array<boolean>(w * h).fill(false);
  for (let i = 0; i < w * h; i++) kept[i] = labels[i] >= 0 && sizes[labels[i]] >= minArea;
  const alpha = blurAlpha(Buffer.from(dilateMask(kept, w, h, 5).map(v => (v ? 255 : 0))), w, h);
  const withAlpha = await sharp(editedPasteBuf).joinChannel(alpha, { raw: { width: w, height: h, channels: 1 } }).png().toBuffer();
  const out = await sharp(dataUrlToBuffer(originalDataUrl)).composite([{ input: withAlpha, left: paste.x, top: paste.y }]).png().toBuffer();
  return bufferToDataUrl(out);
}

/**
 * C — Alignment ESTIMATION (not a gate): Muse tends to return the scene slightly SHIFTED
 * (and occasionally rescaled) rather than repainted. Estimate the transform over the outer
 * ring of the context crop (paste area excluded): coarse pass ±24px every 4px, fine pass
 * ±3px around the best, scale search 0.96–1.04 in 5 steps. The caller warps the edit back
 * with `alignEditedCrop` and rejects only if the RESIDUAL error after aligning stays high.
 */
export interface AlignmentEstimate { shiftX: number; shiftY: number; scale: number; error: number; aligned: boolean }
export const ALIGNMENT_MAX_RESIDUAL = 25;
const ALIGNMENT_SCALES = [0.96, 0.98, 1, 1.02, 1.04];

export async function estimateAlignment(originalDataUrl: string, editedDataUrl: string, exclude?: BBox): Promise<AlignmentEstimate> {
  const a = await rawOf(originalDataUrl);
  const b = await rawOf(editedDataUrl, a.width, a.height);
  const w = a.width, h = a.height, t = Math.max(3, Math.round(Math.min(w, h) * 0.12));
  const cx = w / 2, cy = h / 2;
  const ring: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!(x < t || y < t || x >= w - t || y >= h - t)) continue;
    // The paste area itself may touch the ring (object near the crop edge) — it is SUPPOSED to change there.
    if (exclude && x >= exclude.x - 6 && y >= exclude.y - 6 && x < exclude.x + exclude.width + 6 && y < exclude.y + exclude.height + 6) continue;
    ring.push(y * w + x);
  }
  const step = Math.max(1, Math.floor(Math.sqrt(ring.length / 3000)));
  const samples: number[] = [];
  for (let k = 0; k < ring.length; k += step) samples.push(ring[k]);
  const errAt = (scale: number, dx: number, dy: number): number => {
    let sum = 0, n = 0;
    for (const p of samples) {
      const x = p % w, y = (p / w) | 0;
      const qx = Math.round(cx + (x - cx) * scale + dx), qy = Math.round(cy + (y - cy) * scale + dy);
      if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
      const oa = p * 3, ob = (qy * w + qx) * 3;
      sum += (Math.abs(a.data[oa] - b.data[ob]) + Math.abs(a.data[oa + 1] - b.data[ob + 1]) + Math.abs(a.data[oa + 2] - b.data[ob + 2])) / 3; n++;
    }
    return n ? sum / n : Infinity;
  };
  // Coarse pass (±24px every 4px, all scales), preferring the smallest transform among ties.
  let best = { shiftX: 0, shiftY: 0, scale: 1, error: Infinity };
  const consider = (scale: number, dx: number, dy: number) => {
    const e = errAt(scale, dx, dy);
    const mag = Math.max(Math.abs(dx), Math.abs(dy)) + Math.abs(scale - 1) * 100;
    const bestMag = Math.max(Math.abs(best.shiftX), Math.abs(best.shiftY)) + Math.abs(best.scale - 1) * 100;
    if (e < best.error - 1e-9 || (Math.abs(e - best.error) <= 1e-9 && mag < bestMag)) best = { shiftX: dx, shiftY: dy, scale, error: e };
  };
  for (const s of ALIGNMENT_SCALES) for (let dy = -24; dy <= 24; dy += 4) for (let dx = -24; dx <= 24; dx += 4) consider(s, dx, dy);
  // Fine pass: ±3px around the coarse best, at its scale.
  const { scale: bs, shiftX: bx, shiftY: by } = best;
  for (let dy = by - 3; dy <= by + 3; dy++) for (let dx = bx - 3; dx <= bx + 3; dx++) consider(bs, dx, dy);
  return { ...best, aligned: best.error <= ALIGNMENT_MAX_RESIDUAL };
}

/**
 * Warp an edited crop BACK onto the original grid (inverse of the estimated transform):
 * output pixel p samples the edited image at c + (p − c)·scale + shift, bilinear, with
 * out-of-frame samples falling back to the original pixel. Uses sharp only for decode/encode.
 */
export async function alignEditedCrop(originalDataUrl: string, editedDataUrl: string, est: AlignmentEstimate): Promise<string> {
  if (est.shiftX === 0 && est.shiftY === 0 && est.scale === 1) return editedDataUrl;
  const a = await rawOf(originalDataUrl);
  const b = await rawOf(editedDataUrl, a.width, a.height);
  const w = a.width, h = a.height, cx = w / 2, cy = h / 2;
  const out = Buffer.alloc(w * h * 3);
  const sample = (qx: number, qy: number, ch: number): number => {
    const x0 = Math.floor(qx), y0 = Math.floor(qy), fx = qx - x0, fy = qy - y0;
    const px = (xx: number, yy: number) => b.data[(Math.max(0, Math.min(h - 1, yy)) * w + Math.max(0, Math.min(w - 1, xx))) * 3 + ch];
    return px(x0, y0) * (1 - fx) * (1 - fy) + px(x0 + 1, y0) * fx * (1 - fy) + px(x0, y0 + 1) * (1 - fx) * fy + px(x0 + 1, y0 + 1) * fx * fy;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const qx = cx + (x - cx) * est.scale + est.shiftX, qy = cy + (y - cy) * est.scale + est.shiftY;
    const o = (y * w + x) * 3;
    if (qx < 0 || qy < 0 || qx >= w - 1 || qy >= h - 1) { out[o] = a.data[o]; out[o + 1] = a.data[o + 1]; out[o + 2] = a.data[o + 2]; continue; }
    for (let ch = 0; ch < 3; ch++) out[o + ch] = Math.round(sample(qx, qy, ch));
  }
  return bufferToDataUrl(await sharp(out, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer());
}

/** JPEG copy for PROVIDER calls only (same dimensions, ~10x smaller than a photo PNG — large
 *  base64 PNG bodies risk connection resets). Internal masters stay lossless PNG so the
 *  composite/diff measurement is never polluted by recompression artifacts. */
export async function providerImage(dataUrl: string, quality = 82): Promise<string> {
  const buf = await sharp(dataUrlToBuffer(dataUrl)).jpeg({ quality }).toBuffer();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

/**
 * D — Deterministic pure-color change in OKLCH: preserve L (lightness/shading), move only the
 * hue, gently raise chroma for vivid pixels. Applied ONLY to the object's own pixels (jobs pass
 * the un-expanded bbox crop, never the expanded context). Achromatic pixels (C ~ 0: grays,
 * whites, creams) have no hue to rotate — they are left untouched here, and jobs route
 * low-chroma objects to Muse instead of rotating.
 */
const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linearToSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
function rgbToOklab(r: number, g: number, b: number): [number, number, number] {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}
function rgbToOklch(r: number, g: number, b: number): [number, number, number] {
  const [L, A, Bb] = rgbToOklab(r, g, b);
  return [L, Math.hypot(A, Bb), Math.atan2(Bb, A) * 180 / Math.PI];
}
function oklchToRgb(L: number, C: number, hueDeg: number): [number, number, number] {
  const rad = hueDeg * Math.PI / 180, A = C * Math.cos(rad), Bb = C * Math.sin(rad);
  const l = L + 0.3963377774 * A + 0.2158037573 * Bb;
  const m = L - 0.1055613458 * A - 0.0638541728 * Bb;
  const s = L - 0.0894841775 * A - 1.2914855480 * Bb;
  const R = 4.0767416621 * l ** 3 - 3.3077115913 * m ** 3 + 0.2309699292 * s ** 3;
  const G = -1.2684380046 * l ** 3 + 2.6097574011 * m ** 3 - 0.3413193965 * s ** 3;
  const B = -0.0041960863 * l ** 3 - 0.7034186147 * m ** 3 + 1.7076147010 * s ** 3;
  const cl = (v: number) => Math.round(Math.max(0, Math.min(1, linearToSrgb(v))) * 255);
  return [cl(R), cl(G), cl(B)];
}
const OKLCH_HUES: Record<string, number> = { red: 29, orange: 58, amber: 75, yellow: 100, lime: 130, green: 145, teal: 175, cyan: 195, sky: 220, blue: 260, indigo: 275, violet: 300, purple: 300, magenta: 330, pink: 350, brown: 55 };
/** Hue (OKLCH degrees) for a named target color; null for achromatic/unknown targets (route to Muse). */
export function targetHueFromColor(name?: string): number | null {
  if (!name) return null;
  const key = name.trim().toLowerCase();
  if (key in OKLCH_HUES) return OKLCH_HUES[key];
  const hit = Object.keys(OKLCH_HUES).find(k => key.includes(k));
  return hit ? OKLCH_HUES[hit] : null;
}
/** Mean OKLCH chroma of a crop: low values (cream/white/gray objects) must NOT be hue-rotated. */
export async function cropColorStats(cropDataUrl: string): Promise<{ meanChroma: number; saturatedFraction: number }> {
  const { data } = await rawOf(cropDataUrl);
  let sum = 0, sat = 0, n = 0;
  for (let i = 0; i < data.length; i += 3) { const [, C] = rgbToOklch(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255); sum += C; if (C > 0.05) sat++; n++; }
  return { meanChroma: n ? sum / n : 0, saturatedFraction: n ? sat / n : 0 };
}
/** ΔE (OKLab euclidean) between two same-size images: mean over pixels that actually changed. */
export async function colorDeltaE(aDataUrl: string, bDataUrl: string, width: number, height: number): Promise<{ meanDeltaE: number; changedPixels: number }> {
  const [a, b] = [await rawOf(aDataUrl, width, height), await rawOf(bDataUrl, width, height)];
  let sum = 0, changed = 0;
  for (let i = 0; i < width * height; i++) {
    const o = i * 3;
    const [L1, a1, b1] = rgbToOklab(a.data[o] / 255, a.data[o + 1] / 255, a.data[o + 2] / 255);
    const [L2, a2, b2] = rgbToOklab(b.data[o] / 255, b.data[o + 1] / 255, b.data[o + 2] / 255);
    const de = Math.hypot(L1 - L2, a1 - a2, b1 - b2);
    if (de > 0.03) { sum += de; changed++; }
  }
  return { meanDeltaE: changed ? sum / changed : 0, changedPixels: changed };
}

export async function recolorCrop(cropDataUrl: string, hueShiftDeg: number, targetHueDeg?: number): Promise<string> {
  const { data, info } = await sharp(dataUrlToBuffer(cropDataUrl)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.from(data);
  for (let i = 0; i < data.length; i += 3) {
    const [L, C, H] = rgbToOklch(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255);
    if (C < 0.004) continue; // achromatic: no hue — untouched (gray/white stay exact)
    const newHue = targetHueDeg ?? (H + hueShiftDeg);
    const newC = C >= 0.02 ? Math.min(0.37, Math.max(C, C * 1.18 + 0.01)) : C; // gentle chroma lift for vivid pixels only
    const wgt = Math.min(1, C / 0.08); // muted pixels blend gently — backgrounds in the crop barely move
    const [r, g, b] = oklchToRgb(L, newC, newHue);
    out[i] = Math.round(data[i] * (1 - wgt) + r * wgt);
    out[i + 1] = Math.round(data[i + 1] * (1 - wgt) + g * wgt);
    out[i + 2] = Math.round(data[i + 2] * (1 - wgt) + b * wgt);
  }
  return bufferToDataUrl(await sharp(out, { raw: { width: info.width, height: info.height, channels: 3 } }).png().toBuffer());
}

/** Circular mean hue (OKLCH degrees, 0-360) of a crop's saturated pixels; null when it has none. */
export async function cropDominantHue(cropDataUrl: string): Promise<number | null> {
  const { data } = await rawOf(cropDataUrl);
  let sx = 0, sy = 0;
  for (let i = 0; i < data.length; i += 3) {
    const [, C, H] = rgbToOklch(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255);
    if (C <= 0.03) continue;
    const rad = H * Math.PI / 180;
    sx += C * Math.cos(rad); sy += C * Math.sin(rad);
  }
  if (Math.hypot(sx, sy) < 1e-9) return null;
  const deg = Math.atan2(sy, sx) * 180 / Math.PI;
  return deg < 0 ? deg + 360 : deg;
}

export type LocalTransformKind = 'flip' | 'resize' | 'rotate' | 'duplicate';

/**
 * Deterministic whole-object transform INSIDE the paste canvas (same masked composition as
 * Muse edits afterwards): flip mirrors the object's bbox, resize scales it ±15-20% (mirrored
 * fill when shrinking, center-crop when growing), rotate turns it 10-15° with transparent
 * corners so the original background shows through.
 */
export async function transformObjectInPaste(pasteDataUrl: string, rel: BBox, kind: Exclude<LocalTransformKind, 'duplicate'>, opts: { resizeFactor?: number; rotateDeg?: number } = {}): Promise<string> {
  const pasteBuf = dataUrlToBuffer(pasteDataUrl);
  const objBuf = await sharp(pasteBuf).extract({ left: rel.x, top: rel.y, width: rel.width, height: rel.height }).png().toBuffer();
  let transformed: Buffer;
  if (kind === 'flip') {
    transformed = await sharp(objBuf).flop().png().toBuffer();
  } else if (kind === 'resize') {
    const f = opts.resizeFactor ?? 1.18;
    const nw = Math.max(2, Math.round(rel.width * f)), nh = Math.max(2, Math.round(rel.height * f));
    if (f >= 1) {
      transformed = await sharp(objBuf).resize(nw, nh).extract({ left: Math.floor((nw - rel.width) / 2), top: Math.floor((nh - rel.height) / 2), width: rel.width, height: rel.height }).png().toBuffer();
    } else {
      const dw = rel.width - nw, dh = rel.height - nh;
      transformed = await sharp(objBuf).resize(nw, nh).extend({ left: Math.floor(dw / 2), right: dw - Math.floor(dw / 2), top: Math.floor(dh / 2), bottom: dh - Math.floor(dh / 2), extendWith: 'mirror' }).png().toBuffer();
    }
  } else {
    transformed = await sharp(objBuf).ensureAlpha().rotate(opts.rotateDeg ?? 12, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).resize(rel.width, rel.height, { fit: 'fill' }).png().toBuffer();
  }
  const out = await sharp(pasteBuf).composite([{ input: transformed, left: rel.x, top: rel.y }]).png().toBuffer();
  return bufferToDataUrl(out);
}

/** Copy the object to the smoothest neighbouring spot inside the paste canvas (lowest local
 *  variance wins). Returns the paste unchanged when no non-overlapping spot fits. */
export async function duplicateObjectInPaste(pasteDataUrl: string, rel: BBox): Promise<string> {
  const pasteBuf = dataUrlToBuffer(pasteDataUrl);
  const { data, width: pw, height: ph } = await rawOf(pasteDataUrl);
  const step = Math.max(3, Math.floor(Math.min(rel.width, rel.height) / 3));
  const smoothness = (x0: number, y0: number): number => {
    let sum = 0, n = 0;
    for (let y = y0; y < y0 + rel.height; y += 3) for (let x = x0; x < x0 + rel.width; x += 3) { const o = (y * pw + x) * 3; sum += (data[o] + data[o + 1] + data[o + 2]) / 3; n++; }
    const mean = n ? sum / n : 0;
    let dev = 0;
    for (let y = y0; y < y0 + rel.height; y += 3) for (let x = x0; x < x0 + rel.width; x += 3) { const o = (y * pw + x) * 3; dev += Math.abs((data[o] + data[o + 1] + data[o + 2]) / 3 - mean); }
    return n ? dev / n : Infinity;
  };
  let best: { x: number; y: number; score: number } | null = null;
  for (let y = 0; y + rel.height <= ph; y += step) for (let x = 0; x + rel.width <= pw; x += step) {
    const overlapsObject = x < rel.x + rel.width + 3 && x + rel.width > rel.x - 3 && y < rel.y + rel.height + 3 && y + rel.height > rel.y - 3;
    if (overlapsObject) continue;
    const score = smoothness(x, y);
    if (!best || score < best.score) best = { x, y, score };
  }
  if (!best) return pasteDataUrl;
  const objBuf = await sharp(pasteBuf).extract({ left: rel.x, top: rel.y, width: rel.width, height: rel.height }).png().toBuffer();
  const out = await sharp(pasteBuf).composite([{ input: objBuf, left: best.x, top: best.y }]).png().toBuffer();
  return bufferToDataUrl(out);
}

/** Boolean per-pixel diff mask (row-major w*h) between two same-size images. */
export async function diffMask(aDataUrl: string, bDataUrl: string, width: number, height: number, threshold = 12): Promise<boolean[]> {
  const raw = async (d: string) => sharp(dataUrlToBuffer(d)).resize(width, height, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const [a, b] = [await raw(aDataUrl), await raw(bDataUrl)];
  const out = new Array<boolean>(width * height).fill(false);
  for (let i = 0; i < width * height; i++) {
    const o = i * 3;
    out[i] = Math.max(Math.abs(a[o] - b[o]), Math.abs(a[o + 1] - b[o + 1]), Math.abs(a[o + 2] - b[o + 2])) > threshold;
  }
  return out;
}
