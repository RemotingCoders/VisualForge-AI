import { randomUUID } from 'node:crypto';
import { enforceSpacing, maskToBBox, maskCentroid, normalizeBBox } from '../engine/geometry';
import type { Providers, Mode, Difference, Region } from '../engine/types';
import { normalizeImage, cropDataUrl, expandBox, diffMask, providerImage, clampBox, recolorCrop, squareContextBox, compositeMaskedEdit, alignmentCheck, cropColorStats, colorDeltaE, targetHueFromColor } from './imageOps';
import { saveImageLevel } from '../serverStore';
import { persistJob, loadJob } from './db';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';
/** Differences must stay SMALL, localized and subtle: candidate regions are shrunk to at most
 *  this fraction of the image side, and a measured diff larger than MEASURED_CAP is discarded.
 *  MEASURED_CAP must exceed region cap x crop expansion (0.10 x 1.5 = 0.15) or every
 *  max-size change is discarded by construction. */
export const MAX_REGION_FRACTION = 0.1;
export const MAX_MEASURED_FRACTION = 0.17;
export interface Job {
  id: string; status: JobStatus; stage: string; mode: Mode; isMock: boolean;
  error?: string; levelId?: string; requestedChanges?: number; createdAt: number; updatedAt: number;
}
const g = globalThis as unknown as { __vfJobs?: Map<string, Job> };
if (!g.__vfJobs) g.__vfJobs = new Map();
export const getJob = (id: string) => g.__vfJobs!.get(id) ?? null;
/** Memory first; on a miss (e.g. another server instance on Vercel) read through from Supabase. */
export async function resolveJob(id: string): Promise<Job | null> {
  const mem = getJob(id); if (mem) return mem;
  const row = await loadJob(id); if (!row) return null;
  const job: Job = { ...row, status: row.status as JobStatus };
  g.__vfJobs!.set(job.id, job);
  return job;
}
export const jobsToday = () => { const day = new Date().toDateString(); return [...g.__vfJobs!.values()].filter(j => new Date(j.createdAt).toDateString() === day).length; };
export function createJob(mode: Mode, isMock: boolean, requestedChanges?: number): Job {
  const job: Job = { id: randomUUID(), status: 'queued', stage: 'queued', mode, isMock, requestedChanges, createdAt: Date.now(), updatedAt: Date.now() };
  g.__vfJobs!.set(job.id, job);
  void persistJob(job);
  return job;
}

/**
 * Real generation loop (spike-validated 2026-10-29): moderate -> Spark concepts -> SAM ->
 * Spark plan -> per change: crop+margin -> Muse edit crop (1600px WebP) -> resize back ->
 * feathered composite -> REAL mask from pixel diff -> Spark verify (retry once, else needs_review).
 * Providers are injected so the whole loop is testable offline with fakes — no paid calls in tests.
 */
