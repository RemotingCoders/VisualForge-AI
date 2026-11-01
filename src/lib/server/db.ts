import { randomUUID } from 'node:crypto';
import { getServiceClient, publicStorageUrl } from './supabase';
import { recordSpend } from './spend';
import { dataUrlToBuffer } from './imageOps';
import type { Difference, Mode } from '../engine/types';

/** Supabase persistence for jobs / levels / differences / images / ai_calls.
 *  All writes are best-effort: a DB failure must never break generation (logged, swallowed).
 *  Tables: visualforge_* (prefixed for the shared database). RLS is deny-by-default;
 *  this server client uses the service role. */

/** A missing column (migration not applied yet) is an operator heads-up, not a
 *  per-level event: log it ONCE per process instead of once per generated level. */
const warnedOnce = new Set<string>();
export function warnOnce(key: string, message: string): void {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  console.info(message);
}

export interface JobSnapshot {
  id: string; status: string; stage: string; mode: Mode; isMock: boolean;
  error?: string; requestedChanges?: number; createdAt: number; updatedAt: number;
}

export async function persistJob(job: JobSnapshot): Promise<void> {
  const sb = getServiceClient(); if (!sb) return;
  try {
    await sb.from('visualforge_generation_jobs').upsert({
      id: job.id, mode: job.mode, status: job.status, stage: job.stage,
      requested_changes: job.requestedChanges ?? 7, is_mock: job.isMock,
      error: job.error ?? null, updated_at: new Date(job.updatedAt).toISOString(),
    }, { onConflict: 'id' });
  } catch (e) { console.error('[db] persistJob failed:', e); }
}

export async function loadJob(id: string): Promise<(JobSnapshot & { levelId?: string }) | null> {
  const sb = getServiceClient(); if (!sb) return null;
  try {
    const { data, error } = await sb.from('visualforge_generation_jobs').select('*').eq('id', id).single();
    if (error || !data) return null;
    const { data: level } = await sb.from('visualforge_levels').select('id').eq('job_id', id).maybeSingle();
    return {
      id: data.id, status: data.status, stage: data.stage, mode: data.mode, isMock: data.is_mock,
      error: data.error ?? undefined, requestedChanges: data.requested_changes,
      createdAt: Date.parse(data.created_at), updatedAt: Date.parse(data.updated_at),
      levelId: level?.id ?? undefined,
    };
  } catch (e) { console.error('[db] loadJob failed:', e); return null; }
}

export interface PersistLevelArgs {
  differences: Difference[]; original: string; modified: string;
  width: number; height: number; isMock: boolean; mode: Mode; jobId?: string;
  /** VF_THEME_GENERATION: the user's theme and the prompt Muse Image actually used (needs migration 0003). */
  theme?: string; revisedPrompt?: string;
}

/** Upload both images to Storage, insert image/level/difference rows. Returns nothing —
 *  the in-memory store remains the hot path; this is the durable cross-instance copy. */
