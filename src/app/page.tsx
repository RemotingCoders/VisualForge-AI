import Link from 'next/link';
import Gallery from '@/components/Gallery';

const Card = ({ href, emoji, title, subtitle, bullets }: { href: string; emoji: string; title: string; subtitle: string; bullets: string[] }) => (
  <Link href={href} className="block bg-white/5 hover:bg-white/10 transition rounded-2xl p-6 border border-white/10">
    <div className="text-4xl">{emoji}</div>
    <h2 className="font-bold text-xl mt-3">{title}</h2>
    <p className="opacity-75 text-sm mt-2">{subtitle}</p>
    <ul className="mt-3 space-y-1 text-sm opacity-85 list-disc list-inside">
      {bullets.map(b => <li key={b}>{b}</li>)}
    </ul>
    <span className="inline-block mt-4 text-indigo-300 text-sm font-semibold">Open →</span>
  </Link>
);

export default function Home() {
  return (<main className="max-w-6xl mx-auto px-5 py-12">
    <h1 className="text-5xl font-black leading-tight">One verified difference engine.<br /><span className="text-indigo-400">Play it — or put it to work.</span></h1>
    <p className="mt-5 text-lg opacity-80 max-w-3xl">VisualForge AI takes any image — or a scene you describe — and produces a modified version with realistic, localized, <b>verified</b> changes, plus the exact mask and bounding box of every change. Muse Image generates and edits, SAM 3.1 segments with real masks, Muse Spark plans, reviews, verifies and writes the hints, and pixel measurement derives the <i>real</i> annotation. Outside the edited regions, every pixel is the original.</p>
    <div className="grid md:grid-cols-2 gap-5 mt-10">
      <Card href="/play" emoji="🔎" title="Diferia: Play Your Photo"
        subtitle="Spot-the-difference levels from any photo, or from a scene you describe."
        bullets={[
          'Type or dictate a theme: Muse Image builds the scene, the engine hides the differences',
          'Every difference measured and verified; nothing leaks before you find it',
          'Progressive hints and difficulty written by Muse Spark',
          'Race against Spark: it hunts the same differences while you play',
        ]} />
      <Card href="/qc" emoji="🏭" title="QC Inspection Trainer"
        subtitle="Synthetic defects to train inspectors and bootstrap detection datasets."
        bullets={[
          'Describe a part or upload its photo; choose the inspector level and the defects you want',
          'Scratches, dents, corrosion, missing parts, placed and measured on the real surface',
          'Inspect, reveal and score; challenge the AI inspector with or without the reference',
          "Export COCO / YOLO with masks, Spark's classification and confidence",
        ]} />
    </div>
    <div className="mt-10 bg-indigo-500/10 border border-indigo-400/30 rounded-2xl p-6 font-mono text-xs sm:text-sm whitespace-pre-wrap break-words leading-relaxed">{`photo or theme → Spark moderation → Muse Image scene
→ SAM 3.1 masks ∥ Spark plan → Muse Image one-pass edit
→ aligned & measured: real mask / bbox, rest pixel-identical
→ Spark review, hints, verify → game / AI race / dataset`}</div>
    <Gallery mode="game" />
  </main>);
}