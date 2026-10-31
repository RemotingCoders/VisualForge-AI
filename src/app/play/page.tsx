'use client';
import { useEffect, useRef, useState } from 'react';
import confetti from 'canvas-confetti';
import type { Shape } from '@/lib/demoScene';
import { renderShapes } from '@/lib/demoScene';
import { scoreGame } from '@/lib/engine/geometry';
import { playFound, playMiss, playFanfare } from '@/lib/sounds';

type Found = { id: string; description: string; bbox: { x: number; y: number; width: number; height: number }; centroid?: { x: number; y: number } | null };
type ImgLevel = { levelId: string; original: string; modified: string; width: number; height: number; total: number; isMock: boolean; theme?: string; revisedPrompt?: string };

/** Pipeline steps shown while generating — mapped from the server job stage strings. */
const STEPS = [
  { label: 'Preparing photo', icon: '📸' },
  { label: 'Segmenting objects · SAM 3.1', icon: '✂️' },
  { label: 'Planning changes · Muse Spark', icon: '🧠' },
  { label: 'Editing · Muse Image', icon: '🎨' },
  { label: 'Measuring & verifying', icon: '🔍' },
  { label: 'Level ready', icon: '🎉' },
];
/** VF_THEME_GENERATION prepends one step: the scene itself is created first. */
const SCENE_STEP = { label: 'Creating scene · Muse Image', icon: '🌄' };
function stageToStep(stage: string, status: string, withScene = false): number {
  if (status === 'done') return withScene ? STEPS.length : STEPS.length - 1;
  const s = stage.toLowerCase();
  if (withScene && (s.includes('generating scene') || s.includes('moderating theme'))) return 0;
  let base: number;
  if (s.includes('verif') || s.includes('measur') || s.includes('review') || s.includes('compos')) base = 4;
  else if (s.includes('edit') || s.includes('one-pass') || s.includes('extract') || s.includes('generat')) base = 3;
  else if (s.includes('plan')) base = 2;
  else if (s.includes('segment')) base = 1;
  else base = 0; // queued / creating / normalizing / moderating
  return withScene ? base + 1 : base;
}

