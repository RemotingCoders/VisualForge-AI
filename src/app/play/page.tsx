'use client';
import { useEffect, useRef, useState } from 'react';
import confetti from 'canvas-confetti';
import { scoreGame } from '@/lib/engine/geometry';
import { challengeVerdict } from '@/lib/aiInspect';
import { playFound, playMiss, playFanfare } from '@/lib/sounds';
import Gallery from '@/components/Gallery';

type Found = { id: string; description: string; bbox: { x: number; y: number; width: number; height: number }; centroid?: { x: number; y: number } | null; difficulty?: number };
type ImgLevel = { levelId: string; original: string; modified: string; width: number; height: number; total: number; isMock: boolean; theme?: string; revisedPrompt?: string };

/** Pipeline steps shown while generating — mapped from the server job stage strings. */
const STEPS = [
  { label: 'Preparing your image', icon: '📸' },
  { label: 'Finding the objects', icon: '✂️' },
  { label: 'Planning the differences', icon: '🧠' },
  { label: 'Creating the changes', icon: '🎨' },
  { label: 'Checking every difference', icon: '🔍' },
  { label: 'Level ready', icon: '🎉' },
];
/** VF_THEME_GENERATION prepends one step: the scene itself is created first. */
const SCENE_STEP = { label: 'Creating your scene', icon: '🌄' };
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
  const [levelId, setLevelId] = useState(''); const [img, setImg] = useState<ImgLevel | null>(null);
  const [total, setTotal] = useState(0); const [found, setFound] = useState<Found[]>([]); const [mistakes, setMistakes] = useState(0);
  const [hints, setHints] = useState(0); const [hintUsed, setHintUsed] = useState<Record<string, number>>({}); const [msg, setMsg] = useState('Create your level above, or pick one from the gallery below.'); const [start] = useState(Date.now());
  const [photo, setPhoto] = useState(''); const [photoName, setPhotoName] = useState(''); const [count, setCount] = useState(5); const [difficulty, setDifficulty] = useState('medium');
  const [busy, setBusy] = useState(false); const [dragOver, setDragOver] = useState(false); const [step, setStep] = useState(0); const [jobElapsed, setJobElapsed] = useState(0);
  const [theme, setTheme] = useState(''); const [themeUsed, setThemeUsed] = useState(false); const [previewImage, setPreviewImage] = useState('');
  /** Judge access code (public-demo credit protection): remembered locally so it
   *  isn't asked per level. Only GENERATING needs it — demo, gallery, clicks and
   *  hints always work without it. */
  const [accessCode, setAccessCode] = useState('');
  useEffect(() => { try { setAccessCode(localStorage.getItem('vf-access-code') ?? ''); } catch { /* private window */ } }, []);
  const fileRef = useRef<HTMLInputElement>(null);

  const resetGame = (t: number) => { setTotal(t); setFound([]); setMistakes(0); setHints(0); setHintUsed({}); };
  /** Load an EXISTING level (gallery / share link): stored images only, generates nothing. */
  /** Race against Spark: same /api/ai-inspect challenge as QC, on game levels —
   *  Spark's findings (descriptions, not defect types) draw in fuchsia on Modified. */
  const [raceMode, setRaceMode] = useState<'no-reference' | 'with-reference'>('no-reference');
  const [raceBusy, setRaceBusy] = useState(false);
  const [race, setRace] = useState<{ mode: string; isMock: boolean; latencySec: number; total: number; matchedCount: number; falsePositives: number; findings: { bbox_normalized: { x: number; y: number; width: number; height: number }; label: string; confidence: number; matched: boolean; differenceId?: string }[] } | null>(null);
  const [raceMsg, setRaceMsg] = useState(''); const [raceStart, setRaceStart] = useState<number | null>(null);
  const [raceHumanTime, setRaceHumanTime] = useState<number | null>(null);
  const startRace = async () => {
    if (!levelId || raceBusy || busy) return;
    resetGame(total); setRace(null); setRaceHumanTime(null); setRaceStart(Date.now()); setRaceBusy(true);
    setRaceMsg('🤖 Spark is inspecting the modified image… find them first!');
    const res = await fetch('/api/ai-inspect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ levelId, mode: raceMode }) }).catch(() => null);
    const data = await res?.json().catch(() => null);
    setRaceBusy(false);
    if (!res?.ok || !data?.findings) { setRaceMsg(`❌ ${data?.error ?? 'Spark could not run the race.'}`); return; }
    setRace(data); setRaceMsg(`🤖 Spark finished in ${data.latencySec}s — keep going!`);
  };
  const loadById = async (id: string) => {
    const res = await fetch(`/api/level?id=${encodeURIComponent(id)}`);
    if (!res.ok) { setMsg('❌ That level could not be loaded — create your own above or pick another from the gallery.'); return; }
    const lv = await res.json();
    if (lv.demo) { setMsg('❌ That level is no longer available — create your own above or pick one from the gallery.'); return; }
    setLevelId(lv.levelId); resetGame(lv.total); setRace(null); setRaceStart(null); setRaceHumanTime(null); setRaceMsg('');
    setImg(lv); setMsg('✅ Level loaded — find all differences!');
  };
  useEffect(() => {
    const shared = new URLSearchParams(location.search).get('level');
    if (shared) void loadById(shared);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onFile = (f: File | undefined | null) => {
    if (!f) return;
    if (!f.type.startsWith('image/')) { setMsg(`❌ “${f.name}” is not an image — drop a JPG, PNG or WebP photo.`); return; }
    const r = new FileReader(); r.onload = () => { setPhoto(String(r.result)); setPhotoName(f.name); setMsg(`📸 Photo ready: ${f.name} — pick differences & difficulty, then Generate.`); }; r.readAsDataURL(f);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    onFile(e.dataTransfer.files?.[0]);
  };

  /** Upload (or theme) -> POST /api/generate (async job) -> poll stage -> playable level. Without real generation enabled the server returns the demo level. */
  const generate = async () => {
    // A theme replaces the photo entirely: the scene itself gets generated (VF_THEME_GENERATION).
    const usingTheme = theme.trim().length > 0;
    const finalStep = STEPS.length + (usingTheme ? 1 : 0) - 1;
    // Clear the previous level immediately so only the processing animation is visible.
    setImg(null); setLevelId(''); resetGame(0); setRace(null); setRaceStart(null); setRaceHumanTime(null); setRaceMsg('');
    setBusy(true); setStep(0); setJobElapsed(0);
    setThemeUsed(usingTheme); setPreviewImage('');
    setMsg('Creating your level — this can take a couple of minutes.');
    const finish = () => { setBusy(false); };
    const res = await fetch('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(usingTheme ? { theme: theme.trim(), count, mode: 'game', difficulty, accessCode: accessCode || undefined } : { imageDataUrl: photo || undefined, count, mode: 'game', difficulty, accessCode: accessCode || undefined }) });
    const data = await res.json();
    if (res.status === 401) { finish(); setMsg('Generating new levels needs the access code provided in the hackathon submission. You can still play the levels in the gallery below.'); return; }
    if (!res.ok) { finish(); setMsg(`❌ ${data.error ?? 'generation failed'}`); return; }
    for (let i = 0; i < 600; i++) {
      const s = await (await fetch(`/api/generate?id=${data.jobId}`)).json();
      setJobElapsed(Number(s.elapsedSec ?? 0));
      if (s.previewImage) setPreviewImage(String(s.previewImage));
      setStep(prev => Math.max(prev, stageToStep(String(s.stage ?? ''), String(s.status ?? ''), usingTheme))); // monotonic: editing/verifying alternate per change
      if (s.status === 'failed') { finish(); setMsg(s.error === 'theme_rejected' ? '❌ Your theme was rejected by moderation — try a different theme.' : '❌ Something went wrong while creating your level. Please try again.'); return; }
      if (s.status === 'done' && s.level) {
        const lv = s.level;
        setStep(finalStep);
        setLevelId(lv.levelId); resetGame(lv.total); finish();
        if (lv.demo) { setMsg('⚠️ Real generation is off right now — please play one of the levels in the gallery below.'); }
        else { setImg(lv); setMsg('✅ Level ready — find all differences!'); }
        return;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    finish();
    setMsg('❌ This is taking too long — please try again with fewer differences.');
  };

  const validate = async (x: number, y: number) => {
    const res = await (await fetch('/api/validate-click', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ levelId, x, y, foundIds: found.map(f => f.id) }) })).json();
    if (res.hit) { setFound(f => [...f, res.difference]); playFound(); setMsg(`✅ ${res.difference.description}`); } else { setMistakes(m => m + 1); playMiss(); setMsg('❌ Not there — mistake!'); }
  };
  const clickImg = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!img || found.length >= total || mistakes >= 5) return;
    const r = e.currentTarget.getBoundingClientRect();
    void validate(((e.clientX - r.left) / r.width) * img.width, ((e.clientY - r.top) / r.height) * img.height);
  };

  /** Capability 2: server delivers the next progressive hint for the easiest pending
   *  difference (Spark wrote 3 per difference at generation time). Each hint costs
   *  score points, same as before — but now it's a real clue, not a fixed tip. */
  const requestHint = async () => {
    if (!levelId || done) return;
    const res = await (await fetch('/api/hint', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ levelId, foundIds: found.map(f => f.id), used: hintUsed }) })).json();
    if (res.exhausted) { setMsg('💡 No more hints for the differences that are left — you are on your own now!'); return; }
    if (res.error) { setMsg(`❌ ${res.error}`); return; }
    setHintUsed(u => ({ ...u, [res.differenceId]: (u[res.differenceId] ?? 0) + 1 }));
    setHints(h => h + 1);
    setMsg(`💡 ${res.provisional ? 'Quick hint' : 'Hint'} ${res.hintNumber}/${res.totalHints}: ${res.hint}`);
  };

  const done = total > 0 && found.length >= total; const elapsed = Math.round((Date.now() - start) / 1000);
  // Race against Spark: freeze the human time the moment the level is completed.
  useEffect(() => { if (done && raceStart !== null && raceHumanTime === null) setRaceHumanTime(Math.round((Date.now() - raceStart) / 1000)); }, [done, raceStart, raceHumanTime]);
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
  const ImgPanel = ({ src, alt, showAi = false }: { src: string; alt: string; showAi?: boolean }) => (
    <div className="relative w-full">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} onClick={clickImg} className="w-full rounded-xl cursor-crosshair" />
      {showAi && race?.findings.map((f, i) => (
        <div key={i} className={`absolute border-[3px] border-fuchsia-400 pointer-events-none ${f.matched ? '' : 'border-dashed opacity-80'}`} style={{ left: `${f.bbox_normalized.x * 100}%`, top: `${f.bbox_normalized.y * 100}%`, width: `${f.bbox_normalized.width * 100}%`, height: `${f.bbox_normalized.height * 100}%` }}>
          <span className="absolute left-0 -top-6 whitespace-nowrap bg-fuchsia-600 text-white text-[11px] font-bold px-1 rounded">🤖 {f.label}</span>
        </div>
      ))}
      {img && found.map(f => {
        // Circle centered on the MEASURED center of the change (centroid), not the bbox corner box.
        const cx = f.centroid?.x ?? (f.bbox.x + f.bbox.width / 2);
        const cy = f.centroid?.y ?? (f.bbox.y + f.bbox.height / 2);
        const d = Math.max(f.bbox.width, f.bbox.height) * 1.15;
        return (<div key={f.id} className="absolute border-[3px] border-green-500 rounded-full aspect-square pointer-events-none" style={{ left: `${(cx / img.width) * 100}%`, top: `${(cy / img.height) * 100}%`, width: `${(d / img.width) * 100}%`, transform: 'translate(-50%, -50%)' }} />);
      })}
    </div>);

  return (<main className="max-w-6xl mx-auto px-5 py-8">
    <h1 className="text-3xl font-black">🔎 Diferia — Play Your Photo</h1>
    <p className="opacity-75 mt-2">Turn any photo — or a scene you imagine — into a spot-the-difference game. Choose how many differences to hide, pick a difficulty, and play: click each difference in either image, but watch your mistakes!</p>

    <section className="mt-5 rounded-xl bg-white/5 border border-white/10 p-4">
      <h2 className="font-bold">✨ Create your level</h2>
      <div className="grid md:grid-cols-2 gap-4 mt-3 items-stretch">
      <div className="flex flex-col">
      <h3 className="font-bold text-sm">📸 Upload a photo</h3>
      {/* Drag & drop zone — also clickable to open the file picker. Accepts image files only. */}
      <div
        role="button" tabIndex={0} aria-label="Drop an image here or click to choose a photo"
        onClick={() => fileRef.current?.click()}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click(); } }}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragEnter={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={e => { e.preventDefault(); setDragOver(false); }}
        onDrop={onDrop}
        className={`mt-2 flex-1 rounded-xl border-2 border-dashed px-4 py-6 text-center cursor-pointer transition-all ${dragOver ? 'border-indigo-400 bg-indigo-500/20 scale-[1.01]' : 'border-white/25 bg-white/5 hover:border-indigo-400/70 hover:bg-white/10'}`}
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
      <p className="text-xs opacity-60 mt-2">JPG, PNG or WebP. Your photo is only used to build this level.</p>
      </div>
      <div className="flex flex-col">
      <h3 className="font-bold text-sm">🎨 Or describe a scene</h3>
      <textarea aria-label="Scene theme" maxLength={200} rows={5} value={theme} onChange={e => setTheme(e.target.value)} placeholder="an autumn garden with a cozy cabin" className="mt-2 flex-1 min-h-36 w-full bg-white/10 px-3 py-2 rounded-lg text-white placeholder:text-white/40 resize-none" />
      <p className="text-xs opacity-60 mt-2">We create the scene for you, then hide the differences in it. If you describe a scene, the photo is not used.</p>
      </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 mt-3 text-sm">
        <label>Differences <select aria-label="Number of differences" value={count} onChange={e => setCount(Number(e.target.value))} className="bg-white/10 px-2 py-2 rounded-lg text-white"><option value={3}>3</option><option value={5}>5</option><option value={7}>7</option></select></label>
        <label>Difficulty <select aria-label="Difficulty" value={difficulty} onChange={e => setDifficulty(e.target.value)} className="bg-white/10 px-2 py-2 rounded-lg text-white"><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></select></label>
        <button className="bg-indigo-500 px-4 py-2 rounded-lg font-bold disabled:opacity-50" disabled={busy} onClick={generate}>{busy ? '⏳ Generating…' : '✨ Generate level'}</button>
        <label>Judge access code <input type="password" aria-label="Judge access code" value={accessCode} onChange={e => { setAccessCode(e.target.value); try { localStorage.setItem('vf-access-code', e.target.value); } catch { /* private window */ } }} placeholder="for judges" className="bg-white/10 px-2 py-2 rounded-lg text-white w-36" /></label>
        {busy && <span className="opacity-80">{steps[step]?.icon} {steps[step]?.label} · {jobElapsed}s</span>}
      </div>
    </section>

    <div className="flex flex-wrap gap-3 my-5 text-sm"><span className="bg-white/10 px-3 py-1 rounded-full">Found {found.length}/{total}</span><span className="bg-white/10 px-3 py-1 rounded-full">Mistakes {mistakes}/5</span>
      <button className="bg-white/10 px-3 py-1 rounded-full" onClick={requestHint}>💡 Hint ({hints})</button>
      <button className="bg-fuchsia-600 px-3 py-1 rounded-full font-bold disabled:opacity-50" disabled={!levelId || raceBusy || busy} onClick={startRace}>🤖 Race against Spark</button>
      <label className="bg-white/10 px-2 py-1 rounded-full">Spark sees <select aria-label="Spark race mode" value={raceMode} onChange={e => setRaceMode(e.target.value as 'no-reference' | 'with-reference')} className="bg-transparent text-white"><option value="no-reference">modified only</option><option value="with-reference">both images</option></select></label>
      {typeof window !== 'undefined' && levelId && <button className="bg-white/10 px-3 py-1 rounded-full" onClick={() => navigator.clipboard?.writeText(`${location.origin}/play?level=${levelId}`)}>🔗 Share link</button>}</div>
    <p aria-live="polite" className="font-semibold">{done ? `🎉 Finished! Score ${scoreGame(found.length, total, mistakes, hints, elapsed, found.map(f => f.difficulty ?? 3))} · ${elapsed}s` : msg}</p>
    {img?.theme && <p className="text-sm opacity-80 mt-1">🎨 Scene: “{img.revisedPrompt || img.theme}”</p>}
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
        <p className="text-xs opacity-60 mt-4">This can take a few minutes. Keep this tab open.</p>
      </section>
    ) : img ? (
      <div className="grid md:grid-cols-2 gap-5 mt-4"><div><h2 className="font-bold mb-2">Original — click differences</h2><ImgPanel src={img.original} alt="Original — click differences" /></div>
        <div><h2 className="font-bold mb-2">Modified — click differences</h2><ImgPanel src={img.modified} alt="Modified — click differences" showAi /></div></div>
    ) : (
      <div className="mt-4 rounded-xl border-2 border-dashed border-white/15 bg-white/5 px-6 py-14 text-center">
        <p className="text-4xl">🖼️</p>
        <p className="font-bold mt-3">Your level will appear here</p>
        <p className="text-sm opacity-70 mt-1">Generate one from your photo or a scene above — or pick a ready-made level from the gallery below. No code needed to play those.</p>
      </div>
    )}
    {(raceBusy || race) && (
      <div className="mt-4 rounded-xl bg-fuchsia-500/10 border border-fuchsia-400/40 px-4 py-3 text-sm">
        <p className="font-bold">🤖 Race against Spark{race ? ` · ${race.mode === 'with-reference' ? 'with reference' : 'no reference'}` : ''}</p>
        {raceMsg && <p className="mt-1 opacity-90">{raceMsg}</p>}
        {race && <p className="mt-1">You: {found.length}/{total} found · {mistakes} mistakes · {raceHumanTime !== null ? `${raceHumanTime}s` : 'still playing…'} — Spark: {race.matchedCount}/{race.total} found · {race.falsePositives} false positives · {race.latencySec}s{race.isMock ? ' (MOCK provider — no real inspection)' : ''}. Fuchsia boxes on the modified image are Spark’s.</p>}
        {race && done && raceHumanTime !== null && <p className="font-bold mt-1">🏁 {challengeVerdict({ foundIds: found.map(f => f.id), falsePositives: mistakes, timeSec: raceHumanTime }, { foundIds: race.findings.filter(f => f.matched && f.differenceId).map(f => f.differenceId!), falsePositives: race.falsePositives, timeSec: race.latencySec }, 'differences', 'Spark')}</p>}
      </div>
    )}
    <ul className="mt-4 text-sm">{found.map(f => <li key={f.id}>✅ {f.description}</li>)}</ul>
    {mistakes >= 5 && !done && <p className="text-red-300 font-bold mt-3">Out of mistakes — generate or load a new level to try again.</p>}
    <Gallery onPlay={id => { if (busy) { setMsg('⏳ Please wait for the current level to finish generating…'); return; } void loadById(id); window.scrollTo({ top: 0, behavior: 'smooth' }); }} />
  </main>);
}
