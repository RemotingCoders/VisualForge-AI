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

/** JPEG copy for PROVIDER calls only (same dimensions, ~10x smaller than a photo PNG — large
 *  base64 PNG bodies risk connection resets). Internal masters stay lossless PNG so the
 *  composite/diff measurement is never polluted by recompression artifacts. */
export async function providerImage(dataUrl: string, quality = 82): Promise<string> {
  const buf = await sharp(dataUrlToBuffer(dataUrl)).jpeg({ quality }).toBuffer();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

/**
 * Deterministic pure-color change: rotate the hue of a crop while preserving lightness and
 * shading — the SHAPE stays pixel-identical, only the color changes (no generative repaint,
 * no deformation, no API cost). Low-saturation pixels (grays, whites) barely move, weighted
 * by saturation, so backgrounds inside the crop are mostly untouched.
 */
export async function recolorCrop(cropDataUrl: string, hueShiftDeg: number): Promise<string> {
  const { data, info } = await sharp(dataUrlToBuffer(cropDataUrl)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.from(data);
  for (let i = 0; i < data.length; i += 3) {
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
    if (d === 0) continue; // pure gray: hue undefined, leave untouched
    const s = d / (1 - Math.abs(2 * l - 1) || 1);
    let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = ((h * 60) + hueShiftDeg + 360) % 360;
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
    const rgb = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    const wgt = Math.min(1, s * 1.8); // blend by saturation: vivid colors shift fully, muted ones gently
    for (let k = 0; k < 3; k++) out[i + k] = Math.round((data[i + k] / 255 * (1 - wgt) + (rgb[k] + m) * wgt) * 255);
  }
  return bufferToDataUrl(await sharp(out, { raw: { width: info.width, height: info.height, channels: 3 } }).png().toBuffer());
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
