import { NextResponse } from 'next/server';
import { getDifferences } from '@/lib/serverStore';
import { clickHits } from '@/lib/engine/geometry';

/** Server-authoritative click validation. Annotations never leave the server before a find. */
export async function POST(req: Request) {
  const { levelId, x, y, foundIds = [] } = await req.json();
  const diffs = getDifferences(levelId);
  if (!diffs) return NextResponse.json({ error: 'level not found (server restarted or expired)' }, { status: 404 });
  const hit = diffs.find(d => !(foundIds as string[]).includes(d.id) && clickHits({ x, y }, d.bbox, 16));
  if (!hit) return NextResponse.json({ hit: false });
  // Reveal ONLY the found difference, after validation.
  return NextResponse.json({ hit: true, difference: { id: hit.id, description: hit.description, bbox: hit.bbox, centroid: hit.centroid ?? null } });
}
