import { NextResponse } from 'next/server';
import { listPublishedLevels } from '@/lib/server/db';
import type { Mode } from '@/lib/engine/types';

export const runtime = 'nodejs';

/** GET ?mode=game|qc -> the 12 most recent published levels from Supabase
 *  (original-image thumbnail + difference count). Code-free and generation-free:
 *  playing a gallery level just loads its stored images via /api/level. */
export async function GET(req: Request) {
  const m = new URL(req.url).searchParams.get('mode');
  const mode: Mode | undefined = m === 'qc' || m === 'game' ? m : undefined;
  return NextResponse.json({ levels: await listPublishedLevels(12, mode) });
}
