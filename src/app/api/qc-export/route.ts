import { NextResponse } from 'next/server';
import { getDifferences, getLevelPayload } from '@/lib/serverStore';
import { loadDifferences, loadLevelPayload } from '@/lib/server/db';
import { buildQCCoco, buildQCYolo } from '@/lib/coco';

export const runtime = 'nodejs';

/**
 * GET ?levelId=...&format=coco|yolo — dataset export for a REAL QC level.
 * Guard rails: QC levels only (a game level's annotations are its answers — never exported),
 * and only `verified` differences enter the dataset. BBoxes are the measured defect boxes.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const levelId = url.searchParams.get('levelId') ?? '';
  const format = url.searchParams.get('format') === 'yolo' ? 'yolo' : 'coco';
  if (!levelId) return NextResponse.json({ error: 'levelId required' }, { status: 400 });

  const payload = getLevelPayload(levelId) ?? await loadLevelPayload(levelId);
  if (!payload) return NextResponse.json({ error: 'level not found' }, { status: 404 });
  if (payload.mode !== 'qc') return NextResponse.json({ error: 'export is only available for QC levels' }, { status: 403 });

  const diffs = getDifferences(levelId) ?? await loadDifferences(levelId);
  if (!diffs) return NextResponse.json({ error: 'no differences stored for this level' }, { status: 404 });

  const headers = (name: string, type: string) => ({ 'Content-Type': type, 'Content-Disposition': `attachment; filename="${name}"` });
  if (format === 'yolo') {
    return new NextResponse(buildQCYolo(diffs, payload.width, payload.height), { headers: headers(`visualforge-${levelId}-labels.txt`, 'text/plain') });
  }
  const coco = buildQCCoco(diffs, payload.width, payload.height, `${levelId}-modified.png`);
  return new NextResponse(JSON.stringify(coco, null, 2), { headers: headers(`visualforge-${levelId}-dataset.json`, 'application/json') });
}
