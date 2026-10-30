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
