import { NextResponse } from 'next/server';
import { selectProviders } from '@/lib/engine/providers';
import { getLevelPayload, getDifferences } from '@/lib/serverStore';
import { loadLevelPayload, loadDifferences, persistDetectability } from '@/lib/server/db';
import { clientIp } from '@/lib/server/access';
import { hitChallengeRateLimit, CHALLENGE_LIMIT_MAX } from '@/lib/server/rateLimit';
import { validateAiFindings, applyDetectability, type AiInspectMode } from '@/lib/aiInspect';
import { providerImage, bufferToDataUrl } from '@/lib/server/imageOps';

export const runtime = 'nodejs';

/** Spark receives provider-ready JPEG twins; stored levels may carry public
 *  Storage URLs, which are fetched server-side first. Anything else (demo scene
 *  objects) is not inspectable. */
async function toProviderImage(ref: unknown): Promise<string | null> {
  if (typeof ref !== 'string' || !ref) return null;
  try {
    if (ref.startsWith('data:image/')) return await providerImage(ref);
    if (ref.startsWith('http')) {
      const r = await fetch(ref);
      if (!r.ok) return null;
      return await providerImage(bufferToDataUrl(Buffer.from(await r.arrayBuffer())));
    }
  } catch { /* fall through to null */ }
  return null;
}

/** POST {levelId, mode?: 'no-reference'|'with-reference'} — Challenge the AI
 *  inspector. ONE Muse Spark call inspects the level's target image (the
 *  defective/modified one; with-reference prepends the known-good original).
 *  The annotations NEVER leave the server: Spark's findings are validated here
 *  (finding box expanded 16 px overlapping an unclaimed real bbox, or the
 *  center of either box inside the other; each difference claimable once,
 *  duplicates count as false positives) and every finding is logged against
 *  its nearest real box for calibration. No access code — instead a per-IP
 *  limit of 10 challenges/hour (one Spark call each). Each challenge also
 *  accumulates per-difference Spark detectability (migration 0006). */
export async function POST(req: Request) {
  let body: { levelId?: string; mode?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid JSON' }, { status: 400 }); }
  const levelId = typeof body.levelId === 'string' ? body.levelId : '';
  if (!levelId) return NextResponse.json({ error: 'levelId required' }, { status: 400 });
  const mode: AiInspectMode = body.mode === 'with-reference' ? 'with-reference' : 'no-reference';

  const payload = getLevelPayload(levelId) ?? await loadLevelPayload(levelId);
  if (!payload) return NextResponse.json({ error: 'level not found' }, { status: 404 });
  const diffs = getDifferences(levelId) ?? await loadDifferences(levelId);
  if (!diffs?.length) return NextResponse.json({ error: 'no differences stored for this level' }, { status: 404 });

  const rate = hitChallengeRateLimit(clientIp(req));
  if (!rate.ok) return NextResponse.json({ error: `AI challenge limit reached — ${CHALLENGE_LIMIT_MAX} challenges per hour per network. Try again in about ${Math.ceil(rate.retryAfterSec / 60)} min.` }, { status: 429 });

  const kind: 'qc' | 'game' = payload.mode === 'qc' ? 'qc' : 'game';
  const modified = await toProviderImage(payload.modified);
  if (!modified) return NextResponse.json({ error: 'level image unavailable for inspection' }, { status: 400 });
  const images = [modified];
  if (mode === 'with-reference') {
    const original = await toProviderImage(payload.original);
    if (original) images.unshift(original);
  }

  const { providers } = selectProviders();
  if (!providers.vision.inspectImage) return NextResponse.json({ error: 'this provider cannot run the AI inspector' }, { status: 501 });
  const t0 = Date.now();
  let findings;
  try {
    findings = await providers.vision.inspectImage(images, { kind, withReference: mode === 'with-reference' });
  } catch (e) {
    return NextResponse.json({ error: `AI inspector failed: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }
  const latencyMs = Date.now() - t0;

  const validated = validateAiFindings(findings, diffs, payload.width, payload.height, kind);
  applyDetectability(diffs, validated.matchedIds, mode);
  void persistDetectability(levelId, diffs);
  console.info(`[ai-inspect] level=${levelId} kind=${kind} mode=${mode} latency=${(latencyMs / 1000).toFixed(1)}s findings=${validated.findings.length} matched=${validated.matchedIds.length}/${diffs.length} falsePositives=${validated.falsePositives}${providers.vision.isMock ? ' (MOCK provider — no real inspection)' : ''}`);
  // Per-finding calibration: Spark's box vs its nearest real box + center
  // distance — the data that tunes the 16 px overlap rule.
  for (const f of validated.findings) {
    const s = f.sparkBoxPx;
    const n = f.nearestBoxPx;
    console.info(`[ai-inspect] finding "${f.label}" conf=${(f.confidence ?? 0).toFixed(2)} spark=(${s.x},${s.y}) ${s.width}x${s.height} nearest="${f.nearestLabel ?? '—'}" real=${n ? `(${n.x},${n.y}) ${n.width}x${n.height}` : '—'} centerDist=${f.centerDistancePx ?? '—'}px → ${f.matched ? `MATCH "${f.truthLabel}"` : 'false positive'}`);
  }

  return NextResponse.json({
    levelId, mode, kind, isMock: providers.vision.isMock,
    latencyMs, latencySec: Math.round(latencyMs / 100) / 10,
    total: diffs.length,
    matchedCount: validated.matchedIds.length,
    falsePositives: validated.falsePositives,
    findings: validated.findings,
    missed: validated.missed,
    detectability: diffs.map(d => ({
      id: d.id, detectability: d.detectability ?? null,
      aiChallenges: d.aiChallenges ?? 0, aiHits: d.aiHits ?? 0, aiFoundModes: d.aiFoundModes ?? [],
    })),
  });
}
