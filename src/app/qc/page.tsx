'use client';
import { useMemo, useRef, useState } from 'react';
import { generateDemoScene, renderShapes } from '@/lib/demoScene';
import { clickHits, accuracy } from '@/lib/engine/geometry';
import { toCOCO, toYOLO } from '@/lib/coco';

const DEFECTS = ['scratch', 'crack', 'dent', 'missing component', 'corrosion', 'misalignment', 'wrong color', 'foreign object'];
type RealLevel = { levelId: string; original: string; modified: string; width: number; height: number; total: number; isMock: boolean };
export default function QC() {
  const scene = useMemo(() => generateDemoScene(42), []); const [found, setFound] = useState<string[]>([]); const [falsePos, setFalsePos] = useState(0); const [revealed, setRevealed] = useState(false); const ref = useRef<SVGSVGElement>(null);
  const [photo, setPhoto] = useState(''); const [count, setCount] = useState(3); const [job, setJob] = useState(''); const [real, setReal] = useState<RealLevel | null>(null);
  const click = (e: React.MouseEvent) => { if (!ref.current || revealed) return; const r = ref.current.getBoundingClientRect(); const x = ((e.clientX - r.left) / r.width) * 400, y = ((e.clientY - r.top) / r.height) * 300;
    const hit = scene.differences.find(d => !found.includes(d.id) && clickHits({ x, y }, d.bbox, 14)); hit ? setFound(f => [...f, hit.id]) : setFalsePos(n => n + 1); };
  const download = (name: string, text: string) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = name; a.click(); };
  const coco = () => download('visualforge-dataset.json', JSON.stringify(toCOCO([{ id: 1, file_name: 'product-modified.svg', width: 400, height: 300 }], scene.differences.map((d, i) => ({ imageId: 1, categoryId: (i % DEFECTS.length) + 1, bbox: d.bbox })), DEFECTS.map((n, i) => ({ id: i + 1, name: n }))), null, 2));
  const onFile = (f: File | undefined) => { if (!f) return; const r = new FileReader(); r.onload = () => setPhoto(String(r.result)); r.readAsDataURL(f); };
  /** Real QC path: photo -> async generation job (mode 'qc') -> level -> COCO/YOLO export of that level. */
  const generateReal = async () => {
    setJob('creating job…');
    const res = await fetch('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ imageDataUrl: photo || undefined, count, mode: 'qc' }) });
    const data = await res.json();
    if (!res.ok) { setJob(''); alert(data.error ?? 'generation failed'); return; }
    if (data.isMock) { setJob(''); setReal(null); alert('Offline MOCK provider: real QC generation is off (needs AI_PROVIDER=meta + kill switch). The MOCK trainer scene below remains available.'); return; }
    for (let i = 0; i < 600; i++) {
      const s = await (await fetch(`/api/generate?id=${data.jobId}`)).json();
      setJob(`job ${s.status}${s.stage ? ` · ${s.stage}` : ''} · ${s.elapsedSec ?? '?'}s elapsed (each AI call takes 3-60s)`);
      if (s.status === 'failed') { setJob(''); alert(`Generation failed at stage "${s.stage}": ${s.error ?? 'unknown error'}`); return; }
      if (s.status === 'done' && s.level && !s.level.demo) { setReal(s.level); setJob(''); return; }
      await new Promise(r => setTimeout(r, 1000));
    }
    setJob(''); alert('Generation timed out after 10 minutes — check Meta dashboard usage before retrying.');
  };
  return (<main className="max-w-5xl mx-auto px-5 py-8 font-mono">
    <h1 className="text-3xl font-black">🏭 QC Inspection Trainer</h1><p className="opacity-70 mt-2 text-sm">Industrial mode · synthetic defects — validate before industrial use · trainer scene below is MOCK; generate a real defect level from your own photo here:</p>
    <section className="mt-5 rounded bg-white/5 border border-white/10 p-4 text-sm">
      <h2 className="font-bold">📸 Real QC level from a photo</h2>
      <div className="flex flex-wrap items-center gap-3 mt-3">
        <input type="file" accept="image/*" aria-label="Upload a product photo" onChange={e => onFile(e.target.files?.[0])} className="bg-white/10 px-3 py-2 rounded" />
        <label>Defects <select aria-label="Number of defects" value={count} onChange={e => setCount(Number(e.target.value))} className="bg-white/10 px-2 py-2 rounded text-white"><option value={3}>3</option><option value={5}>5</option><option value={7}>7</option></select></label>
        <button className="bg-indigo-500 font-bold px-4 py-2 rounded disabled:opacity-50" disabled={!!job || !photo} onClick={generateReal}>{job ? '⏳ Generating…' : '⚙️ Generate QC level'}</button>
        {job && <span className="opacity-80">{job}</span>}
      </div>
      {real && (<div className="mt-4">
        <div className="grid md:grid-cols-2 gap-5">
          <div><h3 className="font-bold mb-2">Reference (known-good)</h3>{/* eslint-disable-next-line @next/next/no-img-element */}<img src={real.original} alt="Original product" className="w-full rounded bg-slate-900" /></div>
          <div><h3 className="font-bold mb-2">Defective unit ({real.total} verified defects)</h3>{/* eslint-disable-next-line @next/next/no-img-element */}<img src={real.modified} alt="Unit with synthetic defects" className="w-full rounded bg-slate-900" /></div>
        </div>
        <div className="flex flex-wrap gap-3 mt-4">
          <a className="bg-indigo-500 font-bold px-3 py-1 rounded" href={`/api/qc-export?levelId=${real.levelId}&format=coco`} download>⬇ Export this level — COCO JSON</a>
          <a className="bg-white/15 px-3 py-1 rounded" href={`/api/qc-export?levelId=${real.levelId}&format=yolo`} download>⬇ Export this level — YOLO txt</a>
        </div>
        <p className="opacity-70 mt-2 text-xs">Exports include ONLY verified defects, with the measured defect bbox (from the pixel-diff mask — not the edit crop). Synthetic data: validate before industrial use.</p>
      </div>)}
    </section>
    <div className="grid md:grid-cols-2 gap-5 mt-6">
      <div><h2 className="font-bold mb-2">Reference (known-good)</h2><svg viewBox="0 0 400 300" className="w-full rounded bg-slate-900" dangerouslySetInnerHTML={{ __html: renderShapes(scene.original) }} /></div>
      <div><h2 className="font-bold mb-2">Inspect this unit — click defects</h2><svg ref={ref} onClick={click} viewBox="0 0 400 300" className="w-full rounded bg-slate-900 cursor-crosshair" dangerouslySetInnerHTML={{ __html: renderShapes(scene.modified) + (revealed ? scene.differences.map(d => `<rect x="${d.bbox.x}" y="${d.bbox.y}" width="${d.bbox.width}" height="${d.bbox.height}" fill="none" stroke="#ef4444" stroke-width="3"/>`).join('') : '') }} /></div>
    </div>
    <div className="flex flex-wrap gap-3 mt-5 text-sm"><span className="bg-white/10 px-3 py-1 rounded">Correct {found.length}</span><span className="bg-white/10 px-3 py-1 rounded">False positives {falsePos}</span><span className="bg-white/10 px-3 py-1 rounded">Accuracy {Math.round(accuracy(found.length, found.length + falsePos) * 100)}%</span>
      <button className="bg-amber-500 text-black font-bold px-3 py-1 rounded" onClick={() => setRevealed(true)}>Reveal &amp; score</button>
      <button className="bg-indigo-500 font-bold px-3 py-1 rounded" onClick={coco}>⬇ MOCK scene — COCO JSON</button>
      <button className="bg-white/15 px-3 py-1 rounded" onClick={() => download('labels.txt', scene.differences.map((d, i) => toYOLO(d.bbox, 400, 300, i % DEFECTS.length)).join('\n'))}>⬇ MOCK scene — YOLO txt</button></div>
    {revealed && <p className="mt-4 text-sm">Missed: {scene.differences.length - found.length} · Only verified/human-approved samples enter production exports; unverified are separated and labeled synthetic.</p>}
  </main>);
}
