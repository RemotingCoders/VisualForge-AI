'use client';
import { useEffect, useRef, useState } from 'react';
import { accuracy } from '@/lib/engine/geometry';
import { challengeVerdict } from '@/lib/aiInspect';
import confetti from 'canvas-confetti';
import { playFound, playMiss, playFanfare } from '@/lib/sounds';

type RealLevel = { levelId: string; original: string; modified: string; width: number; height: number; total: number; isMock: boolean; notice?: string; theme?: string; revisedPrompt?: string };

/** Pipeline steps shown while generating (same processing animation as /play) —
 *  mapped from the server job stage strings, QC-flavored labels. */
const STEPS = [
  { label: 'Preparing your photo', icon: '📸' },
  { label: 'Finding the parts', icon: '✂️' },
  { label: 'Planning the defects', icon: '🧠' },
  { label: 'Creating the defects', icon: '🎨' },
  { label: 'Checking every defect', icon: '🔍' },
  { label: 'Classifying defects', icon: '🏷️' },
  { label: 'Level ready', icon: '🎉' },
];
/** Describe-a-part prepends one step: the part photo itself is created first. */
const PART_STEP = { label: 'Creating your part photo', icon: '🏭' };
function stageToStep(stage: string, status: string, withPart = false): number {
  if (status === 'done') return withPart ? STEPS.length : STEPS.length - 1;
  const s = stage.toLowerCase();
  if (withPart && (s.includes('generating scene') || s.includes('moderating theme'))) return 0;
  let base: number;
  if (s.includes('classif')) base = 5;
  else if (s.includes('verif') || s.includes('measur') || s.includes('review') || s.includes('compos')) base = 4;
  else if (s.includes('edit') || s.includes('one-pass') || s.includes('extract')) base = 3;
  else if (s.includes('plan')) base = 2;
  else if (s.includes('segment')) base = 1;
  else base = 0; // queued / creating / normalizing / moderating
  return withPart ? base + 1 : base;
}
type FoundDiff = { id: string; description: string; bbox: { x: number; y: number; width: number; height: number }; centroid: { x: number; y: number } | null };
type RevealDiff = { id: string; type: string; plannedType: string; label: string; severity: number | null; confidence: number | null; needsReview: boolean; detectability: number | null; aiChallenges: number; aiHits: number; aiFoundModes: string[]; bbox: { x: number; y: number; width: number; height: number }; centroid: { x: number; y: number } | null };
type AiResult = { mode: string; isMock: boolean; latencySec: number; total: number; matchedCount: number; falsePositives: number; findings: { bbox_normalized: { x: number; y: number; width: number; height: number }; label: string; confidence: number; matched: boolean; differenceId?: string; truthLabel?: string }[] };
const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export default function QC() {
  const [photo, setPhoto] = useState(''); const [photoName, setPhotoName] = useState(''); const [count, setCount] = useState(2); const [job, setJob] = useState(''); const [real, setReal] = useState<RealLevel | null>(null);
  const [dragOver, setDragOver] = useState(false); const [fileMsg, setFileMsg] = useState(''); const fileRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState(0); const [jobElapsed, setJobElapsed] = useState(0);
  /** Describe-a-part (same theme path as Play, QC prompt): no photo needed — the
   *  part photo itself is generated, then defects are added to it. */
  const [partText, setPartText] = useState(''); const [partUsed, setPartUsed] = useState(false); const [previewImage, setPreviewImage] = useState('');
  const steps = partUsed ? [PART_STEP, ...STEPS] : STEPS;
  // --- Real-level trainer state (separate from the MOCK scene trainer below) ---
  const [realFound, setRealFound] = useState<FoundDiff[]>([]); const [realFalsePos, setRealFalsePos] = useState(0);
  const [realMisses, setRealMisses] = useState<{ x: number; y: number }[]>([]); const [realRevealed, setRealRevealed] = useState(false);
  const [revealDiffs, setRevealDiffs] = useState<RevealDiff[]>([]); const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0); const [sessionMsg, setSessionMsg] = useState('');
  /** Frozen inspection time once every defect is found (fanfare moment) — the
   *  clock stops there even though Reveal may happen later. */
  const [finishedElapsed, setFinishedElapsed] = useState<number | null>(null);
  const imgRef = useRef<HTMLImageElement>(null); const sessionPosted = useRef(false);
  const defectTopRef = useRef<HTMLHeadingElement>(null);
  /** Challenge the AI inspector: Spark races the trainee on this same level. The
   *  button restarts the human clock and fires /api/ai-inspect in parallel; Spark's
   *  boxes draw in fuchsia when they land, and the verdict compares coverage, then time. */
  const [aiMode, setAiMode] = useState<'no-reference' | 'with-reference'>('no-reference');
  const [aiBusy, setAiBusy] = useState(false); const [aiResult, setAiResult] = useState<AiResult | null>(null);
  const [aiMsg, setAiMsg] = useState(''); const [challengeActive, setChallengeActive] = useState(false);
  const [humanFinal, setHumanFinal] = useState<{ foundIds: string[]; falsePositives: number; timeSec: number } | null>(null);
  const startChallenge = async () => {
    if (!real || aiBusy) return;
    setRealFound([]); setRealFalsePos(0); setRealMisses([]); setRealRevealed(false); setRevealDiffs([]);
    setSessionMsg(''); setFinishedElapsed(null); setStartedAt(Date.now()); setElapsed(0);
    setChallengeActive(true); setHumanFinal(null); setAiResult(null); setAiBusy(true);
    setAiMsg('🤖 The AI inspector is looking at the defective unit… your clock is running — find them first!');
    const res = await fetch('/api/ai-inspect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ levelId: real.levelId, mode: aiMode }) }).catch(() => null);
    const data = await res?.json().catch(() => null);
    setAiBusy(false);
    if (!res?.ok || !data?.findings) { setAiMsg(`❌ ${data?.error ?? 'The AI inspector could not run.'}`); return; }
    setAiResult(data); setAiMsg('');
  };
  /** Example QC levels from the gallery: already generated, inspectable by anyone
   *  without the access code (loading generates nothing). */
  const [qcGallery, setQcGallery] = useState<{ levelId: string; original: string; total: number }[]>([]);
  const [qcGalleryLoading, setQcGalleryLoading] = useState(true);
  useEffect(() => {
    void fetch('/api/gallery?mode=qc').then(r => r.json()).then(d => setQcGallery((d.levels ?? []).filter((l: { mode?: string }) => l.mode === 'qc'))).catch(() => { /* gallery is optional */ }).finally(() => setQcGalleryLoading(false));
  }, []);
  const loadQcLevel = async (id: string) => {
    const res = await fetch(`/api/level?id=${encodeURIComponent(id)}`);
    if (!res.ok) { alert('That QC level could not be loaded.'); return; }
    const lv = await res.json();
    if (lv.demo || lv.mode !== 'qc') { alert('That is not a QC level.'); return; }
    setReal(lv); // the [real] effect below scrolls the "Find the defects" heading into view
  };
  /** Judge access code — same shared field as /play (remembered in localStorage). */
  const [accessCode, setAccessCode] = useState('');
  useEffect(() => { try { setAccessCode(localStorage.getItem('vf-access-code') ?? ''); } catch { /* private window */ } }, []);
  // A fresh real level resets the trainer, starts the clock and folds the MOCK demo away.
  useEffect(() => {
    if (!real) return;
    setRealFound([]); setRealFalsePos(0); setRealMisses([]); setRealRevealed(false); setRevealDiffs([]);
    setSessionMsg(''); sessionPosted.current = false; setStartedAt(Date.now()); setElapsed(0); setFinishedElapsed(null);
    setAiResult(null); setAiBusy(false); setAiMsg(''); setChallengeActive(false); setHumanFinal(null);
  }, [real]);
  // When a level lands in the trainer (generated or "Inspect this unit"), bring
  // the "Find the defects" heading to the top of the viewport — NOT the page top.
  useEffect(() => {
    if (real) defectTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [real]);
  // Inspection timer: ticks while a real level is loaded, not yet completed or revealed.
  useEffect(() => {
    if (!startedAt || realRevealed || finishedElapsed !== null) return;
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 500);
    return () => clearInterval(t);
  }, [startedAt, realRevealed, finishedElapsed]);
  /** Real trainer: clicks on the defective unit are validated by the server
   *  (/api/validate-click) — the defect annotations never ship to the client. */
  const clickReal = async (e: React.MouseEvent) => {
    if (!real || realRevealed || !imgRef.current || realFound.length >= real.total) return; // completed: extra clicks stop counting
    const r = imgRef.current.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * real.width, y = ((e.clientY - r.top) / r.height) * real.height;
    const res = await fetch('/api/validate-click', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ levelId: real.levelId, x, y, foundIds: realFound.map(f => f.id) }) });
    const data = await res.json().catch(() => null);
    if (data?.hit && data.difference) { playFound(); setRealFound(f => [...f, data.difference]); }
    else { playMiss(); setRealFalsePos(n => n + 1); setRealMisses(m => [...m, { x: (x / real.width) * 100, y: (y / real.height) * 100 }]); }
  };
  /** Records the training session exactly once per level (server computes accuracy). */
  const saveSession = async (correct: number, missed: number, falsePositives: number, durationSec: number) => {
    if (!real || sessionPosted.current) return;
    sessionPosted.current = true;
    const s = await fetch('/api/qc-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ levelId: real.levelId, correct, missed, falsePositives, durationSec }) }).then(r => r.json()).catch(() => null);
    setSessionMsg(s?.ok ? `Session saved · accuracy ${Math.round((s.session.accuracy ?? 0) * 100)}% · ${durationSec}s` : 'Session could not be saved.');
  };
  /** Every defect found = inspection complete (same celebration as Play): the clock
   *  freezes, the fanfare + confetti fire, and the session is recorded right there —
   *  Reveal afterwards only shows the boxes/types, it does not re-time the session. */
  const realDone = !!real && real.total > 0 && realFound.length >= real.total;
  const celebrated = useRef(false);
  useEffect(() => { if (!realDone) celebrated.current = false; }, [realDone]);
  useEffect(() => {
    if (!realDone || celebrated.current || !real) return;
    celebrated.current = true;
    const durationSec = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : elapsed;
    setFinishedElapsed(durationSec); setElapsed(durationSec);
    if (challengeActive) setHumanFinal(h => h ?? { foundIds: realFound.map(f => f.id), falsePositives: realFalsePos, timeSec: durationSec });
    playFanfare();
    const colors = ['#6366f1', '#22c55e', '#fbbf24', '#06b6d4', '#f472b6'];
    confetti({ particleCount: 130, spread: 80, origin: { y: 0.6 }, colors });
    const end = Date.now() + 1100; // side cannons, ~1s of party
    (function frame() {
      confetti({ particleCount: 4, angle: 60, spread: 60, startVelocity: 55, origin: { x: 0, y: 0.7 }, colors });
      confetti({ particleCount: 4, angle: 120, spread: 60, startVelocity: 55, origin: { x: 1, y: 0.7 }, colors });
      if (Date.now() < end) requestAnimationFrame(frame);
    })();
    void saveSession(realFound.length, 0, realFalsePos, durationSec);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [realDone]);
  /** Reveal & score: fetch every defect box + classified type (QC-only endpoint),
   *  stop the clock and record the training session exactly once. */
  const revealReal = async () => {
    if (!real || realRevealed) return;
    const res = await fetch(`/api/qc-reveal?levelId=${real.levelId}`);
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.differences) { alert(data?.error ?? 'Could not reveal this level.'); return; }
    const durationSec = finishedElapsed ?? (startedAt ? Math.floor((Date.now() - startedAt) / 1000) : elapsed);
    setElapsed(durationSec); setRevealDiffs(data.differences); setRealRevealed(true);
    if (challengeActive) setHumanFinal(h => h ?? { foundIds: realFound.map(f => f.id), falsePositives: realFalsePos, timeSec: durationSec });
    // If the trainee already found everything, the session was saved at the fanfare
    // with the frozen time; saveSession's once-guard makes this a no-op then.
    await saveSession(realFound.length, Math.max(0, real.total - realFound.length), realFalsePos, durationSec);
  };
  const onFile = (f: File | undefined | null) => {
    if (!f) return;
    if (!f.type.startsWith('image/')) { setFileMsg(`❌ "${f.name}" is not an image — drop a JPG, PNG or WebP photo.`); return; }
    const r = new FileReader(); r.onload = () => { setPhoto(String(r.result)); setPhotoName(f.name); setFileMsg(''); }; r.readAsDataURL(f);
  };
  const onDrop = (e: React.DragEvent) => { e.preventDefault(); setDragOver(false); onFile(e.dataTransfer.files?.[0]); };
  /** Real QC path: photo -> async generation job (mode 'qc') -> level -> trainer + COCO/YOLO export of that level. */
  const generateReal = async () => {
    // A part description replaces the photo entirely: the part photo gets generated first.
    const usingPart = partText.trim().length > 0;
    setJob('creating job…'); setStep(0); setJobElapsed(0); setPartUsed(usingPart); setPreviewImage('');
    const res = await fetch('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(usingPart ? { theme: partText.trim(), count, mode: 'qc', accessCode: accessCode || undefined } : { imageDataUrl: photo || undefined, count, mode: 'qc', accessCode: accessCode || undefined }) });
    const data = await res.json();
    if (res.status === 401) { setJob(''); alert('Generating new levels needs the access code provided in the hackathon submission. You can still inspect the example QC levels in the gallery below.'); return; }
    if (!res.ok) { setJob(''); alert(data.error ?? 'generation failed'); return; }
    if (data.isMock) { setJob(''); setReal(null); alert('Real QC generation is off right now — you can still inspect the example QC levels in the gallery below.'); return; }
    for (let i = 0; i < 600; i++) {
      const s = await (await fetch(`/api/generate?id=${data.jobId}`)).json();
      setJob(`job ${s.status}${s.stage ? ` · ${s.stage}` : ''} · ${s.elapsedSec ?? '?'}s elapsed (each AI call takes 3-60s)`);
      setJobElapsed(Number(s.elapsedSec ?? 0));
      if (s.previewImage) setPreviewImage(String(s.previewImage));
      setStep(prev => Math.max(prev, stageToStep(String(s.stage ?? ''), String(s.status ?? ''), usingPart))); // monotonic: editing/verifying alternate per defect
      if (s.status === 'failed') { setJob(''); alert(s.error === 'theme_rejected' ? 'Your part description was rejected by moderation — try describing a different part.' : `Generation failed at stage "${s.stage}": ${s.error ?? 'unknown error'}`); return; }
      if (s.status === 'done' && s.level && !s.level.demo) { setStep(stageToStep('', 'done', usingPart)); setReal(s.level); setJob(''); return; }
      await new Promise(r => setTimeout(r, 1000));
    }
    setJob(''); alert('Generation timed out after 10 minutes — check Meta dashboard usage before retrying.');
  };
  const pct = (v: number, total: number) => `${(v / total) * 100}%`;
  return (<main className="max-w-5xl mx-auto px-5 py-8 font-mono">
    <h1 className="text-3xl font-black">🏭 QC Inspection Trainer</h1><p className="opacity-70 mt-2 text-sm">Industrial mode · synthetic defects — validate before industrial use · generate a real defect level from your own photo — or just describe a part and we create its photo — inspect the defective unit, then reveal &amp; score. Or start right away with a ready-made example from the gallery below — no code needed.</p>
    <section className="mt-5 rounded bg-white/5 border border-white/10 p-4 text-sm">
      <h2 className="font-bold">📸 Real QC level — from a photo or a description</h2>
      <div className="grid md:grid-cols-2 gap-4">
      <div>
      <h3 className="font-bold text-sm mt-3">📷 Upload a product photo</h3>
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
      </div>
      <div>
        <h3 className="font-bold text-sm mt-3">✍️ Or describe a part</h3>
        <textarea aria-label="Describe a part" maxLength={200} rows={5} value={partText} onChange={e => setPartText(e.target.value)} placeholder="a steel flange with six bolt holes on a workbench" className="mt-2 w-full min-h-36 bg-white/10 px-3 py-2 rounded-lg text-white placeholder:text-white/40 resize-none" />
        <p className="text-xs opacity-60 mt-2">No photo handy? We create the part photo for you, then add the verified defects to it. If you describe a part, the uploaded photo is not used.</p>
      </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 mt-3">
        <label>Defects <select aria-label="Number of defects" value={count} onChange={e => setCount(Number(e.target.value))} className="bg-white/10 px-2 py-2 rounded text-white">{[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n}</option>)}</select></label>
        <button className="bg-indigo-500 font-bold px-4 py-2 rounded disabled:opacity-50" disabled={!!job || (!photo && !partText.trim())} onClick={generateReal}>{job ? '⏳ Generating…' : '⚙️ Generate QC level'}</button>
        <label>Judge access code <input type="password" aria-label="Judge access code" value={accessCode} onChange={e => { setAccessCode(e.target.value); try { localStorage.setItem('vf-access-code', e.target.value); } catch { /* private window */ } }} placeholder="for judges" className="bg-white/10 px-2 py-2 rounded text-white w-36" /></label>
        {job && <span className="opacity-80">{job}</span>}
      </div>
      {job ? (
      <section aria-label="Generating QC level" className="mt-4 rounded-xl bg-white/5 border border-indigo-400/30 p-8 text-center overflow-hidden">
        {/* Big processing wheel: two counter-rotating rings + pulsing core (same as /play) */}
        <div className="relative w-44 h-44 mx-auto" aria-hidden="true">
          <div className="absolute inset-0 rounded-full border-8 border-white/10 border-t-indigo-400 animate-spin" />
          <div className="absolute inset-4 rounded-full border-4 border-dashed border-cyan-400/60 animate-[spin_7s_linear_infinite_reverse]" />
          <div className="absolute inset-9 rounded-full border-4 border-white/10 border-b-fuchsia-400 animate-[spin_3s_linear_infinite]" />
          <div className="absolute inset-0 flex items-center justify-center text-5xl animate-pulse">{steps[step]?.icon}</div>
        </div>
        <h2 className="text-2xl font-black mt-6">Creating your QC level…</h2>
        <p className="opacity-80 mt-1">{steps[step]?.label} · {jobElapsed}s elapsed</p>
        {(previewImage || photo) && (
          <figure className="mt-6 max-w-md mx-auto">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={previewImage || photo} alt="Your product photo being inspected" className="w-full rounded-xl border border-white/20" />
            <figcaption className="text-xs opacity-70 mt-2">{previewImage ? 'Your part photo is ready — adding the defects…' : 'Your unit is being processed — the defective unit will appear here…'}</figcaption>
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
      ) : real && (<div className="mt-4">
        <h2 ref={defectTopRef} className="text-2xl md:text-3xl font-black mb-3">🔍 Find the defects!</h2>
        {real.notice && <p className="rounded bg-amber-500/20 border border-amber-400/40 text-amber-200 px-3 py-2 text-xs mb-3">⚠️ {real.notice} — this level ships with the defects that could be verified; inspect what is actually there.</p>}
        {real.theme && <p className="text-xs opacity-80 mb-3">🏭 Part created from your description: “{real.revisedPrompt || real.theme}”</p>}
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
              {!realRevealed && aiResult?.findings.map((f, i) => {
                // Same scaling as Play's circles: diameter = max(w, h) × 1.15 around the
                // box center — Spark's raw boxes sit tight on the defect and read tiny.
                const d = Math.max(f.bbox_normalized.width, f.bbox_normalized.height) * 1.15;
                const cx = f.bbox_normalized.x + f.bbox_normalized.width / 2;
                const cy = f.bbox_normalized.y + f.bbox_normalized.height / 2;
                return (
                <div key={i} className={`absolute border-[3px] border-fuchsia-400 rounded-full aspect-square pointer-events-none ${f.matched ? '' : 'border-dashed opacity-80'}`} style={{ left: `${cx * 100}%`, top: `${cy * 100}%`, width: `${d * 100}%`, transform: 'translate(-50%, -50%)' }}>
                  <span className="absolute left-1/2 -translate-x-1/2 -top-6 whitespace-nowrap bg-fuchsia-600 text-white text-[11px] font-bold px-1 rounded">🤖 {f.label}{f.matched ? '' : ' ?'}</span>
                </div>);
              })}
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
          <span className="bg-white/10 px-3 py-1 rounded">⏱ {fmtTime(finishedElapsed ?? elapsed)}</span>
          {realDone && !realRevealed && <span className="bg-emerald-500/25 border border-emerald-400/40 px-3 py-1 rounded">🎉 All {real.total} defects found in {fmtTime(finishedElapsed ?? elapsed)}!</span>}
          <button className="bg-amber-500 text-black font-bold px-3 py-1 rounded disabled:opacity-50" disabled={realRevealed} onClick={revealReal}>Reveal &amp; score</button>
          <button className="bg-fuchsia-600 font-bold px-3 py-1 rounded disabled:opacity-50" disabled={aiBusy} onClick={startChallenge}>🤖 Challenge the AI inspector</button>
          <label className="bg-white/10 px-2 py-1 rounded">AI sees <select aria-label="AI inspector mode" value={aiMode} onChange={e => setAiMode(e.target.value as 'no-reference' | 'with-reference')} className="bg-transparent text-white"><option value="no-reference">defective unit only</option><option value="with-reference">unit + reference</option></select></label>
          {sessionMsg && <span className="opacity-80">{sessionMsg}</span>}
        </div>
        {(challengeActive || aiBusy || aiResult) && (<div className="mt-3 rounded bg-fuchsia-500/10 border border-fuchsia-400/40 px-3 py-2 text-xs">
          <p className="font-bold text-sm">🤖 Challenge the AI inspector{aiResult ? ` · ${aiResult.mode === 'with-reference' ? 'with reference' : 'no reference'}` : ''}</p>
          {aiBusy && <p className="mt-1">{aiMsg}</p>}
          {aiMsg && !aiBusy && <p className="mt-1">{aiMsg}</p>}
          {aiResult && (<p className="mt-1">You: {humanFinal ? humanFinal.foundIds.length : realFound.length}/{real.total} found · {humanFinal ? humanFinal.falsePositives : realFalsePos} false positives · {humanFinal ? `${humanFinal.timeSec}s` : 'still inspecting…'} — AI inspector: {aiResult.matchedCount}/{aiResult.total} found · {aiResult.falsePositives} false positives · {aiResult.latencySec}s{aiResult.isMock ? ' (MOCK provider — no real inspection)' : ''}. Fuchsia boxes are the AI’s.</p>)}
          {aiResult && humanFinal && (<p className="font-bold text-sm mt-1">🏁 {challengeVerdict(humanFinal, { foundIds: aiResult.findings.filter(f => f.matched && f.differenceId).map(f => f.differenceId!), falsePositives: aiResult.falsePositives, timeSec: aiResult.latencySec }, 'defects')}</p>)}
          {aiResult && !humanFinal && <p className="mt-1 opacity-80">The AI is done — finish your inspection (find them all, or Reveal &amp; score) to see who won.</p>}
        </div>)}
        {realRevealed && (<div className="mt-3 text-xs">
          <p>Missed: {Math.max(0, real.total - realFound.length)} of {real.total} defects.</p>
          <ul className="mt-2 space-y-1">
            {revealDiffs.map(d => (<li key={d.id} className="bg-white/5 rounded px-2 py-1">
              {realFound.some(f => f.id === d.id) ? '✅' : '❌'} <b>{d.type}</b> — {d.label}
              {d.severity ? ` · severity ${d.severity}/5` : ''}{d.confidence !== null ? ` · confidence ${Math.round(d.confidence * 100)}%` : ''}
              {d.type !== d.plannedType ? ` · planned as “${d.plannedType}”` : ''}{d.needsReview ? ' · ⚠️ needs review (low confidence)' : ''}
              {d.aiChallenges > 0 ? ` · 🤖 AI detectability ${Math.round((d.detectability ?? 0) * 100)}% (${d.aiHits}/${d.aiChallenges} challenges${d.aiFoundModes.length ? `, found in ${d.aiFoundModes.join(' + ')}` : ''})` : ''}
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
    {(qcGalleryLoading || qcGallery.length > 0) && (
      <section className="mt-8 rounded bg-white/5 border border-white/10 p-4 text-sm">
        <h2 className="font-bold">🖼️ Example QC levels — no code needed</h2>
        {qcGalleryLoading ? (
          <div className="flex items-center gap-3 mt-4 text-sm opacity-80" role="status" aria-label="Loading gallery">
            <span className="inline-block w-6 h-6 shrink-0 rounded-full border-[3px] border-white/20 border-t-indigo-400 animate-spin" aria-hidden="true" />
            <span>Loading gallery…</span>
          </div>
        ) : (<>
        <p className="opacity-70 text-xs mt-1">Already generated and stored. Inspect one right away: find the defects, reveal &amp; score, export the dataset. Loading an example generates nothing.</p>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mt-4">
          {qcGallery.map(l => (
            <div key={l.levelId} className="rounded bg-white/5 border border-white/10 overflow-hidden">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={l.original} alt="QC example part" className="w-full h-28 object-cover bg-slate-900" />
              <div className="p-3">
                <p className="text-xs opacity-80">{l.total} verified defects</p>
                <button className="bg-indigo-500 font-bold px-3 py-1 rounded mt-2 w-full" onClick={() => void loadQcLevel(l.levelId)}>🔍 Inspect this unit</button>
              </div>
            </div>
          ))}
        </div>
        </>)}
      </section>
    )}
  </main>);
}
