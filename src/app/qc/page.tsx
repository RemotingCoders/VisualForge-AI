'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { generateDemoScene, renderShapes } from '@/lib/demoScene';
import { clickHits, accuracy } from '@/lib/engine/geometry';
import { toCOCO, toYOLO } from '@/lib/coco';

const DEFECTS = ['scratch', 'crack', 'dent', 'missing component', 'corrosion', 'misalignment', 'wrong color', 'foreign object'];
type RealLevel = { levelId: string; original: string; modified: string; width: number; height: number; total: number; isMock: boolean; notice?: string };
type FoundDiff = { id: string; description: string; bbox: { x: number; y: number; width: number; height: number }; centroid: { x: number; y: number } | null };
type RevealDiff = { id: string; type: string; plannedType: string; label: string; severity: number | null; confidence: number | null; needsReview: boolean; bbox: { x: number; y: number; width: number; height: number }; centroid: { x: number; y: number } | null };
const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export default function QC() {
  const scene = useMemo(() => generateDemoScene(42), []); const [found, setFound] = useState<string[]>([]); const [falsePos, setFalsePos] = useState(0); const [revealed, setRevealed] = useState(false); const ref = useRef<SVGSVGElement>(null);
  const [photo, setPhoto] = useState(''); const [photoName, setPhotoName] = useState(''); const [count, setCount] = useState(2); const [job, setJob] = useState(''); const [real, setReal] = useState<RealLevel | null>(null);
  const [dragOver, setDragOver] = useState(false); const [fileMsg, setFileMsg] = useState(''); const fileRef = useRef<HTMLInputElement>(null);
  // --- Real-level trainer state (separate from the MOCK scene trainer below) ---
  const [realFound, setRealFound] = useState<FoundDiff[]>([]); const [realFalsePos, setRealFalsePos] = useState(0);
  const [realMisses, setRealMisses] = useState<{ x: number; y: number }[]>([]); const [realRevealed, setRealRevealed] = useState(false);
  const [revealDiffs, setRevealDiffs] = useState<RevealDiff[]>([]); const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0); const [sessionMsg, setSessionMsg] = useState('');
  const imgRef = useRef<HTMLImageElement>(null); const sessionPosted = useRef(false);
  const [demoOpen, setDemoOpen] = useState(true);
  /** Judge access code — same shared field as /play (remembered in localStorage). */
  const [accessCode, setAccessCode] = useState('');
  useEffect(() => { try { setAccessCode(localStorage.getItem('vf-access-code') ?? ''); } catch { /* private window */ } }, []);
  // A fresh real level resets the trainer, starts the clock and folds the MOCK demo away.
  useEffect(() => {
    if (!real) return;
    setRealFound([]); setRealFalsePos(0); setRealMisses([]); setRealRevealed(false); setRevealDiffs([]);
    setSessionMsg(''); sessionPosted.current = false; setStartedAt(Date.now()); setElapsed(0); setDemoOpen(false);
  }, [real]);
  // Inspection timer: ticks while a real level is loaded and not yet revealed.
  useEffect(() => {
    if (!startedAt || realRevealed) return;
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 500);
    return () => clearInterval(t);
  }, [startedAt, realRevealed]);
  const click = (e: React.MouseEvent) => { if (!ref.current || revealed) return; const r = ref.current.getBoundingClientRect(); const x = ((e.clientX - r.left) / r.width) * 400, y = ((e.clientY - r.top) / r.height) * 300;
    const hit = scene.differences.find(d => !found.includes(d.id) && clickHits({ x, y }, d.bbox, 14)); hit ? setFound(f => [...f, hit.id]) : setFalsePos(n => n + 1); };
  /** Real trainer: clicks on the defective unit are validated by the server
   *  (/api/validate-click) — the defect annotations never ship to the client. */
  const clickReal = async (e: React.MouseEvent) => {
    if (!real || realRevealed || !imgRef.current) return;
    const r = imgRef.current.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * real.width, y = ((e.clientY - r.top) / r.height) * real.height;
    const res = await fetch('/api/validate-click', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ levelId: real.levelId, x, y, foundIds: realFound.map(f => f.id) }) });
    const data = await res.json().catch(() => null);
    if (data?.hit && data.difference) setRealFound(f => [...f, data.difference]);
    else { setRealFalsePos(n => n + 1); setRealMisses(m => [...m, { x: (x / real.width) * 100, y: (y / real.height) * 100 }]); }
  };
  /** Reveal & score: fetch every defect box + classified type (QC-only endpoint),
   *  stop the clock and record the training session exactly once. */
  const revealReal = async () => {
    if (!real || realRevealed) return;
    const res = await fetch(`/api/qc-reveal?levelId=${real.levelId}`);
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.differences) { alert(data?.error ?? 'Could not reveal this level.'); return; }
    const durationSec = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : elapsed;
    setElapsed(durationSec); setRevealDiffs(data.differences); setRealRevealed(true);
    if (!sessionPosted.current) {
      sessionPosted.current = true;
      const missed = Math.max(0, real.total - realFound.length);
      const s = await fetch('/api/qc-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ levelId: real.levelId, correct: realFound.length, missed, falsePositives: realFalsePos, durationSec }) }).then(r => r.json()).catch(() => null);
      setSessionMsg(s?.ok ? `Session saved · accuracy ${Math.round((s.session.accuracy ?? 0) * 100)}% · ${durationSec}s` : 'Session could not be saved.');
    }
  };
  const download = (name: string, text: string) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = name; a.click(); };
  const coco = () => download('visualforge-dataset.json', JSON.stringify(toCOCO([{ id: 1, file_name: 'product-modified.svg', width: 400, height: 300 }], scene.differences.map((d, i) => ({ imageId: 1, categoryId: (i % DEFECTS.length) + 1, bbox: d.bbox })), DEFECTS.map((n, i) => ({ id: i + 1, name: n }))), null, 2));
  const onFile = (f: File | undefined | null) => {
    if (!f) return;
    if (!f.type.startsWith('image/')) { setFileMsg(`❌ "${f.name}" is not an image — drop a JPG, PNG or WebP photo.`); return; }
    const r = new FileReader(); r.onload = () => { setPhoto(String(r.result)); setPhotoName(f.name); setFileMsg(''); }; r.readAsDataURL(f);
  };
  const onDrop = (e: React.DragEvent) => { e.preventDefault(); setDragOver(false); onFile(e.dataTransfer.files?.[0]); };
  /** Real QC path: photo -> async generation job (mode 'qc') -> level -> trainer + COCO/YOLO export of that level. */
  const generateReal = async () => {
    setJob('creating job…');
    const res = await fetch('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ imageDataUrl: photo || undefined, count, mode: 'qc', accessCode: accessCode || undefined }) });
    const data = await res.json();
    if (res.status === 401) { setJob(''); alert('Generating new levels needs the access code provided in the hackathon submission. You can still play the demo and the gallery below.'); return; }
    if (!res.ok) { setJob(''); alert(data.error ?? 'generation failed'); return; }
    if (data.isMock) { setJob(''); setReal(null); alert('Offline MOCK provider: real QC generation is off. The offline MOCK trainer scene at the bottom remains available.'); return; }
    for (let i = 0; i < 600; i++) {
      const s = await (await fetch(`/api/generate?id=${data.jobId}`)).json();
      setJob(`job ${s.status}${s.stage ? ` · ${s.stage}` : ''} · ${s.elapsedSec ?? '?'}s elapsed (each AI call takes 3-60s)`);
      if (s.status === 'failed') { setJob(''); alert(`Generation failed at stage "${s.stage}": ${s.error ?? 'unknown error'}`); return; }
      if (s.status === 'done' && s.level && !s.level.demo) { setReal(s.level); setJob(''); return; }
      await new Promise(r => setTimeout(r, 1000));
    }
    setJob(''); alert('Generation timed out after 10 minutes — check Meta dashboard usage before retrying.');
  };
  const pct = (v: number, total: number) => `${(v / total) * 100}%`;
  return (<main className="max-w-5xl mx-auto px-5 py-8 font-mono">
    <h1 className="text-3xl font-black">🏭 QC Inspection Trainer</h1><p className="opacity-70 mt-2 text-sm">Industrial mode · synthetic defects — validate before industrial use · generate a real defect level from your own photo, inspect the defective unit, then reveal &amp; score. The offline MOCK scene lives at the bottom.</p>
    <section className="mt-5 rounded bg-white/5 border border-white/10 p-4 text-sm">
      <h2 className="font-bold">📸 Real QC level from a photo</h2>
      {/* Drag & drop zone — same pattern as /play: also clickable to open the file picker. */}
      <div
        role="button" tabIndex={0} aria-label="Drop a product photo here or click to choose a file"
        onClick={() => fileRef.current?.click()}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click(); } }}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragEnter={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`mt-3 rounded border-2 border-dashed px-4 py-6 text-center cursor-pointer transition-all ${dragOver ? 'border-indigo-400 bg-indigo-500/20' : 'border-white/25 bg-white/5 hover:border-indigo-400/70 hover:bg-white/10'}`}
      >
        <input ref={fileRef} type="file" accept="image/*" aria-label="Upload a product photo" onChange={e => { onFile(e.target.files?.[0]); e.target.value = ''; }} className="hidden" />
        {photo ? (
          <div className="flex items-center justify-center gap-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={photo} alt="Your uploaded product photo" className="h-20 w-20 object-cover rounded border border-white/20" />
            <div className="text-left">
              <p className="font-bold text-sm">✅ {photoName || 'Photo'} ready ({Math.round(photo.length / 1024)} KB)</p>
              <p className="text-xs opacity-70 mt-1">{dragOver ? 'Drop to replace this photo!' : 'Drop another image here to replace it, or press Generate QC level.'}</p>
            </div>
          </div>
        ) : (
          <>
            <p className="text-4xl">{dragOver ? '📥' : '🖼️'}</p>
            <p className="font-bold mt-2">{dragOver ? 'Drop the image to upload it!' : 'Drag & drop your product photo here'}</p>
            <p className="text-xs opacity-70 mt-1">or click to choose a file · JPG, PNG, WebP…</p>
          </>
        )}
      </div>
      {fileMsg && <p className="text-red-300 text-xs mt-2">{fileMsg}</p>}
      <div className="flex flex-wrap items-center gap-3 mt-3">
        <label>Defects <select aria-label="Number of defects" value={count} onChange={e => setCount(Number(e.target.value))} className="bg-white/10 px-2 py-2 rounded text-white">{[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n}</option>)}</select></label>
        <button className="bg-indigo-500 font-bold px-4 py-2 rounded disabled:opacity-50" disabled={!!job || !photo} onClick={generateReal}>{job ? '⏳ Generating…' : '⚙️ Generate QC level'}</button>
        <label>Judge access code <input type="password" aria-label="Judge access code" value={accessCode} onChange={e => { setAccessCode(e.target.value); try { localStorage.setItem('vf-access-code', e.target.value); } catch { /* private window */ } }} placeholder="for judges" className="bg-white/10 px-2 py-2 rounded text-white w-36" /></label>
        {job && <span className="opacity-80">{job}</span>}
      </div>
      {real && (<div className="mt-4">
        {real.notice && <p className="rounded bg-amber-500/20 border border-amber-400/40 text-amber-200 px-3 py-2 text-xs mb-3">⚠️ {real.notice} — this level ships with the defects that could be verified; inspect what is actually there.</p>}
        <div className="grid md:grid-cols-2 gap-5">
          <div><h3 className="font-bold mb-2">Reference (known-good)</h3>{/* eslint-disable-next-line @next/next/no-img-element */}<img src={real.original} alt="Original product" className="w-full rounded bg-slate-900" /></div>
          <div>
            <h3 className="font-bold mb-2">Defective unit — click the defects ({real.total} verified)</h3>
            <div className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img ref={imgRef} src={real.modified} alt="Unit with synthetic defects" onClick={clickReal} className={`w-full rounded bg-slate-900 ${realRevealed ? '' : 'cursor-crosshair'}`} />
              {realFound.map(f => {
                const c = f.centroid ?? { x: f.bbox.x + f.bbox.width / 2, y: f.bbox.y + f.bbox.height / 2 };
                return (<div key={f.id} title={f.description} className="absolute rounded-full border-4 border-emerald-400 pointer-events-none" style={{ left: pct(c.x - f.bbox.width / 2, real.width), top: pct(c.y - f.bbox.height / 2, real.height), width: pct(f.bbox.width, real.width), height: pct(f.bbox.height, real.height) }} />);
              })}
              {!realRevealed && realMisses.map((m, i) => (<div key={i} className="absolute text-red-400 font-black pointer-events-none" style={{ left: `${m.x}%`, top: `${m.y}%`, transform: 'translate(-50%,-50%)' }}>✕</div>))}
              {realRevealed && revealDiffs.map(d => (
                <div key={d.id} className="absolute border-[3px] border-red-500 pointer-events-none" style={{ left: pct(d.bbox.x, real.width), top: pct(d.bbox.y, real.height), width: pct(d.bbox.width, real.width), height: pct(d.bbox.height, real.height) }}>
                  <span className="absolute left-0 -top-6 whitespace-nowrap bg-red-500 text-white text-[11px] font-bold px-1 rounded">{d.type}{d.severity ? ` · sev ${d.severity}` : ''}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-3 mt-4 text-sm">
          <span className="bg-white/10 px-3 py-1 rounded">Correct {realFound.length}</span>
          <span className="bg-white/10 px-3 py-1 rounded">False positives {realFalsePos}</span>
          <span className="bg-white/10 px-3 py-1 rounded">Accuracy {Math.round(accuracy(realFound.length, realFound.length + realFalsePos) * 100)}%</span>
          <span className="bg-white/10 px-3 py-1 rounded">⏱ {fmtTime(elapsed)}</span>
          <button className="bg-amber-500 text-black font-bold px-3 py-1 rounded disabled:opacity-50" disabled={realRevealed} onClick={revealReal}>Reveal &amp; score</button>
          {sessionMsg && <span className="opacity-80">{sessionMsg}</span>}
        </div>
        {realRevealed && (<div className="mt-3 text-xs">
          <p>Missed: {Math.max(0, real.total - realFound.length)} of {real.total} defects.</p>
          <ul className="mt-2 space-y-1">
            {revealDiffs.map(d => (<li key={d.id} className="bg-white/5 rounded px-2 py-1">
              {realFound.some(f => f.id === d.id) ? '✅' : '❌'} <b>{d.type}</b> — {d.label}
              {d.severity ? ` · severity ${d.severity}/5` : ''}{d.confidence !== null ? ` · confidence ${Math.round(d.confidence * 100)}%` : ''}
              {d.type !== d.plannedType ? ` · planned as “${d.plannedType}”` : ''}{d.needsReview ? ' · ⚠️ needs review (low confidence)' : ''}
            </li>))}
          </ul>
        </div>)}
        <div className="flex flex-wrap gap-3 mt-4">
          <a className="bg-indigo-500 font-bold px-3 py-1 rounded" href={`/api/qc-export?levelId=${real.levelId}&format=coco`} download>⬇ Export this level — COCO JSON</a>
          <a className="bg-white/15 px-3 py-1 rounded" href={`/api/qc-export?levelId=${real.levelId}&format=yolo`} download>⬇ Export this level — YOLO txt</a>
          <a className="bg-white/15 px-3 py-1 rounded" href={`/api/qc-export?levelId=${real.levelId}&format=coco&part=review`} download>⬇ Needs review — COCO</a>
          <a className="bg-white/15 px-3 py-1 rounded" href={`/api/qc-export?levelId=${real.levelId}&format=yolo&part=review`} download>⬇ Needs review — YOLO</a>
        </div>
        <p className="opacity-70 mt-2 text-xs">Exports include ONLY verified defects, labeled with the classified defect type, with the measured defect bbox (from the pixel-diff mask — not the edit crop). Defects classified with confidence under 60% are exported separately as needs_review. Clicks are validated by the server; the defect boxes stay server-side until you reveal. Synthetic data: validate before industrial use.</p>
      </div>)}
    </section>
    <details open={demoOpen} onToggle={e => setDemoOpen(e.currentTarget.open)} className="mt-8 rounded bg-white/5 border border-white/10 p-4">
      <summary className="font-bold cursor-pointer text-sm">🧩 Offline demo (MOCK) — practice scene, no AI generation</summary>
      <div className="grid md:grid-cols-2 gap-5 mt-4">
        <div><h2 className="font-bold mb-2">Reference (known-good)</h2><svg viewBox="0 0 400 300" className="w-full rounded bg-slate-900" dangerouslySetInnerHTML={{ __html: renderShapes(scene.original) }} /></div>
        <div><h2 className="font-bold mb-2">Inspect this unit — click defects</h2><svg ref={ref} onClick={click} viewBox="0 0 400 300" className="w-full rounded bg-slate-900 cursor-crosshair" dangerouslySetInnerHTML={{ __html: renderShapes(scene.modified) + (revealed ? scene.differences.map(d => `<rect x="${d.bbox.x}" y="${d.bbox.y}" width="${d.bbox.width}" height="${d.bbox.height}" fill="none" stroke="#ef4444" stroke-width="3"/>`).join('') : '') }} /></div>
      </div>
      <div className="flex flex-wrap gap-3 mt-5 text-sm"><span className="bg-white/10 px-3 py-1 rounded">Correct {found.length}</span><span className="bg-white/10 px-3 py-1 rounded">False positives {falsePos}</span><span className="bg-white/10 px-3 py-1 rounded">Accuracy {Math.round(accuracy(found.length, found.length + falsePos) * 100)}%</span>
        <button className="bg-amber-500 text-black font-bold px-3 py-1 rounded" onClick={() => setRevealed(true)}>Reveal &amp; score</button>
        <button className="bg-indigo-500 font-bold px-3 py-1 rounded" onClick={coco}>⬇ MOCK scene — COCO JSON</button>
        <button className="bg-white/15 px-3 py-1 rounded" onClick={() => download('labels.txt', scene.differences.map((d, i) => toYOLO(d.bbox, 400, 300, i % DEFECTS.length)).join('\n'))}>⬇ MOCK scene — YOLO txt</button></div>
      {revealed && <p className="mt-4 text-sm">Missed: {scene.differences.length - found.length} · Only verified/human-approved samples enter production exports; unverified are separated and labeled synthetic.</p>}
    </details>
  </main>);
}
