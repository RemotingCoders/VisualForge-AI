#!/usr/bin/env node
/**
 * One-pass mode measurement — Damian-approved for exactly ONE Muse Image call.
 * NOT part of the generation pipeline: sends the full normalized image to Muse Image,
 * measures global alignment compensation + pixel-diff component structure, prints metrics.
 * Ledger-enforced: debug-runs/one-pass-ledger.json refuses a second paid call.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';

if (existsSync('.env.local')) for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}
const apiKey = process.env.MODEL_API_KEY || process.env.META_API_KEY;
if (!process.argv.includes('--i-approve-paid-calls')) { console.error('REFUSED: --i-approve-paid-calls required'); process.exit(2); }
if (process.env.META_REAL_CALLS_ENABLED !== 'true') { console.error('REFUSED: META_REAL_CALLS_ENABLED!=true'); process.exit(2); }
if (!apiKey) { console.error('REFUSED: MODEL_API_KEY/META_API_KEY missing in .env.local'); process.exit(2); }

const imagePath = process.argv.find(a => a.startsWith('--image='))?.slice('--image='.length) ?? '';
if (!imagePath || !existsSync(imagePath)) { console.error('REFUSED: --image=<photo> required'); process.exit(2); }

const OUT = 'debug-runs';
const LEDGER = `${OUT}/one-pass-ledger.json`;
mkdirSync(OUT, { recursive: true });
const ledger = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : { calls: [] };
if (ledger.calls.length >= 1) { console.error(`REFUSED: one-pass budget exhausted (${ledger.calls.length}/1 call already used)`); process.exit(2); }

const PROMPT = 'Make exactly 3 minimal, realistic differences for a spot-the-difference game (for example: remove a small part of an object, add a small detail to an object, add a small object in an empty area). Keep everything else pixel-identical: same framing, scale, colors and lighting.';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const returnedPng = `${OUT}/muse-one-pass-${stamp}.png`;
const metricsPath = `${OUT}/one-pass-metrics-${stamp}.json`;

const rawOf = async (buf, w, h) => {
  let s = sharp(buf).removeAlpha();
  if (w && h) s = s.resize(w, h, { fit: 'fill' });
  const { data, info } = await s.raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
};

// --- normalize full image (downscale to <=1024 wide, never upscale), PNG master ---
const srcBuf = readFileSync(imagePath);
const meta = await sharp(srcBuf).metadata();
if (!meta.width || !meta.height) throw new Error('could not read image dimensions');
const scaleDown = Math.min(1, 1024 / meta.width);
const width = Math.round(meta.width * scaleDown), height = Math.round(meta.height * scaleDown);
const normalizedBuf = await sharp(srcBuf).resize(width, height).png().toBuffer();
writeFileSync(`${OUT}/normalized-original-${stamp}.png`, normalizedBuf);
console.log(`normalized: ${meta.width}x${meta.height} -> ${width}x${height}`);

// --- the ONE paid call ---
const t0 = Date.now();
const res = await fetch('https://api.meta.ai/v1/images/edits', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
  body: JSON.stringify({ model: 'muse-image-1.0', prompt: PROMPT, images: [{ image_url: `data:image/png;base64,${normalizedBuf.toString('base64')}` }], n: 1 }),
  signal: AbortSignal.timeout(180_000),
});
const latency = Date.now() - t0;
const text = await res.text();
let parsed = null; try { parsed = JSON.parse(text); } catch { /* handled below */ }
ledger.calls.push({ n: 1, label: 'Muse Image one-pass full-image edit', path: '/images/edits', http: res.status, latency_ms: latency, usage: parsed?.usage ?? null, dollar_cost: 'NOT RETURNED BY API — check Meta dashboard', at: new Date().toISOString(), prompt: PROMPT, image: imagePath, returned_png: returnedPng });
writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));
console.log(`one-pass call 1/1 · HTTP ${res.status} · ${latency}ms · usage=${JSON.stringify(parsed?.usage ?? null)} · $=see dashboard`);
if (!res.ok) throw new Error(`Muse Image failed: ${text.slice(0, 500)}`);
const b64 = parsed?.data?.[0]?.b64_json;
if (!b64) throw new Error('Muse Image: no data[0].b64_json in response');
const editedBuf = await sharp(Buffer.from(b64, 'base64')).png().toBuffer();
writeFileSync(returnedPng, editedBuf); // exactly what Muse returned, as PNG
const editedMeta = await sharp(editedBuf).metadata();
console.log(`returned image saved: ${returnedPng} (${editedMeta.width}x${editedMeta.height})`);

