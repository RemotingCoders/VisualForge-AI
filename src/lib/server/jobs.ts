import { enforceSpacing, maskToBBox, normalizeBBox } from '../engine/geometry';
import type { Providers, Mode, Difference, Region } from '../engine/types';
import { normalizeImage, cropDataUrl, expandBox, compositeCrop, diffMask, providerImage, clampBox } from './imageOps';
import { saveImageLevel } from '../serverStore';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';
/** Differences must stay SMALL, localized and subtle: candidate regions are shrunk to at most
 *  this fraction of the image side, and a measured diff larger than MEASURED_CAP is discarded.
 *  MEASURED_CAP must exceed region cap x crop expansion (0.10 x 1.5 = 0.15) or every
 *  max-size change is discarded by construction. */
export const MAX_REGION_FRACTION = 0.1;
export const MAX_MEASURED_FRACTION = 0.17;
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
  const setStage = (s: string) => { job.stage = s; job.updatedAt = Date.now(); console.info(`[generate ${job.id}] stage: ${s}`); };
  try {
    job.status = 'running';
    setStage('normalizing');
    const img = await normalizeImage(imageDataUrl, 1024);
    const { width, height } = img;
    let current = img.dataUrl;
    const aiImg = await providerImage(img.dataUrl); // light JPEG twin for API calls (same dimensions)

    setStage('moderating');
    const mod = await providers.vision.moderate(aiImg);
    if (!mod.ok) throw new Error(`moderation rejected: ${mod.reason}`);

    setStage('segmenting');
    const rawRegions = await providers.segmentation.segment(aiImg, width, height);
    // Size cap: shrink oversized regions (centered) instead of discarding them — a whole-scene
    // SAM box would otherwise let Muse repaint most of the photo (spike call 4/6 failure mode),
    // while plain discarding can leave too few candidates on photos with only large objects.
    const capW = Math.max(8, Math.floor(width * MAX_REGION_FRACTION));
    const capH = Math.max(8, Math.floor(height * MAX_REGION_FRACTION));
    const capRegion = (r: Region): Region => {
      if (r.bbox.width <= capW && r.bbox.height <= capH) return r;
      const w = Math.min(r.bbox.width, capW), h = Math.min(r.bbox.height, capH);
      const cx = r.bbox.x + r.bbox.width / 2, cy = r.bbox.y + r.bbox.height / 2;
      return { ...r, bbox: clampBox({ x: cx - w / 2, y: cy - h / 2, width: w, height: h }, width, height) };
    };
    const regions = enforceSpacing(rawRegions.map(capRegion));
    if (!regions.length) throw new Error('segmentation found no usable regions');

    setStage('planning');
    const plan = (await providers.vision.plan(aiImg, regions, job.mode, count)).slice(0, count);
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
      const edited = await providers.imageEdit.editMaskedRegion(await providerImage(cropUrl), { id: region.id, bbox: cropBox }, ch.editPrompt);
      const next = await compositeCrop(current, edited, cropBox);
      masks.set(ch.id, await diffMask(current, next, width, height));
      current = next;
    }

    setStage('verifying');
    const vMod = await providerImage(current);
    const differences: Difference[] = [];
    let verifyIdx = 0;
    for (const ch of plan) {
      verifyIdx++;
      const mask = masks.get(ch.id); if (!mask) continue;
      setStage(`verifying ${verifyIdx}/${plan.length}`);
      const bbox = maskToBBox(mask, width, height); if (!bbox) continue;
      if (bbox.width > width * MAX_MEASURED_FRACTION || bbox.height > height * MAX_MEASURED_FRACTION) {
        console.info(`[generate ${job.id}] change ${ch.id} discarded: measured diff ${bbox.width}x${bbox.height} exceeds size cap`);
        continue;
      }
      let verdict = await providers.vision.verify(aiImg, vMod, ch, bbox);
      if (!verdict.ok) verdict = await providers.vision.verify(aiImg, vMod, ch, bbox); // retry ONCE
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
    job.status = 'failed'; job.error = e instanceof Error ? e.message : String(e); job.updatedAt = Date.now(); // keep job.stage = where it failed
    console.error(`[generate ${job.id}] FAILED at stage "${job.stage}":`, e);
  }
}
