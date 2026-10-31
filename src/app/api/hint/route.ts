import { NextResponse } from 'next/server';
import { getDifferences } from '@/lib/serverStore';
import { loadDifferences } from '@/lib/server/db';
import { pickNextHint } from '@/lib/server/hints';

/** Capability 2: deliver the NEXT progressive hint for the pending difference with the
 *  lowest difficulty (1 = easiest). The client reports which differences it already
 *  found (foundIds, same contract as /api/validate-click) and how many hints each
 *  difference already consumed (used), so hints progress 1 → 2 → 3 per difference and
 *  then move to the next easiest pending one. Hints are the one annotation revealed
 *  on purpose — one at a time, never the full set. */
export async function POST(req: Request) {
  const { levelId, foundIds = [], used = {} } = await req.json();
  const diffs = getDifferences(levelId) ?? await loadDifferences(levelId);
  if (!diffs) return NextResponse.json({ error: 'level not found (server restarted or expired)' }, { status: 404 });
  const next = pickNextHint(diffs, foundIds as string[], used as Record<string, number>);
  if (!next) return NextResponse.json({ exhausted: true });
  return NextResponse.json(next);
}