export async function persistImageLevel(levelId: string, args: PersistLevelArgs): Promise<void> {
  const sb = getServiceClient(); if (!sb) return;
  try {
    const upload = async (bucket: string, name: string, dataUrl: string) => {
      const path = `${levelId}/${name}.png`;
      const { error } = await sb.storage.from(bucket).upload(path, dataUrlToBuffer(dataUrl), { contentType: 'image/png', upsert: true });
      if (error) throw error;
      return `${bucket}/${path}`;
    };
    const origPath = await upload('visualforge-originals', 'original', args.original);
    const modPath = await upload('visualforge-generated', 'modified', args.modified);
    const { data: origRow, error: e1 } = await sb.from('visualforge_images')
      .insert({ storage_path: origPath, width: args.width, height: args.height, source: args.theme ? 'generated' : (args.isMock ? 'mock' : 'upload') }).select('id').single();
    if (e1 || !origRow) throw e1 ?? new Error('original image row failed');
    const { data: modRow, error: e2 } = await sb.from('visualforge_images')
      .insert({ storage_path: modPath, width: args.width, height: args.height, source: 'generated' }).select('id').single();
    if (e2 || !modRow) throw e2 ?? new Error('modified image row failed');
    const levelRow = {
      id: levelId, job_id: args.jobId ?? null, original_image_id: origRow.id, modified_image_id: modRow.id,
      mode: args.mode, is_mock: args.isMock, published: true,
    };
    // The generated Database types predate migration 0003 (theme/revised_prompt):
    // assert the pre-0003 row shape — the extra properties still travel at runtime,
    // and a pre-0003 database errors the insert so we retry without them below.
    const themedRow = { ...levelRow, theme: args.theme, revised_prompt: args.revisedPrompt ?? null } as typeof levelRow;
    let e3 = (await sb.from('visualforge_levels').insert(args.theme ? themedRow : levelRow)).error;
    if (e3 && args.theme) // pre-0003 database without theme columns — persist without them
      e3 = (await sb.from('visualforge_levels').insert(levelRow)).error;
    if (e3) throw e3;
    if (args.differences.length) {
      const baseRows = args.differences.map(d => ({
        id: randomUUID(), level_id: levelId, type: d.type, description: d.description,
        bbox: d.bbox, bbox_normalized: d.bbox_normalized, mask_url: d.mask_url,
        severity: d.severity, verification_status: d.verification_status, verifier_notes: d.verifier_notes,
        centroid: d.centroid ?? null,
      }));
      // hints/difficulty need migration 0004 and the QC classification columns need
      // 0005: on an older database the wider insert errors and we retry narrower
      // (same pattern as theme columns on levels). Missing-column fallbacks are
      // logged once per process (warnOnce), not once per level.
      const hintedRows = baseRows.map((r, i) => ({ ...r, hints: args.differences[i].hints ?? null, difficulty: args.differences[i].difficulty ?? null }));
      const fullRows = hintedRows.map((r, i) => ({
        ...r,
        classified_type: args.differences[i].classifiedType ?? null,
        classified_severity: args.differences[i].classifiedSeverity ?? null,
        classification_confidence: args.differences[i].classificationConfidence ?? null,
        classification_label: args.differences[i].classificationLabel ?? null,
      }));
      let e4 = (await sb.from('visualforge_differences').insert(fullRows)).error;
      if (e4) { warnOnce('diff-classification-columns', `[db] difference classification columns not persisted (migration 0005 not applied?) — retrying without them`); e4 = (await sb.from('visualforge_differences').insert(hintedRows)).error; }
      if (e4) { warnOnce('diff-hint-columns', `[db] difference hints/difficulty not persisted (migration 0004 not applied?) — retrying with base rows`); e4 = (await sb.from('visualforge_differences').insert(baseRows)).error; }
      if (e4) throw e4;
    }
    console.info(`[db] level ${levelId} persisted (${args.differences.length} differences)`);
  } catch (e) { console.error('[db] persistImageLevel failed:', e); }
}

/** Capability 2, background hints: the level is published BEFORE its Spark hints
 *  exist (they are written in the background so play can start immediately), so the
 *  hints/difficulty land as a later UPDATE. Difference rows carry fresh UUIDs (see
 *  persistImageLevel), so rows are matched by level + description + type. Pre-0004
 *  databases reject the update — logged once, not an error: /api/hint then keeps
 *  serving provisional positional hints for DB-loaded levels. */
export async function persistDifferenceHints(levelId: string, differences: Difference[]): Promise<void> {
  const sb = getServiceClient(); if (!sb) return;
  try {
    for (const d of differences) {
      if (!d.hints?.length && d.difficulty === undefined) continue;
      const { error } = await sb.from('visualforge_differences')
        .update({ hints: d.hints ?? null, difficulty: d.difficulty ?? null })
        .eq('level_id', levelId).eq('description', d.description).eq('type', d.type);
      if (error) { warnOnce('diff-hints-update', `[db] difference hints not persisted for level ${levelId}: ${error.message} (migration 0004 not applied?)`); return; }
    }
    console.info(`[db] hints persisted for level ${levelId} (${differences.length} differences)`);
  } catch (e) { console.error('[db] persistDifferenceHints failed:', e); }
}

/** AI-inspector detectability (migration 0006): accumulated per difference over
 *  Spark challenges, written after each challenge. Rows are matched by level +
 *  description + type (difference rows carry fresh UUIDs — same as hints). */
