'use client';
import { useMemo, useState } from 'react';
import { roomCode, RaceBook } from '@/lib/race';
const PLAYERS = [{ id: 'you', name: 'You', color: '#22c55e' }, { id: 'rival', name: 'Rival (simulated)', color: '#f59e0b' }];
export default function Online() {
  const [code, setCode] = useState(''); const [ready, setReady] = useState(false); const [phase, setPhase] = useState<'lobby' | 'countdown' | 'race' | 'summary'>('lobby');
  const [round, setRound] = useState(1); const [wins, setWins] = useState<Record<string, number>>({ you: 0, rival: 0 });
  const [claimed, setClaimed] = useState<Record<string, string>>({}); const book = useMemo(() => new RaceBook(), [round]);
  const claim = (diff: string, player: string) => { const r = book.claim(`round-${round}`, diff, player); if (!r.alreadyClaimed) setClaimed(c => ({ ...c, [diff]: player })); };
  const endRound = () => { const tally = Object.values(claimed); const w = tally.filter(p => p === 'you').length >= tally.filter(p => p === 'rival').length ? 'you' : 'rival'; setWins(s => ({ ...s, [w]: s[w] + 1 })); setPhase('summary'); };
  return (<main className="max-w-4xl mx-auto px-5 py-8">
    <h1 className="text-3xl font-black">🏁 Diferia Online <span className="text-sm bg-amber-400 text-black px-2 py-1 rounded align-middle">LOCAL SIM — Supabase Realtime wiring in migration/API layer</span></h1>
    <p className="opacity-75 mt-2">2–4 players, same level, synchronized countdown, first finder claims each difference (DB unique constraint <code>round_finds(round_id, difference_id)</code>), wrong-click cooldown, best of 3, rematch. Reconnect restores score from <code>room_players</code>; rooms expire in 2h.</p>
    {!code ? <button className="mt-6 bg-indigo-500 font-bold px-5 py-3 rounded-xl" onClick={() => setCode(roomCode())}>Create room</button> : (<>
      <div className="mt-6 bg-white/5 rounded-2xl p-5"><p>Room code <b className="text-2xl tracking-widest">{code}</b> · Invite: <code>/online?room={code}</code></p>
        <ul className="mt-4 space-y-2">{PLAYERS.map(p => <li key={p.id} className="flex justify-between bg-white/5 rounded-lg px-3 py-2"><span><span style={{ background: p.color }} className="inline-block w-3 h-3 rounded-full mr-2" />{p.name}</span><span>{p.id === 'you' ? (ready ? '✅ ready' : '…') : '✅ ready'} · wins {wins[p.id]}</span></li>)}</ul>
        {phase === 'lobby' && <button className="mt-4 bg-green-500 text-black font-bold px-4 py-2 rounded-lg" onClick={() => { setReady(true); setPhase('countdown'); setTimeout(() => setPhase('race'), 1200); }}>{ready ? 'Waiting…' : 'I\'m ready — start countdown'}</button>}
        {phase === 'countdown' && <p className="mt-4 text-3xl font-black">3… 2… 1…</p>}
        {phase === 'race' && <div className="mt-5"><p className="font-bold">Round {round} — race! Click a difference for You, or simulate the rival:</p>
          <div className="flex flex-wrap gap-2 mt-3">{['diff-1', 'diff-2', 'diff-3', 'diff-4', 'diff-5'].map(d => <span key={d} className="flex gap-1"><button disabled={!!claimed[d]} onClick={() => claim(d, 'you')} className="bg-indigo-500 disabled:opacity-40 px-3 py-2 rounded-lg text-sm">{d} 🟢</button><button disabled={!!claimed[d]} onClick={() => claim(d, 'rival')} className="bg-amber-500 text-black disabled:opacity-40 px-3 py-2 rounded-lg text-sm">rival</button></span>)}</div>
          <p className="mt-3 text-sm">{Object.entries(claimed).map(([d, p]) => <span key={d} className="mr-3">{d}: <b>{p}</b></span>)}</p>
          <button className="mt-3 bg-white/15 px-4 py-2 rounded-lg" onClick={endRound}>End round</button></div>}
        {phase === 'summary' && <div className="mt-5"><p className="font-bold">Round {round} summary — accuracy &amp; finds are server-written in production. Match: You {wins.you} · Rival {wins.rival}</p>
          {round < 3 ? <button className="mt-3 bg-indigo-500 font-bold px-4 py-2 rounded-lg" onClick={() => { setRound(r => r + 1); setClaimed({}); setPhase('lobby'); setReady(false); }}>Next round</button>
          : <button className="mt-3 bg-green-500 text-black font-bold px-4 py-2 rounded-lg" onClick={() => { setRound(1); setWins({ you: 0, rival: 0 }); setClaimed({}); setPhase('lobby'); }}>🔁 Rematch (best of 3)</button>}</div>}
      </div></>)}
  </main>);
}
