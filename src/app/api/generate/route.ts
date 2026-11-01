import { NextResponse } from 'next/server';
import { selectProviders, assertMetaConfigured } from '@/lib/engine/providers';
import { checkLimits } from '@/lib/limits';
import { createJob, resolveJob, jobsToday, runGeneration } from '@/lib/server/jobs';
import type { Difficulty } from '@/lib/engine/types';
import { persistJob, loadLevelPayload, countJobsToday } from '@/lib/server/db';
import { requireMetaAccess, accessCodeRequired, clientIp } from '@/lib/server/access';
import { enforceSpendCap } from '@/lib/server/spend';
import { hitGenerationRateLimit, RATE_LIMIT_MAX } from '@/lib/server/rateLimit';
import { createDemoLevel, getLevelPayload, getDemoPayload } from '@/lib/serverStore';
import { issueThemeTicket, consumeThemeTicket } from '@/lib/server/themeTickets';

export const runtime = 'nodejs';
const MAX_IMAGE_CHARS = 12_000_000; // ~9 MB base64 — abuse/credit guard

/** POST {imageDataUrl, count, mode} — or {theme, count, mode} with VF_THEME_GENERATION — -> {jobId, isMock, label}. Generation runs async (Meta calls take 3-17s each).
 *  Public-demo credit protection, checked BEFORE any provider work: the single
 *  access rule (requireMetaAccess, shared with /api/ai-inspect and every future
 *  Meta-calling route — 401 without the judge code when VF_ACCESS_CODE is set),
 *  the global judging-period budget (VF_SPEND_CAP_USD — 429 when exhausted),
 *  per-IP rate limit of 5 generations/hour (429), daily job cap counted from
 *  visualforge_generation_jobs (429). Playing existing levels needs none of this.
 *  Voice dictation sends {themeCheck: true} when dictation stops: ONE Spark
 *  moderation call (the same one generation would make) returns ok + cleanTheme
 *  ("Spark suggests") + a one-time ticket, so the real generation that follows
 *  reuses it instead of moderating twice. A check creates no job and burns no
 *  generation quota — it runs before the rate-limit/daily-cap guards below. */
