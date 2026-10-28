'use client';
import { useMemo, useRef, useState } from 'react';
import { generateDemoScene, renderShapes } from '@/lib/demoScene';
import { clickHits, accuracy } from '@/lib/engine/geometry';
import { toCOCO, toYOLO } from '@/lib/coco';

const DEFECTS = ['scratch', 'crack', 'dent', 'missing component', 'corrosion', 'misalignment', 'wrong color', 'foreign object'];
export default function QC() {
  const scene = useMemo(() => generateDemoScene(42), []); const [found, setFound] = useState<string[]>([]); const [falsePos, setFalsePos] = useState(0); const [revealed, setRevealed] = useState(false); const ref = useRef<SVGSVGElement>(null);
  const click = (e: React.MouseEvent) => { if (!ref.current || revealed) return; const r = ref.current.getBoundingClientRect(); const x = ((e.clientX - r.left) / r.width) * 400, y = ((e.clientY - r.top) / r.height) * 300;
    const hit = scene.differences.find(d => !found.includes(d.id) && clickHits({ x, y }, d.bbox, 14)); hit ? setFound(f => [...f, hit.id]) : setFalsePos(n => n + 1); };
  const download = (name: string, text: string) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = name; a.click(); };
  const coco = () => download('visualforge-dataset.json', JSON.stringify(toCOCO([{ id: 1, file_name: 'product-modified.svg', width: 400, height: 300 }], scene.differences.map((d, i) => ({ imageId: 1, categoryId: (i % DEFECTS.length) + 1, bbox: d.bbox })), DEFECTS.map((n, i) => ({ id: i + 1, name: n }))), null, 2));
  return (<main className="max-w-5xl mx-auto px-5 py-8 font-mono">
    <h1 className="text-3xl font-black">🏭 QC Inspection Trainer</h1><p className="opacity-70 mt-2 text-sm">Industrial mode · synthetic defects — validate before industrial use · MOCK scene (real defects via Muse Image after Phase 0)</p>
    <div className="grid md:grid-cols-2 gap-5 mt-6">
      <div><h2 className="font-bold mb-2">Reference (known-good)</h2><svg viewBox="0 0 400 300" className="w-full rounded bg-slate-900" dangerouslySetInnerHTML={{ __html: renderShapes(scene.original) }} /></div>
      <div><h2 className="font-bold mb-2">Inspect this unit — click defects</h2><svg ref={ref} onClick={click} viewBox="0 0 400 300" className="w-full rounded bg-slate-900 cursor-crosshair" dangerouslySetInnerHTML={{ __html: renderShapes(scene.modified) + (revealed ? scene.differences.map(d => `<rect x="${d.bbox.x}" y="${d.bbox.y}" width="${d.bbox.width}" height="${d.bbox.height}" fill="none" stroke="#ef4444" stroke-width="3"/>`).join('') : '') }} /></div>
    </div>
    <div className="flex flex-wrap gap-3 mt-5 text-sm"><span className="bg-white/10 px-3 py-1 rounded">Correct {found.length}</span><span className="bg-white/10 px-3 py-1 rounded">False positives {falsePos}</span><span className="bg-white/10 px-3 py-1 rounded">Accuracy {Math.round(accuracy(found.length, found.length + falsePos) * 100)}%</span>
      <button className="bg-amber-500 text-black font-bold px-3 py-1 rounded" onClick={() => setRevealed(true)}>Reveal &amp; score</button>
      <button className="bg-indigo-500 font-bold px-3 py-1 rounded" onClick={coco}>⬇ Export COCO JSON</button>
      <button className="bg-white/15 px-3 py-1 rounded" onClick={() => download('labels.txt', scene.differences.map((d, i) => toYOLO(d.bbox, 400, 300, i % DEFECTS.length)).join('\n'))}>⬇ Export YOLO txt</button></div>
    {revealed && <p className="mt-4 text-sm">Missed: {scene.differences.length - found.length} · Only verified/human-approved samples enter production exports; unverified are separated and labeled synthetic.</p>}
  </main>);
}