// --- global alignment estimate (same algorithm as imageOps.estimateAlignment) ---
const a = await rawOf(normalizedBuf);
const b = await rawOf(editedBuf, width, height);
const t = Math.max(3, Math.round(Math.min(width, height) * 0.12));
const cx = width / 2, cy = height / 2;
const ring = [];
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (x < t || y < t || x >= width - t || y >= height - t) ring.push(y * width + x);
const step = Math.max(1, Math.floor(Math.sqrt(ring.length / 3000)));
const samples = []; for (let k = 0; k < ring.length; k += step) samples.push(ring[k]);
const errAt = (s, dx, dy) => {
  let sum = 0, n = 0;
  for (const p of samples) {
    const x = p % width, y = (p / width) | 0;
    const qx = Math.round(cx + (x - cx) * s + dx), qy = Math.round(cy + (y - cy) * s + dy);
    if (qx < 0 || qy < 0 || qx >= width || qy >= height) continue;
    const oa = p * 3, ob = (qy * width + qx) * 3;
    sum += (Math.abs(a.data[oa] - b.data[ob]) + Math.abs(a.data[oa + 1] - b.data[ob + 1]) + Math.abs(a.data[oa + 2] - b.data[ob + 2])) / 3; n++;
  }
  return n ? sum / n : Infinity;
};
let best = { shiftX: 0, shiftY: 0, scale: 1, error: Infinity };
const consider = (s, dx, dy) => {
  const e = errAt(s, dx, dy);
  const mag = Math.max(Math.abs(dx), Math.abs(dy)) + Math.abs(s - 1) * 100;
  const bestMag = Math.max(Math.abs(best.shiftX), Math.abs(best.shiftY)) + Math.abs(best.scale - 1) * 100;
  if (e < best.error - 1e-9 || (Math.abs(e - best.error) <= 1e-9 && mag < bestMag)) best = { shiftX: dx, shiftY: dy, scale: s, error: e };
};
for (const s of [0.96, 0.98, 1, 1.02, 1.04]) for (let dy = -24; dy <= 24; dy += 4) for (let dx = -24; dx <= 24; dx += 4) consider(s, dx, dy);
{ const { scale: bs, shiftX: bx, shiftY: by } = best; for (let dy = by - 3; dy <= by + 3; dy++) for (let dx = bx - 3; dx <= bx + 3; dx++) consider(bs, dx, dy); }
console.log(`alignment estimate: shift (${best.shiftX}, ${best.shiftY})px · scale ${best.scale.toFixed(2)} · residual error ${best.error.toFixed(1)}`);

// --- warp edited back onto the original grid (inverse transform, bilinear) ---
const aligned = Buffer.alloc(width * height * 3);
const sample = (qx, qy, ch) => {
  const x0 = Math.floor(qx), y0 = Math.floor(qy), fx = qx - x0, fy = qy - y0;
  const px = (xx, yy) => b.data[(Math.max(0, Math.min(height - 1, yy)) * width + Math.max(0, Math.min(width - 1, xx))) * 3 + ch];
  return px(x0, y0) * (1 - fx) * (1 - fy) + px(x0 + 1, y0) * fx * (1 - fy) + px(x0, y0 + 1) * (1 - fx) * fy + px(x0 + 1, y0 + 1) * fx * fy;
};
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const qx = cx + (x - cx) * best.scale + best.shiftX, qy = cy + (y - cy) * best.scale + best.shiftY;
  const o = (y * width + x) * 3;
  if (qx < 0 || qy < 0 || qx >= width - 1 || qy >= height - 1) { aligned[o] = a.data[o]; aligned[o + 1] = a.data[o + 1]; aligned[o + 2] = a.data[o + 2]; continue; }
  for (let ch = 0; ch < 3; ch++) aligned[o + ch] = Math.round(sample(qx, qy, ch));
}

