import { randomUUID } from 'node:crypto';
import { getServiceClient, publicStorageUrl } from './supabase';
import { dataUrlToBuffer } from './imageOps';
import type { Difference, Mode } from '../engine/types';

/** Supabase persistence for jobs / levels / differences / images / ai_calls.
 *  All writes are best-effort: a DB failure must never break generation (logged, swallowed).
 *  Tables: visualforge_* (prefixed for the shared database). RLS is deny-by-default;
 *  this server client uses the service role. */

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
      .insert({ storage_path: origPath, width: args.width, height: args.height, source: args.isMock ? 'mock' : 'upload' }).select('id').single();
    if (e1 || !origRow) throw e1 ?? new Error('original image row failed');
    const { data: modRow, error: e2 } = await sb.from('visualforge_images')
      .insert({ storage_path: modPath, width: args.width, height: args.height, source: 'generated' }).select('id').single();
    if (e2 || !modRow) throw e2 ?? new Error('modified image row failed');
    const { error: e3 } = await sb.from('visualforge_levels').insert({
      id: levelId, job_id: args.jobId ?? null, original_image_id: origRow.id, modified_image_id: modRow.id,
      mode: args.mode, is_mock: args.isMock, published: true,
    });
    if (e3) throw e3;
    if (args.differences.length) {
      const rows = args.differences.map(d => ({
        id: randomUUID(), level_id: levelId, type: d.type, description: d.description,
        bbox: d.bbox, bbox_normalized: d.bbox_normalized, mask_url: d.mask_url,
        severity: d.severity, verification_status: d.verification_status, verifier_notes: d.verifier_notes,
        centroid: d.centroid ?? null,
      }));
      const { error: e4 } = await sb.from('visualforge_differences').insert(rows);
      if (e4) throw e4;
    }
    console.info(`[db] level ${levelId} persisted (${args.differences.length} differences)`);
  } catch (e) { console.error('[db] persistImageLevel failed:', e); }
}

const rowToDifference = (r: Record<string, unknown>): Difference => ({
  id: String(r.id), type: String(r.type), description: String(r.description),
  bbox: r.bbox as Difference['bbox'], bbox_normalized: r.bbox_normalized as Difference['bbox_normalized'],
  mask_url: (r.mask_url as string | null) ?? null,
  centroid: (r.centroid as Difference['centroid']) ?? undefined,
  severity: (r.severity as Difference['severity']) ?? 'medium',
  verification_status: (r.verification_status as Difference['verification_status']) ?? 'needs_review',
  verifier_notes: String(r.verifier_notes ?? ''),
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
      width: orig.width, height: orig.height, total: count ?? 0, isMock: level.is_mock,
    };
  } catch (e) { console.error('[db] loadLevelPayload failed:', e); return null; }
}

/** Every real Meta call lands in visualforge_ai_calls (cost read from Meta dashboard; API returns none). */
export async function logAiCall(model: string, operation: string, latencyMs: number, isMock = false): Promise<void> {
  const sb = getServiceClient(); if (!sb) return;
  try { await sb.from('visualforge_ai_calls').insert({ model, operation, latency_ms: Math.round(latencyMs), is_mock: isMock }); }
  catch (e) { console.error('[db] logAiCall failed:', e); }
}
