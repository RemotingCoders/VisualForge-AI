import { enforceSpacing, maskToBBox, normalizeBBox } from '../engine/geometry';
import type { Providers, Mode, Difference } from '../engine/types';
import { normalizeImage, cropDataUrl, expandBox, compositeCrop, diffMask } from './imageOps';
import { saveImageLevel } from '../serverStore';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';
export interface Job {
  id: string; status: JobStatus; stage: string; mode: Mode; isMock: boolean;
  error?: string; levelId?: string; createdAt: number; updatedAt: number;
}
const g = globalThis as unknown as { __vfJobs?: Map<string, Job> };
if (!g.__vfJobs) g.__vfJobs = new Map();
export const getJob = (id: string) => g.__vfJobs!.get(id) ?? null;
export const jobsToday = () => { const day = new Date().toDateString(); return [...g.__vfJobs!.values()].filter(j => new Date(j.createdAt).toDateString() === day).length; };
export function createJob(mode: Mode, isMock: boolean): Job {
  const job: Job = { id: `job-${Math.random().toString(36).slice(2, 10)}`, status: 'queued', stage: 'queued', mode, isMock, createdAt: Date.now(), updatedAt: Date.now() };
  g.__vfJobs!.set(job.id, job);
  return job;
}

/**
 * Real generation loop (spike-validated 2026-10-29): moderate -> Spark concepts -> SAM ->
 * Spark plan -> per change: crop+margin -> Muse edit crop (1600px WebP) -> resize back ->
 * feathered composite -> REAL mask from pixel diff -> Spark verify (retry once, else needs_review).
 * Providers are injected so the whole loop is testable offline with fakes — no paid calls in tests.
 */
export async function runGeneration(job: Job, imageDataUrl: string, count: number, providers: Providers): Promise<void> {
  const setStage = (s: string) => { job.stage = s; job.updatedAt = Date.now(); };
  try {
    job.status = 'running';
    setStage('normalizing');
    const img = await normalizeImage(imageDataUrl, 1024);
    const { width, height } = img;
    let current = img.dataUrl;

    setStage('moderating');
    const mod = await providers.vision.moderate(current);
    if (!mod.ok) throw new Error(`moderation rejected: ${mod.reason}`);

    setStage('segmenting');
    const regions = enforceSpacing(await providers.segmentation.segment(current, width, height));
    if (!regions.length) throw new Error('segmentation found no usable regions');

    setStage('planning');
    const plan = (await providers.vision.plan(current, regions, job.mode, count)).slice(0, count);
    if (!plan.length) throw new Error('planner returned no changes');

    setStage('editing');
    const masks = new Map<string, boolean[]>();
    let editIdx = 0;
    for (const ch of plan) {
      editIdx++;
      const region = regions.find(r => r.id === ch.regionId);
      if (!region) continue;
      setStage(`editing ${editIdx}/${plan.length}`);
      const cropBox = expandBox(region.bbox, 0.25, width, height);
      const { cropDataUrl: cropUrl } = await cropDataUrl(current, cropBox);
      const edited = await providers.imageEdit.editMaskedRegion(cropUrl, { id: region.id, bbox: cropBox }, ch.editPrompt);
      const next = await compositeCrop(current, edited, cropBox);
      masks.set(ch.id, await diffMask(current, next, width, height));
      current = next;
    }

    setStage('verifying');
    const differences: Difference[] = [];
    let verifyIdx = 0;
    for (const ch of plan) {
      verifyIdx++;
      const mask = masks.get(ch.id); if (!mask) continue;
      setStage(`verifying ${verifyIdx}/${plan.length}`);
      const bbox = maskToBBox(mask, width, height); if (!bbox) continue;
      let verdict = await providers.vision.verify(img.dataUrl, current, ch, bbox);
      if (!verdict.ok) verdict = await providers.vision.verify(img.dataUrl, current, ch, bbox); // retry ONCE
      differences.push({
        id: ch.id, type: ch.type, description: ch.description, bbox, bbox_normalized: normalizeBBox(bbox, width, height),
        mask_url: null, severity: ch.severity ?? 'medium',
        verification_status: verdict.ok ? 'verified' : 'needs_review', verifier_notes: verdict.notes,
      });
    }
    if (!differences.length) throw new Error('no change survived measurement/verification');

    job.levelId = saveImageLevel({ differences, original: img.dataUrl, modified: current, width, height, isMock: providers.segmentation.isMock });
    job.status = 'done'; setStage('done');
  } catch (e) {
    job.status = 'failed'; job.error = e instanceof Error ? e.message : String(e); setStage('failed');
  }
}
