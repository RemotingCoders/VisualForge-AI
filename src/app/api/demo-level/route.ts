import { NextResponse } from 'next/server';
import { createDemoLevel } from '@/lib/serverStore';
export async function GET(req: Request) {
  const seed = Number(new URL(req.url).searchParams.get('seed') ?? 7);
  return NextResponse.json({ ...createDemoLevel(Number.isFinite(seed) ? seed : 7), providerLabel: 'MOCK — offline demo scene, not real Meta output' });
}
