'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';

type GalleryLevel = { levelId: string; original: string; total: number; mode: string; isMock: boolean; theme?: string };

/** Level gallery: the most recent published levels, straight from Supabase.
 *  Playing one loads its stored images — it generates NOTHING and needs no
 *  access code. On the landing the Play buttons link to /play?level=…; inside
 *  /play they load the level in place via onPlay. `mode` filters server-side
 *  (Play/landing show game levels only — QC levels live in the QC gallery). */
export default function Gallery({ onPlay, mode }: { onPlay?: (levelId: string) => void; mode?: 'game' | 'qc' }) {
  const [levels, setLevels] = useState<GalleryLevel[] | null>(null);
  useEffect(() => {
    (async () => {
      try { const d = await (await fetch(mode ? `/api/gallery?mode=${mode}` : '/api/gallery')).json(); setLevels(Array.isArray(d.levels) ? d.levels : []); }
      catch { setLevels([]); }
    })();
  }, [mode]);
  if (!levels?.length) return null;
  return (
    <section className="mt-10">
      <h2 className="font-bold text-xl">🖼️ Level gallery</h2>
      <p className="opacity-75 text-sm mt-1">Recently generated levels, ready to play — playing them generates nothing new.</p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
        {levels.map(l => (
          <figure key={l.levelId} className="bg-white/5 border border-white/10 rounded-xl overflow-hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={l.original} alt={l.theme ? `Generated scene: ${l.theme}` : 'Generated level'} className="w-full aspect-[4/3] object-cover" loading="lazy" />
            <figcaption className="p-3 flex items-center justify-between gap-2">
              <span className="text-xs opacity-75 truncate" title={l.theme}>{l.total} differences{l.theme ? ` · “${l.theme}”` : ''}</span>
              {onPlay
                ? <button className="bg-indigo-500 px-3 py-1 rounded-full text-xs font-bold shrink-0" onClick={() => onPlay(l.levelId)}>▶ Play</button>
                : <Link className="bg-indigo-500 px-3 py-1 rounded-full text-xs font-bold shrink-0" href={`/play?level=${l.levelId}`}>▶ Play</Link>}
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}
