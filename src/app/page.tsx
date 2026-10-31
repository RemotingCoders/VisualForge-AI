import Link from 'next/link';
import Gallery from '@/components/Gallery';
const Card = ({ href, emoji, title, text }: { href: string; emoji: string; title: string; text: string }) => (
  <Link href={href} className="block bg-white/5 hover:bg-white/10 transition rounded-2xl p-6 border border-white/10">
    <div className="text-4xl">{emoji}</div><h2 className="font-bold text-xl mt-3">{title}</h2><p className="opacity-75 text-sm mt-2">{text}</p>
    <span className="text-indigo-300 text-sm font-semibold">Open →</span></Link>);
export default function Home() {
  return (<main className="max-w-6xl mx-auto px-5 py-12">
    <h1 className="text-5xl font-black leading-tight">One verified difference engine.<br /><span className="text-indigo-400">Three ways to play — and work.</span></h1>
    <p className="mt-5 text-lg opacity-80 max-w-3xl">VisualForge AI takes any image and produces a modified version with realistic, localized, <b>verified</b> changes — plus the exact bounding box and mask of every change. SAM 3.1 segments, Muse Spark plans &amp; verifies, Muse Image edits only the masked region, and pixel measurement derives the <i>real</i> annotation.</p>
    <div className="grid md:grid-cols-3 gap-5 mt-10">
      <Card href="/play" emoji="🔎" title="Diferia: Play Your Photo" text="Upload your photo or describe a theme, we forge N differences, you find them against the clock." />
      <Card href="/qc" emoji="🤖" title="Challenge the AI" text="Race Muse Spark to find the defects. Can you beat the AI inspector?" />
      <Card href="/qc" emoji="🏭" title="QC Inspection Trainer" text="The same engine generates scratches, cracks and missing parts to train inspectors and export labeled COCO/YOLO datasets." />
    </div>
    <div className="mt-10 bg-indigo-500/10 border border-indigo-400/30 rounded-2xl p-6 font-mono text-sm overflow-x-auto whitespace-pre">{`original ─► SAM 3.1 segment ─► Muse Spark plan ─► Muse Image edit (masked only)
        ─► composite (outside = pixel-identical) ─► measure REAL mask/bbox ─► Muse Spark verify ─► game / race / dataset`}</div>
    <Gallery />
  </main>);
}
