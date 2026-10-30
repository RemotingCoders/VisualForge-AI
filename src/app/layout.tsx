import './globals.css';
import Link from 'next/link';
export const metadata = { title: 'VisualForge AI — Diferia & QC Trainer', description: 'One verified visual-difference engine: a game, real-time multiplayer, and industrial QC training.' };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (<html lang="en"><body>
    <header className="flex items-center justify-between px-5 py-4 border-b border-white/10">
      <Link href="/" className="flex items-center gap-2.5 font-black text-xl tracking-tight">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.svg" alt="VisualForge AI logo" width={34} height={34} className="rounded-[9px]" />
        <span>Visual<span className="text-indigo-400">Forge</span> AI</span>
      </Link>
      <nav className="flex gap-4 text-sm"><Link href="/play">▶ Play</Link><Link href="/online">👥 Online</Link><Link href="/qc">🏭 QC Trainer</Link></nav>
    </header>
    <div className="bg-amber-400 text-black text-center text-xs font-bold px-3 py-1">Offline demo runs the labeled MOCK provider — not real Meta output. The real Meta pipeline is implemented and spike-validated (Phase 0, 2026-10-29); enable it server-side with AI_PROVIDER=meta + META_REAL_CALLS_ENABLED=true (see AI_INTEGRATION.md).</div>
    {children}
    <footer className="text-center text-xs opacity-60 py-8">Built during the Meta Global AI Developer Hackathon 2026 · Built with Muse · MIT</footer>
  </body></html>);
}
