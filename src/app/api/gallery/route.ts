import { NextResponse } from 'next/server';
import { listPublishedLevels } from '@/lib/server/db';

export const runtime = 'nodejs';

/** GET -> the 12 most recent published levels from Supabase (original-image thumbnail
 *  + difference count). Code-free and generation-free: playing a gallery level just
 *  loads its stored images via /api/level. */
export async function GET() {
  return NextResponse.json({ levels: await listPublishedLevels(12) });
}
