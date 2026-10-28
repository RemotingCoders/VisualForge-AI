import './globals.css';
import Link from 'next/link';
export const metadata = { title: 'VisualForge AI — Diferia & QC Trainer', description: 'One verified visual-difference engine: a game, real-time multiplayer, and industrial QC training.' };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (<html lang="en"><body>
    <header className="flex items-center justify-between px-5 py-4 border-b border-white/10">
      <Link href="/" className="font-black text-xl tracking-tight">Visual<span className="text-indigo-400">Forge</span> AI</Link>
      <nav className="flex gap-4 text-sm"><Link href="/play">▶ Play</Link><Link href="/online">👥 Online</Link><Link href="/qc">🏭 QC Trainer</Link></nav>
    </header>
    <div className="bg-amber-400 text-black text-center text-xs font-bold px-3 py-1">MOCK provider active for offline demo — not real Meta output. Real Meta providers are implemented; live output awaits the Phase-0 spike (see AI_INTEGRATION.md).</div>
    {children}
    <footer className="text-center text-xs opacity-60 py-8">Built during the Meta Global AI Developer Hackathon 2026 · Built with Muse · MIT</footer>
  </body></html>);
}