// --- diff mask (threshold 12, same as diffMask) + connected components ---
const diff = new Array(width * height).fill(false);
let changed = 0;
for (let i = 0; i < width * height; i++) {
  const o = i * 3;
  diff[i] = Math.max(Math.abs(a.data[o] - aligned[o]), Math.abs(a.data[o + 1] - aligned[o + 1]), Math.abs(a.data[o + 2] - aligned[o + 2])) > 12;
  if (diff[i]) changed++;
}
const labels = new Int32Array(width * height).fill(-1);
const compPixels = [];
for (let i = 0; i < width * height; i++) {
  if (!diff[i] || labels[i] >= 0) continue;
  const id = compPixels.length; const pixels = []; const stack = [i]; labels[i] = id;
  while (stack.length) {
    const p = stack.pop(); pixels.push(p);
    const px = p % width, py = (p / width) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = px + dx, ny = py + dy; if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const q = ny * width + nx; if (diff[q] && labels[q] < 0) { labels[q] = id; stack.push(q); }
    }
  }
  compPixels.push(pixels);
}
// merge components closer than 12px: dilate each by 6px (Chebyshev) and regroup
const dilated = new Array(width * height).fill(false);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  if (!diff[y * width + x]) continue;
  for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < width && ny < height) dilated[ny * width + nx] = true; }
}
const groupOf = new Int32Array(width * height).fill(-1);
let groupCount = 0;
for (let i = 0; i < width * height; i++) {
  if (!dilated[i] || groupOf[i] >= 0) continue;
  const gid = groupCount++; const stack = [i]; groupOf[i] = gid;
  while (stack.length) {
    const p = stack.pop(); const px = p % width, py = (p / width) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = px + dx, ny = py + dy; if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const q = ny * width + nx; if (dilated[q] && groupOf[q] < 0) { groupOf[q] = gid; stack.push(q); }
    }
  }
}
const groups = Array.from({ length: groupCount }, () => ({ area: 0, minX: width, minY: height, maxX: -1, maxY: -1 }));
for (let i = 0; i < width * height; i++) {
  if (!diff[i]) continue;
  const g = groups[groupOf[i]]; const x = i % width, y = (i / width) | 0;
  g.area++; g.minX = Math.min(g.minX, x); g.minY = Math.min(g.minY, y); g.maxX = Math.max(g.maxX, x); g.maxY = Math.max(g.maxY, y);
}
groups.sort((g1, g2) => g2.area - g1.area);
const top3 = groups.slice(0, 3).reduce((s, g) => s + g.area, 0);
const outside = changed - top3;
const metrics = {
  image: imagePath, normalized: { width, height },
  alignment: { shiftX: best.shiftX, shiftY: best.shiftY, scale: best.scale, residualError: Number(best.error.toFixed(2)) },
  rawComponents: compPixels.length,
  mergedComponents: groups.length,
  changedPixels: changed,
  changedPercentOfImage: Number((100 * changed / (width * height)).toFixed(3)),
  groups: groups.map(g => ({ areaPx: g.area, areaPercentOfImage: Number((100 * g.area / (width * height)).toFixed(3)), bbox: { x: g.minX, y: g.minY, width: g.maxX - g.minX + 1, height: g.maxY - g.minY + 1 } })),
  outsideTop3: { pixels: outside, percentOfChanged: changed ? Number((100 * outside / changed).toFixed(2)) : 0, percentOfImage: Number((100 * outside / (width * height)).toFixed(3)) },
  returnedPng,
  latencyMs: latency, usage: parsed?.usage ?? null,
};
writeFileSync(metricsPath, JSON.stringify(metrics, null, 2));
console.log(`diff components: ${compPixels.length} raw -> ${groups.length} after merging <12px`);
groups.forEach((g, i) => console.log(`  #${i + 1}: ${g.area}px (${(100 * g.area / (width * height)).toFixed(3)}% of image) bbox=(${g.minX},${g.minY}) ${g.maxX - g.minX + 1}x${g.maxY - g.minY + 1}`));
console.log(`changed pixels: ${changed} (${(100 * changed / (width * height)).toFixed(3)}% of image)`);
console.log(`outside top-3 components: ${outside}px = ${changed ? (100 * outside / changed).toFixed(2) : '0.00'}% of changed pixels (${(100 * outside / (width * height)).toFixed(3)}% of image)`);
console.log(`metrics saved: ${metricsPath}`);
console.log('Ledger: 1/1 one-pass calls used. Dollar cost: see Meta dashboard.');