export async function persistDetectability(levelId: string, differences: Difference[]): Promise<void> {
  const sb = getServiceClient(); if (!sb) return;
  try {
    for (const d of differences) {
      if (d.aiChallenges === undefined) continue;
      const { error } = await sb.from('visualforge_differences')
        .update({
          detectability: d.detectability ?? null, ai_challenges: d.aiChallenges, ai_hits: d.aiHits ?? 0,
          ai_found_modes: d.aiFoundModes?.length ? d.aiFoundModes.join(',') : null,
        })
        .eq('level_id', levelId).eq('description', d.description).eq('type', d.type);
      if (error) { warnOnce('diff-detectability-update', `[db] difference detectability not persisted for level ${levelId}: ${error.message} (migration 0006 not applied?)`); return; }
    }
  } catch (e) { console.error('[db] persistDetectability failed:', e); }
}

/** QC trainer session (recorded at Reveal & score): mirrors the in-memory record. */
export async function persistQcSession(levelId: string, s: { correct: number; missed: number; falsePositives: number; accuracy: number; durationSec: number }): Promise<void> {
  const sb = getServiceClient(); if (!sb) return;
  try {
    const { error } = await sb.from('visualforge_qc_sessions').insert({
      level_id: levelId, correct: s.correct, missed: s.missed,
      false_positives: s.falsePositives, accuracy: s.accuracy, duration_sec: s.durationSec,
    });
    if (error) { warnOnce('qc-session-insert', `[db] QC session not persisted: ${error.message}`); return; }
    console.info(`[db] QC session saved for level ${levelId}: correct=${s.correct} missed=${s.missed} falsePositives=${s.falsePositives} accuracy=${s.accuracy.toFixed(2)} duration=${s.durationSec}s`);
  } catch (e) { console.error('[db] persistQcSession failed:', e); }
}

const rowToDifference = (r: Record<string, unknown>): Difference => ({
  id: String(r.id), type: String(r.type), description: String(r.description),
  bbox: r.bbox as Difference['bbox'], bbox_normalized: r.bbox_normalized as Difference['bbox_normalized'],
  mask_url: (r.mask_url as string | null) ?? null,
  centroid: (r.centroid as Difference['centroid']) ?? undefined,
  severity: (r.severity as Difference['severity']) ?? 'medium',
  verification_status: (r.verification_status as Difference['verification_status']) ?? 'needs_review',
  verifier_notes: String(r.verifier_notes ?? ''),
  // Capability 2 (migration 0004): absent on pre-0004 rows.
  hints: Array.isArray(r.hints) ? (r.hints as string[]) : undefined,
  difficulty: typeof r.difficulty === 'number' ? r.difficulty : undefined,
  // QC classification (migration 0005): absent on pre-0005 rows.
  classifiedType: typeof r.classified_type === 'string' ? r.classified_type : undefined,
  classifiedSeverity: typeof r.classified_severity === 'number' ? r.classified_severity : undefined,
  classificationConfidence: typeof r.classification_confidence === 'number' ? r.classification_confidence : undefined,
  classificationLabel: typeof r.classification_label === 'string' ? r.classification_label : undefined,
  // AI-inspector detectability (migration 0006): absent on pre-0006 rows.
  detectability: typeof r.detectability === 'number' ? r.detectability : undefined,
  aiChallenges: typeof r.ai_challenges === 'number' ? r.ai_challenges : undefined,
  aiHits: typeof r.ai_hits === 'number' ? r.ai_hits : undefined,
  aiFoundModes: typeof r.ai_found_modes === 'string' && r.ai_found_modes ? r.ai_found_modes.split(',') : undefined,
});

export async function loadDifferences(levelId: string): Promise<Difference[] | null> {
  const sb = getServiceClient(); if (!sb) return null;
  try {
    let res = await sb.from('visualforge_differences').select('*').eq('level_id', levelId);
    if (res.error) // pre-0002 database without centroid column — retry without it
      res = await sb.from('visualforge_differences').select('id,type,description,bbox,bbox_normalized,mask_url,severity,verification_status,verifier_notes').eq('level_id', levelId);
    if (res.error || !res.data) return null;
    return res.data.map(rowToDifference);
  } catch (e) { console.error('[db] loadDifferences failed:', e); return null; }
}