export async function POST(req: Request) {
  let body: { imageDataUrl?: string; count?: number; mode?: 'game' | 'qc'; difficulty?: string; theme?: string; accessCode?: string; themeCheck?: boolean; themeTicket?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid JSON' }, { status: 400 }); }
  // THE access rule: when VF_ACCESS_CODE is set, every Meta-calling route demands
  // the judge code before any provider work — this one, /api/ai-inspect, and any
  // future one (tests/spend.test.ts walks src/app/api and fails an ungated route).
  const denied = requireMetaAccess(body.accessCode);
  if (denied) return denied;
  // Second layer, the global budget: also before the dictation pre-check below —
  // its Spark theme moderation is a paid call like any other.
  const overBudget = await enforceSpendCap();
  if (overBudget) return overBudget;
  // VF_THEME_GENERATION: a theme (>= 3 chars after trim, capped at 200) replaces the
  // uploaded photo — the scene itself is generated. Flag-gated; rejected BEFORE any
  // provider work so a disabled feature never reaches a paid call.
  const theme = typeof body.theme === 'string' ? body.theme.trim() : '';
  if (theme) {
    if (process.env.VF_THEME_GENERATION !== 'true') return NextResponse.json({ error: 'theme generation is disabled (VF_THEME_GENERATION)' }, { status: 400 });
    if (theme.length < 3) return NextResponse.json({ error: 'theme too short (min 3 characters)' }, { status: 400 });
    if (theme.length > 200) return NextResponse.json({ error: 'theme too long (max 200 characters)' }, { status: 400 });
  }
  // Voice-dictation pre-check: moderate the dictated theme NOW (one Spark call) and
  // hand back the tidied rewrite + a one-time ticket. Deliberately BEFORE the
  // generation guards below: checking a dictation is not a generation.
  if (body.themeCheck) {
    if (!theme) return NextResponse.json({ error: 'theme required' }, { status: 400 });
    const { providers } = selectProviders();
    if (!providers.vision.moderateTheme) return NextResponse.json({ error: 'theme moderation is not available on this provider' }, { status: 501 });
    try {
      const mod = await providers.vision.moderateTheme(theme);
      if (!mod.ok) return NextResponse.json({ ok: false, reason: mod.reason });
      const cleanTheme = mod.cleanTheme?.trim() ? mod.cleanTheme.trim() : theme;
      return NextResponse.json({ ok: true, reason: mod.reason, cleanTheme, themeTicket: issueThemeTicket(theme, cleanTheme), isMock: providers.vision.isMock });
    } catch (e) {
      return NextResponse.json({ error: `theme check failed: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
    }
  }
  // Both public-demo guards switch on together: with VF_ACCESS_CODE unset (local
  // dev) there is no code AND no per-IP limit; the daily cap below always applies.
  if (accessCodeRequired()) {
    const rate = hitGenerationRateLimit(clientIp(req));
    if (!rate.ok) return NextResponse.json({ error: `Too many generations from this network — the limit is ${RATE_LIMIT_MAX} per hour. Please try again in about ${Math.ceil(rate.retryAfterSec / 60)} min, or play the demo level and the gallery below.` }, { status: 429 });
  }
  const count = Math.max(1, Math.min(10, body.count ?? 5));
  const mode = body.mode === 'qc' ? 'qc' : 'game';
  const difficulty: Difficulty = body.difficulty === 'easy' || body.difficulty === 'hard' ? body.difficulty : 'medium';
  // Daily cap counted from today's visualforge_generation_jobs rows (durable across
  // restarts/instances); in-memory count only as fallback when Supabase is unavailable.
  const dbJobsToday = await countJobsToday();
  const limits = checkLimits({ changes: count, jobsToday: dbJobsToday ?? jobsToday() });
  if (!limits.ok) return NextResponse.json({ error: limits.reason }, { status: 429 });

  const { providers, label } = selectProviders();
  if (providers.segmentation.isMock) {
    // Honest offline path: labeled demo scene level, instantly playable. No silent fake "AI generation".
    const job = createJob(mode, true, count, difficulty);
    const demo = createDemoLevel(Math.floor(Math.random() * 9999));
    job.status = 'done'; job.stage = 'done'; job.levelId = demo.levelId; job.updatedAt = Date.now(); void persistJob(job);
    return NextResponse.json({ jobId: job.id, isMock: true, label, levelId: demo.levelId });
  }

  try { assertMetaConfigured(); } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : 'meta not configured' }, { status: 400 }); }
  if (theme) {
    const job = createJob(mode, false, count, difficulty);
    // A dictation pre-check ticket for THIS exact text means Spark already moderated
    // it — the job skips its own moderation call (exactly one per theme, total).
    const themePreModerated = consumeThemeTicket(body.themeTicket, theme);
    void runGeneration(job, { theme, themePreModerated }, count, providers); // async by design — poll GET
    return NextResponse.json({ jobId: job.id, isMock: false, label });
  }
  const imageDataUrl = body.imageDataUrl ?? '';
  if (!imageDataUrl.startsWith('data:image/') || imageDataUrl.length > MAX_IMAGE_CHARS)
    return NextResponse.json({ error: 'imageDataUrl required (data:image/..., max ~9MB)' }, { status: 400 });

  const job = createJob(mode, false, count, difficulty);
  void runGeneration(job, { imageDataUrl }, count, providers); // async by design — poll GET
  return NextResponse.json({ jobId: job.id, isMock: false, label });
}

/** GET ?id=job-... -> job status; when done, the playable level payload (images+total, no annotations). */
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get('id') ?? '';
  const job = await resolveJob(id);
  if (!job) return NextResponse.json({ error: 'job not found' }, { status: 404 });
  const base = { jobId: job.id, status: job.status, stage: job.stage, isMock: job.isMock, error: job.error ?? null, previewImage: job.previewImage ?? null, elapsedSec: Math.round((Date.now() - job.createdAt) / 1000), stageSec: Math.round((Date.now() - job.updatedAt) / 1000) };
  if (job.status === 'done' && job.levelId) {
    const payload = getLevelPayload(job.levelId) ?? getDemoPayload(job.levelId) ?? await loadLevelPayload(job.levelId);
    if (payload) return NextResponse.json({ ...base, level: payload });
    return NextResponse.json({ ...base, levelId: job.levelId });
  }
  return NextResponse.json(base);
}