export async function runGeneration(job: Job, imageDataUrl: string, count: number, providers: Providers): Promise<void> {
  const setStage = (s: string) => { job.stage = s; job.updatedAt = Date.now(); console.info(`[generate ${job.id}] stage: ${s}`); void persistJob(job); };
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
      // wholeObject=false marks a center-cut FRAGMENT of a larger object: usable for color
      // changes only. Removing/replacing a fragment is what makes objects look "broken/split".
      if (r.bbox.width <= capW && r.bbox.height <= capH) return { ...r, wholeObject: true };
      const w = Math.min(r.bbox.width, capW), h = Math.min(r.bbox.height, capH);
      const cx = r.bbox.x + r.bbox.width / 2, cy = r.bbox.y + r.bbox.height / 2;
      return { ...r, bbox: clampBox({ x: cx - w / 2, y: cy - h / 2, width: w, height: h }, width, height), wholeObject: false };
    };
    const regions = enforceSpacing(rawRegions.map(capRegion));
    if (!regions.length) throw new Error('segmentation found no usable regions');

    setStage('planning');
    const planned = (await providers.vision.plan(aiImg, regions, job.mode, count)).slice(0, count);
    if (!planned.length) throw new Error('planner returned no changes');
    // Hard rule (GAME mode only): remove/replace on a FRAGMENT makes objects look broken,
    // so downgrade those to a color change. In QC mode this must NOT apply — scratch/crack/
    // dent defects are intentionally localized ON a fragment of a part.
    const plan = planned.map(ch => {
      const r = regions.find(x => x.id === ch.regionId);
      return job.mode === 'game' && r && r.wholeObject === false && !/colou?r/i.test(ch.type) ? { ...ch, type: 'change color' } : ch;
    });

    // --- Per-change edit -> measure -> verify (E: no identical verifier retry — a failed
    // verification re-edits ONCE with Muse, then discards. Deterministic color changes are
    // verified locally with ΔE + mask, never via Spark.)
    type Candidate = { next: string; mask: boolean[]; bbox: NonNullable<ReturnType<typeof maskToBBox>>; local: boolean; notes: string };
    const measuredOk = (bbox: Candidate['bbox']) => bbox.width <= width * MAX_MEASURED_FRACTION && bbox.height <= height * MAX_MEASURED_FRACTION;

    const applyMuse = async (base: string, ch: (typeof plan)[number], region: Region, prompt: string): Promise<Candidate | null> => {
      // A: square CONTEXT box to Muse; separate smaller PASTE box (object + small margin).
      const contextBox = squareContextBox(region.bbox, width, height);
      const pasteBox = expandBox(region.bbox, 0.15, width, height);
      const { cropDataUrl: contextCrop } = await cropDataUrl(base, contextBox);
      const prompts = [prompt, `${prompt} Keep the exact same camera position, framing, scale and alignment as the input image; do not shift, zoom, crop or reframe.`];
      for (let attempt = 0; attempt < prompts.length; attempt++) {
        const edited = await providers.imageEdit.editMaskedRegion(await providerImage(contextCrop), { id: region.id, bbox: { x: pasteBox.x - contextBox.x, y: pasteBox.y - contextBox.y, width: pasteBox.width, height: pasteBox.height } }, prompts[attempt]);
        // C: measurable alignment guard BEFORE pasting — reject shifted/reframed edits.
        const align = await alignmentCheck(contextCrop, edited, { x: pasteBox.x - contextBox.x, y: pasteBox.y - contextBox.y, width: pasteBox.width, height: pasteBox.height });
        if (!align.aligned) {
          console.info(`[generate ${job.id}] change ${ch.id} attempt ${attempt + 1} rejected by alignment guard (shift ${align.shiftX},${align.shiftY}px, ring error ${align.error.toFixed(1)})`);
          continue;
        }
        // B: mask composition from large diff components inside the paste box only.
        const next = await compositeMaskedEdit(base, edited, contextBox, pasteBox);
        const mask = await diffMask(base, next, width, height);
        const bbox = maskToBBox(mask, width, height);
        if (!bbox || !measuredOk(bbox)) continue;
        return { next, mask, bbox, local: false, notes: '' };
      }
      return null;
    };

    const applyLocalRecolor = async (base: string, ch: (typeof plan)[number], region: Region): Promise<Candidate | null> => {
      // D: recolor ONLY the object's own bbox pixels (never the expanded context), in OKLCH.
      const { cropDataUrl: objCrop } = await cropDataUrl(base, region.bbox);
      const stats = await cropColorStats(objCrop);
      const targetHue = targetHueFromColor(ch.targetColor);
      if (ch.targetColor && targetHue === null) return null; // achromatic/unknown target (white/gray/black) -> Muse
      if (stats.meanChroma < 0.04 || stats.saturatedFraction < 0.15) return null; // low-chroma object: no hue rotation -> Muse
      const shifts = [105, 145, -105, -145, 180];
      const shift = shifts[[...ch.id].reduce((a, c) => a + c.charCodeAt(0), 0) % shifts.length];
      const recolored = await recolorCrop(objCrop, shift, targetHue ?? undefined);
      const next = await compositeMaskedEdit(base, recolored, region.bbox, region.bbox);
      const mask = await diffMask(base, next, width, height);
      const bbox = maskToBBox(mask, width, height);
      if (!bbox || !measuredOk(bbox)) return null;
      // E: local verification (ΔE + changed mask) — no Spark call for deterministic colors.
      const delta = await colorDeltaE(base, next, width, height);
      if (delta.changedPixels < 30 || delta.meanDeltaE < 0.05) return null;
      return { next, mask, bbox, local: true, notes: `local OKLCH verify: ΔE ${delta.meanDeltaE.toFixed(3)} over ${delta.changedPixels}px (no Spark call)` };
    };

    const differences: Difference[] = [];
    let idx = 0;
    for (const ch of plan) {
      idx++;
      const region = regions.find(r => r.id === ch.regionId);
      if (!region) continue;
      setStage(`editing ${idx}/${plan.length}`);
      const isColor = /colou?r/i.test(ch.type);
      let candidate = isColor ? await applyLocalRecolor(current, ch, region) : null;
      if (!candidate) candidate = await applyMuse(current, ch, region, ch.editPrompt);
      if (!candidate) { console.info(`[generate ${job.id}] change ${ch.id} discarded: no aligned, measurable edit`); continue; }

      let notes = candidate.notes;
      if (!candidate.local) {
        setStage(`verifying ${idx}/${plan.length}`);
        let verdict = await providers.vision.verify(aiImg, await providerImage(candidate.next), ch, candidate.bbox);
        if (!verdict.ok) {
          // E: re-edit ONCE (never re-ask the verifier the same question), then discard.
          const retry = await applyMuse(current, ch, region, `${ch.editPrompt} The previous attempt failed verification (${verdict.notes}); apply the change more clearly and realistically, confined to the same object.`);
          if (retry) {
            verdict = await providers.vision.verify(aiImg, await providerImage(retry.next), ch, retry.bbox);
            if (verdict.ok) candidate = retry;
          }
          if (!verdict.ok) { console.info(`[generate ${job.id}] change ${ch.id} discarded after re-edit: ${verdict.notes}`); continue; }
        }
        notes = verdict.notes;
      }
      differences.push({
        id: ch.id, type: ch.type, description: ch.description, bbox: candidate.bbox, bbox_normalized: normalizeBBox(candidate.bbox, width, height),
        centroid: maskCentroid(candidate.mask, width, height) ?? { x: candidate.bbox.x + candidate.bbox.width / 2, y: candidate.bbox.y + candidate.bbox.height / 2 },
        mask_url: null, severity: ch.severity ?? 'medium',
        verification_status: 'verified', verifier_notes: notes,
      });
      current = candidate.next;
    }
    if (!differences.length) throw new Error('no change survived measurement/verification');

    job.levelId = saveImageLevel({ differences, original: img.dataUrl, modified: current, width, height, isMock: providers.segmentation.isMock, mode: job.mode, jobId: job.id });
    job.status = 'done'; setStage('done');
  } catch (e) {
    job.status = 'failed'; job.error = e instanceof Error ? e.message : String(e); job.updatedAt = Date.now(); void persistJob(job); // keep job.stage = where it failed
    console.error(`[generate ${job.id}] FAILED at stage "${job.stage}":`, e);
  }
}
