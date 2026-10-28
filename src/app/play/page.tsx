'use client';
import { useEffect, useRef, useState } from 'react';
import type { Shape } from '@/lib/demoScene';
import { renderShapes } from '@/lib/demoScene';
import { scoreGame } from '@/lib/engine/geometry';

type Found = { id: string; description: string; bbox: { x: number; y: number; width: number; height: number } };
export default function Play() {
  const [levelId, setLevelId] = useState(''); const [orig, setOrig] = useState<Shape[]>([]); const [mod, setMod] = useState<Shape[]>([]);
  const [total, setTotal] = useState(0); const [found, setFound] = useState<Found[]>([]); const [mistakes, setMistakes] = useState(0);
  const [hints, setHints] = useState(0); const [msg, setMsg] = useState('Loading MOCK level…'); const [start] = useState(Date.now());
  const svgRef = useRef<SVGSVGElement>(null);
  const load = async (seed = Math.floor(Math.random() * 9999)) => { const d = await (await fetch(`/api/demo-level?seed=${seed}`)).json(); setLevelId(d.levelId); setOrig(d.original); setMod(d.modified); setTotal(d.total); setFound([]); setMistakes(0); setHints(0); setMsg('Find all differences! Click the modified image (right / bottom).'); };
  useEffect(() => { load(7); }, []);
  const click = async (e: React.MouseEvent) => {
    if (!svgRef.current || found.length >= total) return;
    const r = svgRef.current.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 400, y = ((e.clientY - r.top) / r.height) * 300;
    const res = await (await fetch('/api/validate-click', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ levelId, x, y, foundIds: found.map(f => f.id) }) })).json();
    if (res.hit) { setFound(f => [...f, res.difference]); setMsg(`✅ ${res.difference.description}`); } else { setMistakes(m => m + 1); setMsg('❌ Not there — mistake!'); }
  };
  const done = total > 0 && found.length >= total; const elapsed = Math.round((Date.now() - start) / 1000);
  const Panel = ({ shapes, onClick, marks }: { shapes: Shape[]; onClick?: (e: React.MouseEvent) => void; marks?: Found[] }) => (
    <svg ref={onClick ? svgRef : undefined} onClick={onClick} viewBox="0 0 400 300" className={`w-full rounded-xl bg-gradient-to-br from-slate-800 to-slate-950 ${onClick ? 'cursor-crosshair' : ''}`} dangerouslySetInnerHTML={{ __html: renderShapes(shapes) + (marks ?? []).map(f => `<rect x="${f.bbox.x}" y="${f.bbox.y}" width="${f.bbox.width}" height="${f.bbox.height}" fill="none" stroke="#22c55e" stroke-width="3" rx="8"/>`).join('') }} />);
  return (<main className="max-w-6xl mx-auto px-5 py-8">
    <h1 className="text-3xl font-black">🔎 Diferia — Play Your Photo <span className="text-sm align-middle bg-amber-400 text-black px-2 py-1 rounded">MOCK LEVEL</span></h1>
    <p className="opacity-75 mt-2">Upload/theme generation activates with the real Meta pipeline (Phase 0). This offline level exercises the same server-validated gameplay: annotations are never sent before you find them.</p>
    <div className="flex flex-wrap gap-3 my-5 text-sm"><span className="bg-white/10 px-3 py-1 rounded-full">Found {found.length}/{total}</span><span className="bg-white/10 px-3 py-1 rounded-full">Mistakes {mistakes}/5</span>
      <button className="bg-white/10 px-3 py-1 rounded-full" onClick={() => { setHints(h => h + 1); setMsg('💡 Hint: compare corners and large shapes first (real hints reveal a zone with the verified pipeline).'); }}>💡 Hint ({hints})</button>
      <button className="bg-indigo-500 px-3 py-1 rounded-full font-bold" onClick={() => load()}>↻ New level</button>
      {typeof window !== 'undefined' && levelId && <button className="bg-white/10 px-3 py-1 rounded-full" onClick={() => navigator.clipboard?.writeText(`${location.origin}/play?level=${levelId}`)}>🔗 Share link</button>}</div>
    <p aria-live="polite" className="font-semibold">{done ? `🎉 Finished! Score ${scoreGame(found.length, total, mistakes, hints, elapsed)} · ${elapsed}s` : msg}</p>
    <div className="grid md:grid-cols-2 gap-5 mt-4"><div><h2 className="font-bold mb-2">Original</h2><Panel shapes={orig} /></div>
      <div><h2 className="font-bold mb-2">Modified — click differences</h2><Panel shapes={mod} onClick={click} marks={found} /></div></div>
    <ul className="mt-4 text-sm">{found.map(f => <li key={f.id}>✅ {f.description}</li>)}</ul>
    {mistakes >= 5 && <p className="text-red-300 font-bold mt-3">Out of mistakes — load a new level to try again.</p>}
  </main>);
}