export default function Play() {
  const [levelId, setLevelId] = useState(''); const [orig, setOrig] = useState<Shape[]>([]); const [mod, setMod] = useState<Shape[]>([]);
  const [img, setImg] = useState<ImgLevel | null>(null);
  const [total, setTotal] = useState(0); const [found, setFound] = useState<Found[]>([]); const [mistakes, setMistakes] = useState(0);
  const [hints, setHints] = useState(0); const [msg, setMsg] = useState('Loading MOCK level…'); const [start] = useState(Date.now());
  const [photo, setPhoto] = useState(''); const [photoName, setPhotoName] = useState(''); const [count, setCount] = useState(5); const [difficulty, setDifficulty] = useState('medium'); const [job, setJob] = useState('');
  const [busy, setBusy] = useState(false); const [dragOver, setDragOver] = useState(false); const [step, setStep] = useState(0); const [stageText, setStageText] = useState(''); const [jobElapsed, setJobElapsed] = useState(0);
  const [theme, setTheme] = useState(''); const [themeUsed, setThemeUsed] = useState(false); const [previewImage, setPreviewImage] = useState('');
  const svgRef = useRef<SVGSVGElement>(null); const imgRef = useRef<HTMLImageElement>(null); const fileRef = useRef<HTMLInputElement>(null);

  const resetGame = (t: number) => { setTotal(t); setFound([]); setMistakes(0); setHints(0); };
  const load = async (seed = Math.floor(Math.random() * 9999)) => { setImg(null); const d = await (await fetch(`/api/demo-level?seed=${seed}`)).json(); setLevelId(d.levelId); setOrig(d.original); setMod(d.modified); resetGame(d.total); setJob(''); setMsg('Find all differences! Click the modified image (right / bottom).'); };
  useEffect(() => { load(7); }, []);

  const onFile = (f: File | undefined | null) => {
    if (!f) return;
    if (!f.type.startsWith('image/')) { setMsg(`❌ “${f.name}” is not an image — drop a JPG, PNG or WebP photo.`); return; }
    const r = new FileReader(); r.onload = () => { setPhoto(String(r.result)); setPhotoName(f.name); setMsg(`📸 Photo ready: ${f.name} — pick differences & difficulty, then Generate.`); }; r.readAsDataURL(f);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    onFile(e.dataTransfer.files?.[0]);
  };

  /** Upload (or theme) -> POST /api/generate (async job) -> poll stage -> playable level. Mock mode returns the labeled demo level. */
  const generate = async () => {
    // A theme replaces the photo entirely: the scene itself gets generated (VF_THEME_GENERATION).
    const usingTheme = theme.trim().length > 0;
    const finalStep = STEPS.length + (usingTheme ? 1 : 0) - 1;
    // Clear the previous level immediately so only the processing animation is visible.
    setImg(null); setOrig([]); setMod([]); setLevelId(''); resetGame(0);
    setBusy(true); setStep(0); setStageText('creating job…'); setJobElapsed(0);
    setThemeUsed(usingTheme); setPreviewImage('');
    setJob('creating job…'); setMsg('Generating level — the AI pipeline takes a few seconds per change.');
    const finish = () => { setBusy(false); setJob(''); };
    const res = await fetch('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(usingTheme ? { theme: theme.trim(), count, mode: 'game', difficulty } : { imageDataUrl: photo || undefined, count, mode: 'game', difficulty }) });
    const data = await res.json();
    if (!res.ok) { finish(); setMsg(`❌ ${data.error ?? 'generation failed'}`); return; }
    for (let i = 0; i < 600; i++) {
      const s = await (await fetch(`/api/generate?id=${data.jobId}`)).json();
      setJob(`job ${s.status}${s.stage ? ` · ${s.stage}` : ''}${s.isMock ? ' · MOCK' : ''} · ${s.elapsedSec ?? '?'}s elapsed (each AI call takes 3-60s; a full level can take several minutes)`);
      setStageText(String(s.stage ?? s.status ?? '')); setJobElapsed(Number(s.elapsedSec ?? 0));
      if (s.previewImage) setPreviewImage(String(s.previewImage));
      setStep(prev => Math.max(prev, stageToStep(String(s.stage ?? ''), String(s.status ?? ''), usingTheme))); // monotonic: editing/verifying alternate per change
      if (s.status === 'failed') { finish(); setMsg(s.error === 'theme_rejected' ? '❌ Your theme was rejected by moderation — try a different theme.' : `❌ Generation failed at stage "${s.stage}": ${s.error ?? 'unknown error'}`); return; }
      if (s.status === 'done' && s.level) {
        const lv = s.level;
        setStep(finalStep);
        setLevelId(lv.levelId); resetGame(lv.total); finish();
        if (lv.demo) { setImg(null); setOrig(lv.original); setMod(lv.modified); setMsg('MOCK demo level ready (offline provider) — find all differences!'); }
        else { setImg(lv); setMsg(lv.isMock ? 'Level ready — find all differences!' : '✅ Real AI level ready — find all differences!'); }
        return;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    finish();
    setMsg('❌ Generation timed out after 10 minutes — check the Meta dashboard usage before retrying (calls may have been billed), then try fewer changes.');
  };

  const validate = async (x: number, y: number) => {
    const res = await (await fetch('/api/validate-click', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ levelId, x, y, foundIds: found.map(f => f.id) }) })).json();
    if (res.hit) { setFound(f => [...f, res.difference]); playFound(); setMsg(`✅ ${res.difference.description}`); } else { setMistakes(m => m + 1); playMiss(); setMsg('❌ Not there — mistake!'); }
  };
  const clickSvg = (e: React.MouseEvent) => {
    if (!svgRef.current || found.length >= total || mistakes >= 5) return;
    const r = svgRef.current.getBoundingClientRect();
    void validate(((e.clientX - r.left) / r.width) * 400, ((e.clientY - r.top) / r.height) * 300);
  };
  const clickImg = (e: React.MouseEvent) => {
    if (!imgRef.current || !img || found.length >= total || mistakes >= 5) return;
    const r = imgRef.current.getBoundingClientRect();
    void validate(((e.clientX - r.left) / r.width) * img.width, ((e.clientY - r.top) / r.height) * img.height);
  };

  const done = total > 0 && found.length >= total; const elapsed = Math.round((Date.now() - start) / 1000);
  const steps = themeUsed ? [SCENE_STEP, ...STEPS] : STEPS;
  const celebrated = useRef(false);
  useEffect(() => {
    if (!done || celebrated.current) return;
    celebrated.current = true;
    playFanfare();
    const colors = ['#6366f1', '#22c55e', '#fbbf24', '#06b6d4', '#f472b6'];
    confetti({ particleCount: 130, spread: 80, origin: { y: 0.6 }, colors });
    const end = Date.now() + 1100; // side cannons, ~1s of party
    (function frame() {
      confetti({ particleCount: 4, angle: 60, spread: 60, startVelocity: 55, origin: { x: 0, y: 0.7 }, colors });
      confetti({ particleCount: 4, angle: 120, spread: 60, startVelocity: 55, origin: { x: 1, y: 0.7 }, colors });
      if (Date.now() < end) requestAnimationFrame(frame);
    })();
  }, [done]);
  useEffect(() => { if (!done) celebrated.current = false; }, [done]);
  const Panel = ({ shapes, onClick, marks }: { shapes: Shape[]; onClick?: (e: React.MouseEvent) => void; marks?: Found[] }) => (
    <svg ref={onClick ? svgRef : undefined} onClick={onClick} viewBox="0 0 400 300" className={`w-full rounded-xl bg-gradient-to-br from-slate-800 to-slate-950 ${onClick ? 'cursor-crosshair' : ''}`} dangerouslySetInnerHTML={{ __html: renderShapes(shapes) + (marks ?? []).map(f => `<circle cx="${f.bbox.x + f.bbox.width / 2}" cy="${f.bbox.y + f.bbox.height / 2}" r="${Math.max(f.bbox.width, f.bbox.height) * 0.58}" fill="none" stroke="#22c55e" stroke-width="3"/>`).join('') }} />);
  const ImgPanel = ({ src, clickable }: { src: string; clickable?: boolean }) => (
    <div className="relative w-full">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img ref={clickable ? imgRef : undefined} src={src} alt={clickable ? 'Modified — click differences' : 'Original'} onClick={clickable ? clickImg : undefined} className={`w-full rounded-xl ${clickable ? 'cursor-crosshair' : ''}`} />
      {clickable && img && found.map(f => {
        // Circle centered on the MEASURED center of the change (centroid), not the bbox corner box.
        const cx = f.centroid?.x ?? (f.bbox.x + f.bbox.width / 2);
        const cy = f.centroid?.y ?? (f.bbox.y + f.bbox.height / 2);
        const d = Math.max(f.bbox.width, f.bbox.height) * 1.15;
        return (<div key={f.id} className="absolute border-[3px] border-green-500 rounded-full aspect-square pointer-events-none" style={{ left: `${(cx / img.width) * 100}%`, top: `${(cy / img.height) * 100}%`, width: `${(d / img.width) * 100}%`, transform: 'translate(-50%, -50%)' }} />);
      })}
    </div>);

  return (<main className="max-w-6xl mx-auto px-5 py-8">
    <h1 className="text-3xl font-black">🔎 Diferia — Play Your Photo {img && !img.isMock ? <span className="text-sm align-middle bg-green-400 text-black px-2 py-1 rounded">REAL AI LEVEL</span> : <span className="text-sm align-middle bg-amber-400 text-black px-2 py-1 rounded">MOCK LEVEL</span>}</h1>
    <p className="opacity-75 mt-2">Upload a photo and the verified pipeline (SAM 3.1 → Muse Spark → Muse Image crop+composite → pixel-diff measurement → Spark verify) builds a playable level. Annotations stay on the server until you find them. With the offline MOCK provider you get the labeled demo level instead — never a fake “AI” result.</p>

    <section className="mt-5 rounded-xl bg-white/5 border border-white/10 p-4">
      <h2 className="font-bold">📸 Create a level from your photo</h2>
      {/* Drag & drop zone — also clickable to open the file picker. Accepts image files only. */}
      <div
        role="button" tabIndex={0} aria-label="Drop an image here or click to choose a photo"
        onClick={() => fileRef.current?.click()}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click(); } }}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragEnter={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={e => { e.preventDefault(); setDragOver(false); }}
        onDrop={onDrop}
        className={`mt-3 rounded-xl border-2 border-dashed px-4 py-6 text-center cursor-pointer transition-all ${dragOver ? 'border-indigo-400 bg-indigo-500/20 scale-[1.01]' : 'border-white/25 bg-white/5 hover:border-indigo-400/70 hover:bg-white/10'}`}
      >
        <input ref={fileRef} type="file" accept="image/*" aria-label="Upload a photo" onChange={e => { onFile(e.target.files?.[0]); e.target.value = ''; }} className="hidden" />
        {photo ? (
          <div className="flex items-center justify-center gap-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={photo} alt="Your uploaded photo" className="h-20 w-20 object-cover rounded-lg border border-white/20" />
            <div className="text-left">
              <p className="font-bold text-sm">✅ {photoName || 'Photo'} ready ({Math.round(photo.length / 1024)} KB)</p>
              <p className="text-xs opacity-70 mt-1">{dragOver ? 'Drop to replace this photo!' : 'Drop another image here to replace it, or press Generate.'}</p>
            </div>
          </div>
        ) : (
          <>
            <p className="text-4xl">{dragOver ? '📥' : '🖼️'}</p>
            <p className="font-bold mt-2">{dragOver ? 'Drop the image to upload it!' : 'Drag & drop your photo here'}</p>
            <p className="text-xs opacity-70 mt-1">or click to choose a file · JPG, PNG, WebP…</p>
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3 mt-3 text-sm">
        <label>Differences <select aria-label="Number of differences" value={count} onChange={e => setCount(Number(e.target.value))} className="bg-white/10 px-2 py-2 rounded-lg text-white"><option value={3}>3</option><option value={5}>5</option><option value={7}>7</option></select></label>
        <label>Difficulty <select aria-label="Difficulty" value={difficulty} onChange={e => setDifficulty(e.target.value)} className="bg-white/10 px-2 py-2 rounded-lg text-white"><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></select></label>
        <button className="bg-indigo-500 px-4 py-2 rounded-lg font-bold disabled:opacity-50" disabled={busy} onClick={generate}>{busy ? '⏳ Generating…' : '✨ Generate level'}</button>
        {busy && <span className="opacity-80">{steps[step]?.icon} {steps[step]?.label} · {jobElapsed}s</span>}
      </div>
      <div className="mt-3">
        <label className="text-sm block">🎨 …or describe a scene instead of uploading
          <input aria-label="Scene theme" type="text" maxLength={200} value={theme} onChange={e => setTheme(e.target.value)} placeholder="un jardín otoñal con una cabaña" className="mt-1 w-full bg-white/10 px-3 py-2 rounded-lg text-white placeholder:text-white/40" />
        </label>
        <p className="text-xs opacity-60 mt-1">With a theme, Muse Image creates the scene first (needs VF_THEME_GENERATION=true server-side); the photo above is ignored.</p>
      </div>
      {photo && <p className="text-xs opacity-70 mt-2">It is processed server-side; uploads are not kept in saved levels.</p>}
      <p className="text-xs opacity-60 mt-2">Real generation requires <code>AI_PROVIDER=meta</code> + <code>META_REAL_CALLS_ENABLED=true</code> server-side (credit-protected). Otherwise this returns the MOCK demo level.</p>
    </section>

    <div className="flex flex-wrap gap-3 my-5 text-sm"><span className="bg-white/10 px-3 py-1 rounded-full">Found {found.length}/{total}</span><span className="bg-white/10 px-3 py-1 rounded-full">Mistakes {mistakes}/5</span>
      <button className="bg-white/10 px-3 py-1 rounded-full" onClick={() => { setHints(h => h + 1); setMsg('💡 Hint: compare corners and large shapes first.'); }}>💡 Hint ({hints})</button>
      <button className="bg-indigo-500 px-3 py-1 rounded-full font-bold" onClick={() => load()}>↻ New demo level</button>
      {typeof window !== 'undefined' && levelId && <button className="bg-white/10 px-3 py-1 rounded-full" onClick={() => navigator.clipboard?.writeText(`${location.origin}/play?level=${levelId}`)}>🔗 Share link</button>}</div>
    <p aria-live="polite" className="font-semibold">{done ? `🎉 Finished! Score ${scoreGame(found.length, total, mistakes, hints, elapsed)} · ${elapsed}s` : msg}</p>
    {img?.theme && <p className="text-sm opacity-80 mt-1">🎨 Escena: “{img.revisedPrompt || img.theme}”</p>}
    {busy ? (
      <section aria-label="Generating level" className="mt-4 rounded-xl bg-white/5 border border-indigo-400/30 p-8 text-center overflow-hidden">
        {/* Big processing wheel: two counter-rotating rings + pulsing core */}
        <div className="relative w-44 h-44 mx-auto" aria-hidden="true">
          <div className="absolute inset-0 rounded-full border-8 border-white/10 border-t-indigo-400 animate-spin" />
          <div className="absolute inset-4 rounded-full border-4 border-dashed border-cyan-400/60 animate-[spin_7s_linear_infinite_reverse]" />
          <div className="absolute inset-9 rounded-full border-4 border-white/10 border-b-fuchsia-400 animate-[spin_3s_linear_infinite]" />
          <div className="absolute inset-0 flex items-center justify-center text-5xl animate-pulse">{steps[step]?.icon}</div>
        </div>
        <h2 className="text-2xl font-black mt-6">Creating your level…</h2>
        <p className="opacity-80 mt-1">{steps[step]?.label} · {jobElapsed}s elapsed</p>
        <p className="text-xs opacity-50 mt-1 font-mono">{stageText || 'starting…'}</p>
        {previewImage && (
          <figure className="mt-6 max-w-md mx-auto">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={previewImage} alt="Your generated scene" className="w-full rounded-xl border border-white/20" />
            <figcaption className="text-xs opacity-70 mt-2">Your scene is ready — building the differences…</figcaption>
          </figure>
        )}
        {/* Stepper: done = green check, current = pulsing, pending = dim */}
        <ol className="flex flex-wrap justify-center gap-x-2 gap-y-3 mt-7 max-w-2xl mx-auto">
          {steps.map((s, i) => (
            <li key={s.label} className="flex items-center gap-2">
              <span className={`flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded-full border ${i < step ? 'bg-green-500/20 border-green-400/50 text-green-300' : i === step ? 'bg-indigo-500/25 border-indigo-400 text-white animate-pulse' : 'bg-white/5 border-white/10 opacity-45'}`}>
                {i < step ? '✓' : s.icon} <span className="hidden sm:inline">{s.label}</span>
              </span>
              {i < steps.length - 1 && <span className={`w-3 h-0.5 ${i < step ? 'bg-green-400/60' : 'bg-white/15'}`} />}
            </li>
          ))}
        </ol>
        <div className="h-2 rounded-full bg-white/10 mt-7 max-w-xl mx-auto overflow-hidden">
          <div className="h-full rounded-full bg-gradient-to-r from-indigo-400 via-cyan-400 to-fuchsia-400 transition-all duration-700" style={{ width: `${Math.round(((step + 1) / steps.length) * 100)}%` }} />
        </div>
        <p className="text-xs opacity-60 mt-4">Each AI call takes ~3–60s — a full level can take a few minutes. Keep this tab open.</p>
      </section>
    ) : img ? (
      <div className="grid md:grid-cols-2 gap-5 mt-4"><div><h2 className="font-bold mb-2">Original</h2><ImgPanel src={img.original} /></div>
        <div><h2 className="font-bold mb-2">Modified — click differences</h2><ImgPanel src={img.modified} clickable /></div></div>
    ) : (
      <div className="grid md:grid-cols-2 gap-5 mt-4"><div><h2 className="font-bold mb-2">Original</h2><Panel shapes={orig} /></div>
        <div><h2 className="font-bold mb-2">Modified — click differences</h2><Panel shapes={mod} onClick={clickSvg} marks={found} /></div></div>
    )}
    <ul className="mt-4 text-sm">{found.map(f => <li key={f.id}>✅ {f.description}</li>)}</ul>
    {mistakes >= 5 && !done && <p className="text-red-300 font-bold mt-3">Out of mistakes — generate or load a new level to try again.</p>}
  </main>);
}