export async function loadLevelPayload(levelId: string) {
  const sb = getServiceClient(); if (!sb) return null;
  try {
    const { data: level, error } = await sb.from('visualforge_levels').select('*').eq('id', levelId).single();
    if (error || !level) return null;
    const { data: imgs } = await sb.from('visualforge_images').select('*').in('id', [level.original_image_id, level.modified_image_id]);
    const orig = imgs?.find(i => i.id === level.original_image_id);
    const mod = imgs?.find(i => i.id === level.modified_image_id);
    if (!orig || !mod) return null;
    const { count } = await sb.from('visualforge_differences').select('id', { count: 'exact', head: true }).eq('level_id', levelId);
    return {
      levelId, original: publicStorageUrl(orig.storage_path), modified: publicStorageUrl(mod.storage_path),
      width: orig.width, height: orig.height, total: count ?? 0, isMock: level.is_mock, mode: level.mode as Mode,
      theme: (level as { theme?: string | null }).theme ?? undefined, revisedPrompt: (level as { revised_prompt?: string | null }).revised_prompt ?? undefined,
    };
  } catch (e) { console.error('[db] loadLevelPayload failed:', e); return null; }
}

/** Global daily credit guard source: number of generation jobs created TODAY,
 *  counted from visualforge_generation_jobs (durable across server instances —
 *  the in-memory count resets on every restart/redeploy). Returns null when
 *  Supabase is unavailable so the caller can fall back to the in-memory count. */
export async function countJobsToday(): Promise<number | null> {
  const sb = getServiceClient(); if (!sb) return null;
  try {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const { count, error } = await sb.from('visualforge_generation_jobs')
      .select('id', { count: 'exact', head: true }).gte('created_at', start.toISOString());
    if (error) return null;
    return count ?? 0;
  } catch (e) { console.error('[db] countJobsToday failed:', e); return null; }
}

export interface GalleryLevel {
  levelId: string; original: string; total: number; mode: Mode; isMock: boolean; theme?: string;
}

/** The level gallery: the most recent PUBLISHED levels (newest first), with the
 *  ORIGINAL image as thumbnail. Playing one loads its stored images — it never
 *  generates anything. Empty list when Supabase is not configured. `mode` filters
 *  server-side so QC examples never fall out of the game levels' top-N window. */
export async function listPublishedLevels(limit = 12, mode?: Mode): Promise<GalleryLevel[]> {
  const sb = getServiceClient(); if (!sb) return [];
  try {
    let query = sb.from('visualforge_levels')
      .select('id, mode, is_mock, theme, original_image_id, created_at')
      .eq('published', true).order('created_at', { ascending: false }).limit(limit);
    if (mode) query = query.eq('mode', mode);
    const { data: levels, error } = await query;
    if (error || !levels?.length) return [];
    const { data: imgs } = await sb.from('visualforge_images').select('id, storage_path')
      .in('id', levels.map(l => l.original_image_id as string));
    const out: GalleryLevel[] = [];
    for (const l of levels) {
      const orig = imgs?.find(i => i.id === l.original_image_id);
      if (!orig) continue;
      const { count } = await sb.from('visualforge_differences').select('id', { count: 'exact', head: true }).eq('level_id', l.id as string);
      out.push({
        levelId: l.id as string, original: publicStorageUrl(orig.storage_path as string),
        total: count ?? 0, mode: l.mode as Mode, isMock: Boolean(l.is_mock),
        theme: (l as { theme?: string | null }).theme ?? undefined,
      });
    }
    return out;
  } catch (e) { console.error('[db] listPublishedLevels failed:', e); return []; }
}

/** Every real Meta call lands in visualforge_ai_calls with its REAL estimated cost
 *  (src/lib/engine/pricing.ts, verified on dev.meta.ai: Spark per token from the
 *  response usage, SAM per image, Muse Image per returned image). The row feeds
 *  the VF_SPEND_CAP_USD budget sum; recordSpend mirrors it into the in-memory
 *  ledger that stands in when Supabase is not configured. */
export async function logAiCall(model: string, operation: string, latencyMs: number, isMock = false, estimatedCostUsd = 0): Promise<void> {
  if (!isMock) recordSpend(estimatedCostUsd);
  const sb = getServiceClient(); if (!sb) return;
  try { await sb.from('visualforge_ai_calls').insert({ model, operation, latency_ms: Math.round(latencyMs), is_mock: isMock, estimated_cost_usd: estimatedCostUsd }); }
  catch (e) { console.error('[db] logAiCall failed:', e); }
}
