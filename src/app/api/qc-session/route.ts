import { NextResponse } from 'next/server';
import { getLevelPayload, recordQcSession } from '@/lib/serverStore';
import { loadLevelPayload, persistQcSession } from '@/lib/server/db';

export const runtime = 'nodejs';

/** POST {levelId, correct, missed, falsePositives, durationSec} — records a QC
 *  trainer session at "Reveal & score" time. Accuracy is computed server-side
 *  (correct / (correct + false positives)), never trusted from the client.
 *  QC levels only, like every annotation-bearing QC endpoint. */
export async function POST(req: Request) {
  let body: { levelId?: string; correct?: number; missed?: number; falsePositives?: number; durationSec?: number };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid JSON' }, { status: 400 }); }
  const levelId = body.levelId ?? '';
  if (!levelId) return NextResponse.json({ error: 'levelId required' }, { status: 400 });
  const payload = getLevelPayload(levelId) ?? await loadLevelPayload(levelId);
  if (!payload) return NextResponse.json({ error: 'level not found' }, { status: 404 });
  if (payload.mode !== 'qc') return NextResponse.json({ error: 'sessions are only recorded for QC levels' }, { status: 403 });
  const num = (v: unknown) => Math.max(0, Math.floor(Number(v) || 0));
  const correct = num(body.correct), missed = num(body.missed), falsePositives = num(body.falsePositives), durationSec = num(body.durationSec);
  const accuracy = correct + falsePositives > 0 ? correct / (correct + falsePositives) : 1;
  const session = recordQcSession(levelId, { correct, missed, falsePositives, accuracy, durationSec });
  void persistQcSession(levelId, session);
  return NextResponse.json({ ok: true, session });
}
