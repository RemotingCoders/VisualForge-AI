import { NextResponse } from 'next/server';
import { getLevelPayload, getDifferences } from '@/lib/serverStore';
import { loadLevelPayload, loadDifferences } from '@/lib/server/db';

export const runtime = 'nodejs';

/** GET ?levelId=... -> ALL defect boxes + classified types of a QC level, for the
 *  trainer's "Reveal & score". QC levels ONLY: a game level's annotations are its
 *  answers, so game levels get a 403 (same guard as /api/qc-export). Types are the
 *  CLASSIFIED ones when Spark classification ran, planned type as fallback. */
export async function GET(req: Request) {
  const levelId = new URL(req.url).searchParams.get('levelId') ?? '';
  if (!levelId) return NextResponse.json({ error: 'levelId required' }, { status: 400 });
  const payload = getLevelPayload(levelId) ?? await loadLevelPayload(levelId);
  if (!payload) return NextResponse.json({ error: 'level not found' }, { status: 404 });
  if (payload.mode !== 'qc') return NextResponse.json({ error: 'reveal is only available for QC levels' }, { status: 403 });
  const diffs = getDifferences(levelId) ?? await loadDifferences(levelId);
  if (!diffs) return NextResponse.json({ error: 'no differences stored for this level' }, { status: 404 });
  return NextResponse.json({
    levelId,
    // The level's difficulty is its inspector level ("Inspector level: Easy").
    difficulty: payload.difficulty ?? null,
    differences: diffs.map(d => ({
      id: d.id,
      type: d.classifiedType ?? d.type,
      plannedType: d.type,
      label: d.classificationLabel ?? d.description,
      severity: d.classifiedSeverity ?? null,
      confidence: d.classificationConfidence ?? null,
      needsReview: d.classificationConfidence !== undefined && d.classificationConfidence < 0.6,
      detectability: d.detectability ?? null,
      aiChallenges: d.aiChallenges ?? 0, aiHits: d.aiHits ?? 0, aiFoundModes: d.aiFoundModes ?? [],
      bbox: d.bbox, bbox_normalized: d.bbox_normalized, centroid: d.centroid ?? null,
    })),
  });
}
