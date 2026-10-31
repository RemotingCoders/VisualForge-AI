import { NextResponse } from 'next/server';
import { getLevelPayload, getDemoPayload } from '@/lib/serverStore';
import { loadLevelPayload } from '@/lib/server/db';

export const runtime = 'nodejs';

/** GET ?id=<levelId> -> the public playable payload of an EXISTING level (board
 *  images + total, NO annotations — anti-cheat). Powers gallery play and share
 *  links: it never generates anything and never needs the access code. */
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get('id') ?? '';
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const payload = getLevelPayload(id) ?? getDemoPayload(id) ?? await loadLevelPayload(id);
  if (!payload) return NextResponse.json({ error: 'level not found' }, { status: 404 });
  return NextResponse.json(payload);
}
