#!/usr/bin/env node
/**
 * Phase-0 spike — Damian-approved 2026-10-28. HARD LIMIT: 6 paid calls total (ledger-enforced).
 * Run ONLY after Vitest+pytest+Playwright pass and phases are committed.
 * Requires: --i-approve-paid-calls, META_REAL_CALLS_ENABLED=true, MODEL_API_KEY (.env.local, set by Damian — never via chat).
 * One step per run (--step=N) so cost is reported after EACH call, per Damian's condition.
 * API shapes verified 2026-10-28 from /docs/sam/segmenting, /docs/sam/reading-segmentation, /docs/structured-output.
 *
 *  1 SAM 3.1 segment (--concept="red chair")   4 Muse Image FULL-image edit (does it respect the rest?)
 *  2 Muse Spark structured plan (uses step 1)  5 Muse Spark verify (--modified=<edited.png>)
 *  3 Muse Image edit CROP of SAM region        6 reserve/retry only
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// Load .env.local without printing anything (values never logged).
if (existsSync('.env.local')) for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}
const LEDGER = 'spike-ledger.json'; const MAX_CALLS = 6; const OUT = 'spike-output';
if (!process.argv.includes('--i-approve-paid-calls')) { console.error('REFUSED: --i-approve-paid-calls required'); process.exit(2); }
if (process.env.META_REAL_CALLS_ENABLED !== 'true') { console.error('REFUSED: META_REAL_CALLS_ENABLED!=true'); process.exit(2); }
if (!process.env.MODEL_API_KEY) { console.error('REFUSED: MODEL_API_KEY missing (Damian sets it in .env.local — never via chat)'); process.exit(2); }
const arg = (k, d) => process.argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const step = Number(arg('step', '0'));
const imagePath = arg('image', '');
if (![1, 2, 3, 4, 5].includes(step)) { console.error('REFUSED: --step=1..5 required (one paid call per run)'); process.exit(2); }
if (!imagePath || !existsSync(imagePath)) { console.error('REFUSED: --image=<test.png> required (a Damian photo or hackathon-generated image, never downloaded)'); process.exit(2); }
const ledger = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : { calls: [] };
if (ledger.calls.length >= MAX_CALLS) { console.error(`REFUSED: spike budget exhausted (${ledger.calls.length}/${MAX_CALLS} calls)`); process.exit(2); }
mkdirSync(OUT, { recursive: true });

const BASE = 'https://api.meta.ai/v1';
async function call(label, path, body, accept) {
  if (ledger.calls.length >= MAX_CALLS) throw new Error('spike budget exhausted');
  const t0 = Date.now();
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(accept ? { Accept: accept } : {}), Authorization: `Bearer ${process.env.MODEL_API_KEY}` }, body: JSON.stringify(body) });
  const text = await res.text(); const latency = Date.now() - t0;
  let usage = null; try { usage = JSON.parse(text)?.usage ?? null; } catch {}
  ledger.calls.push({ n: ledger.calls.length + 1, step, label, path, http: res.status, latency_ms: latency, usage, dollar_cost: 'NOT RETURNED BY API — check Meta dashboard', at: new Date().toISOString() });
  writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));
  console.log(`call ${ledger.calls.at(-1).n}/${MAX_CALLS} · ${label} · HTTP ${res.status} · ${latency}ms · usage=${JSON.stringify(usage)} · $=see dashboard`);
  if (!res.ok) throw new Error(`${label} failed: ${text.slice(0, 500)}`);
  return text;
}
const save = (name, data) => { writeFileSync(`${OUT}/${name}`, typeof data === 'string' ? data : JSON.stringify(data, null, 2)); console.log(`saved ${OUT}/${name}`); };
const dataUrl = p => `data:image/${/\.jpe?g$/i.test(p) ? 'jpeg' : /\.webp$/i.test(p) ? 'webp' : 'png'};base64,${readFileSync(p).toString('base64')}`;
const samFile = () => { if (!existsSync(`${OUT}/sam.json`)) { console.error('REFUSED: run --step=1 first'); process.exit(2); } return JSON.parse(readFileSync(`${OUT}/sam.json`, 'utf8')); };

if (step === 1) {
  const concept = arg('concept', '');
  if (!concept) { console.error('REFUSED: --concept="red chair" required (ONE short noun phrase — lists return zero matches)'); process.exit(2); }
  const raw = await call('SAM 3.1 segment', '/responses', { model: 'sam-3.1', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: concept }, { type: 'input_image', image_url: dataUrl(imagePath) }] }], stream: true, metadata: { include_confidence: 'true', mask_encoding: 'one_bit' } }, 'text/event-stream');
  save('sam-raw.txt', raw); // keep raw SSE: mask decoding experiments are FREE offline, never re-pay for this
  let outputText = '';
  for (const line of raw.split('\n')) { const t = line.trim(); if (!t.startsWith('data:')) continue; const p = t.slice(5).trim(); if (!p || p === '[DONE]') continue; try { const ev = JSON.parse(p); if (ev.type === 'response.output_text.delta') outputText += ev.delta ?? ''; } catch {} }
  if (!outputText && raw.trim().startsWith('{')) { try { outputText = JSON.parse(raw).output_text ?? ''; } catch {} }
  save('sam.json', { concept, output_text: outputText });
  console.log(`SAM output_text (${outputText.length} chars): ${outputText.slice(0, 300)}`);
} else if (step === 2) {
  const sam = samFile();
  const boxRe = /(\d+)\s*<\|box;x1=([\d.]+);y1=([\d.]+);x2=([\d.]+);y2=([\d.]+)/g; const regions = []; let m;
  while ((m = boxRe.exec(sam.output_text))) regions.push({ regionId: `sam-${m[1]}`, bbox: { x: +m[2], y: +m[3], width: +m[4] - +m[2], height: +m[5] - +m[3] } });
  if (!regions.length) { console.error('REFUSED: step 1 found no boxes — try another --concept (no paid call made)'); process.exit(2); }
  const schema = { type: 'object', properties: { changes: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, regionId: { type: 'string' }, type: { type: 'string' }, description: { type: 'string' }, editPrompt: { type: 'string' }, severity: { type: 'string', enum: ['low', 'medium', 'high'] } }, required: ['id', 'regionId', 'type', 'description', 'editPrompt', 'severity'], additionalProperties: false } } }, required: ['changes'], additionalProperties: false };
  const raw = await call('Muse Spark structured plan', '/responses', { model: 'muse-spark-1.3', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: `Plan exactly 3 realistic localized changes. Types: remove object, change color, add object, alter shape. Use ONLY these regions, one change each: ${JSON.stringify(regions)}` }, { type: 'input_image', image_url: dataUrl(imagePath) }] }], text: { format: { type: 'json_schema', name: 'ChangePlan', schema, strict: true } } });
  save('plan-raw.json', raw);
  // Raw REST has no top-level output_text (SDK adds it): JSON is in output[].content[].text — learned call 2/6.
  try { const j = JSON.parse(raw); const txt = j.output_text ?? j.output?.find(o => o.type === 'message')?.content?.find(c => c.type === 'output_text')?.text; save('plan.json', JSON.parse(txt)); } catch { console.log('WARN: could not parse output text — inspect plan-raw.json'); }
} else if (step === 3) {
  const sam = samFile();
  const plan = existsSync(`${OUT}/plan.json`) ? JSON.parse(readFileSync(`${OUT}/plan.json`, 'utf8')) : null;
  const change = plan?.changes?.[0];
  const prompt = arg('prompt', change?.editPrompt ?? '');
  if (!prompt) { console.error('REFUSED: --prompt="..." required (or run --step=2 first)'); process.exit(2); }
  // Crop the SAM box OF THE PLANNED CHANGE (changes[0].regionId, e.g. "sam-4") — not just the first box.
  const wantedId = (change?.regionId ?? 'sam-0').replace('sam-', '');
  const boxRe = /(\d+)\s*<\|box;x1=([\d.]+);y1=([\d.]+);x2=([\d.]+);y2=([\d.]+)/g; let b = null, m;
  while ((m = boxRe.exec(sam.output_text))) if (m[1] === wantedId) b = m;
  if (!b) { console.error(`REFUSED: SAM box ${wantedId} not found (no paid call made)`); process.exit(2); }
  console.log(`Step 3: editing region sam-${wantedId} box=(${b[2]},${b[3]})-(${b[4]},${b[5]}) with prompt: ${prompt.slice(0, 90)}...`);
  // Crop SAM bbox + 25% margin with Pillow (project venv). If Pillow is missing we stop BEFORE any paid call.
  try { execFileSync('.venv/bin/python', ['-c', `from PIL import Image; import sys; im=Image.open(sys.argv[1]); x1,y1,x2,y2=map(float,sys.argv[2:6]); mx,my=(x2-x1)*0.25,(y2-y1)*0.25; im.crop((max(0,int(x1-mx)),max(0,int(y1-my)),min(im.width,int(x2+mx)),min(im.height,int(y2+my)))).save('${OUT}/crop.png')`, imagePath, b[2], b[3], b[4], b[5]], { stdio: 'inherit' }); }
  catch { console.error('REFUSED: Pillow crop failed — install worker deps first (no paid call made)'); process.exit(2); }
  save('edit-crop-response.json', await call('Muse Image edit CROP', '/images/edits', { model: 'muse-image-1.0', prompt, images: [{ image_url: dataUrl(`${OUT}/crop.png`) }], n: 1 }));
} else if (step === 4) {
  const prompt = arg('prompt', '');
  if (!prompt) { console.error('REFUSED: --prompt="..." required'); process.exit(2); }
  save('edit-full-response.json', await call('Muse Image edit FULL image', '/images/edits', { model: 'muse-image-1.0', prompt, images: [{ image_url: dataUrl(imagePath) }], n: 1 }));
} else if (step === 5) {
  const modified = arg('modified', '');
  if (!modified || !existsSync(modified) || !imagePath) { console.error('REFUSED: --step=5 needs --image=<original.png> --modified=<edited.png> (no paid call made)'); process.exit(2); }
  const schema = { type: 'object', properties: { ok: { type: 'boolean' }, notes: { type: 'string' } }, required: ['ok', 'notes'], additionalProperties: false };
  const plan = existsSync(`${OUT}/plan.json`) ? JSON.parse(readFileSync(`${OUT}/plan.json`, 'utf8')) : null;
  const change = plan?.changes?.[0] ? `${plan.changes[0].type} — ${plan.changes[0].description}` : arg('prompt', 'the planned change');
  save('verify-response.json', await call('Muse Spark verify', '/responses', { model: 'muse-spark-1.3', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: `Compare original (first) vs modified (second). Was this change applied realistically and confined to its region? Change: ${change}` }, { type: 'input_image', image_url: dataUrl(imagePath) }, { type: 'input_image', image_url: dataUrl(modified) }] }], text: { format: { type: 'json_schema', name: 'Verification', schema, strict: true } } }));
}
console.log(`Ledger: ${ledger.calls.length}/${MAX_CALLS} paid calls used. Report this call's cost from the Meta dashboard into AI_INTEGRATION.md.`);
