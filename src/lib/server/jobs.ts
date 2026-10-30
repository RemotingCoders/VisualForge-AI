import { randomUUID } from 'node:crypto';
import { enforceSpacing, maskToBBox, maskCentroid, normalizeBBox } from '../engine/geometry';
import type { Providers, Mode, Difficulty, Difference, Region } from '../engine/types';
import { normalizeImage, cropDataUrl, expandBox, diffMask, providerImage, clampBox, recolorCrop, squareContextBox, compositeMaskedEdit, estimateAlignment, alignEditedCrop, ALIGNMENT_MAX_RESIDUAL, cropColorStats, colorDeltaE, targetHueFromColor, cropDominantHue, transformObjectInPaste, duplicateObjectInPaste, type LocalTransformKind } from './imageOps';
import { saveImageLevel } from '../serverStore';
import { persistJob, loadJob } from './db';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';
/** Size criteria are AREA-based, not side-based: a SAM box is a WHOLE object if it occupies
 *  up to 8% of the image area; above that it is center-cropped (aspect preserved) to the area
 *  cap and marked fragment. Measured diffs get a larger area cap (region cap x paste
 *  expansion² ≈ 8% x 1.69 ≈ 13.5%, rounded up) or max-size changes die by construction. */
export const MAX_REGION_AREA_FRACTION = 0.08;
export const MAX_MEASURED_AREA_FRACTION = 0.15;
export interface Job {
  id: string; status: JobStatus; stage: string; mode: Mode; isMock: boolean;
  error?: string; levelId?: string; requestedChanges?: number; difficulty?: Difficulty; createdAt: number; updatedAt: number;
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
export function createJob(mode: Mode, isMock: boolean, requestedChanges?: number, difficulty: Difficulty = 'medium'): Job {
  const job: Job = { id: randomUUID(), status: 'queued', stage: 'queued', mode, isMock, requestedChanges, difficulty, createdAt: Date.now(), updatedAt: Date.now() };
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
    // wholeObject is decided by SAM's box AREA: <= 8% of the image = whole object. Only
    // above that do we center-crop (aspect preserved, scaled to the area cap) and mark it
    // fragment (wholeObject=false: color/add only in game mode — removing, replacing or
    // geometrically transforming a fragment is what made objects look "broken/split").
    const areaCap = width * height * MAX_REGION_AREA_FRACTION;
    const capRegion = (r: Region): Region => {
      if (r.bbox.width * r.bbox.height <= areaCap) return { ...r, wholeObject: true };
      const s = Math.sqrt(areaCap / (r.bbox.width * r.bbox.height));
      const w = Math.max(8, Math.floor(r.bbox.width * s)), h = Math.max(8, Math.floor(r.bbox.height * s));
      const cx = r.bbox.x + r.bbox.width / 2, cy = r.bbox.y + r.bbox.height / 2;
      return { ...r, bbox: clampBox({ x: cx - w / 2, y: cy - h / 2, width: w, height: h }, width, height), wholeObject: false };
    };
    // F: spacing is enforced on the FINAL PASTE boxes (object + 15% margin), not the raw
    // bboxes — expanded paste boxes can overlap even when bboxes don't, and a later paste
    // would re-cover part of an earlier change. (This is also what makes future parallel
    // edits safe.) Context boxes may overlap freely: they are read-only input to Muse.
    const capped = rawRegions.map(capRegion);
    const regions = enforceSpacing(capped.map(r => ({ region: r, bbox: expandBox(r.bbox, 0.15, width, height) }))).map(x => x.region);
    if (!regions.length) throw new Error('segmentation found no usable regions');

    setStage('planning');
    // Ask for MORE candidates than needed (count + 3, priority-ordered, with the variety
    // quota in the planner prompt): the executor walks the list and stops at `count`
    // achieved — discarded candidates no longer sink the whole level.
    const difficulty = job.difficulty ?? 'medium';
    const planned = await providers.vision.plan(aiImg, regions, job.mode, count + 3, difficulty);
    if (!planned.length) throw new Error('planner returned no changes');
    // Hard rule (GAME mode only): remove/replace/geometric transforms on a FRAGMENT make
    // objects look broken, so downgrade those to a color change. "add object" stays: it puts
    // a NEW element in empty space, it does not tear an existing one. In QC mode none of this
    // applies — scratch/crack/dent defects intentionally live ON a fragment of a part.
    const WHOLE_OBJECT_ONLY = /remove|replace|flip|resize|rotate|duplicate/i;
    const plan = planned.map(ch => {
      const r = regions.find(x => x.id === ch.regionId);
      return job.mode === 'game' && r && r.wholeObject === false && WHOLE_OBJECT_ONLY.test(ch.type) ? { ...ch, type: 'change color' } : ch;
    });
    // One line per planned change (post-downgrade) so console logs explain the level's mix.
    for (const ch of plan) {
      const r = regions.find(x => x.id === ch.regionId);
      console.info(`[generate ${job.id}] planned ${ch.id}: type=${ch.type} region=${ch.regionId} label="${r?.label ?? ''}" wholeObject=${r?.wholeObject ?? '?'} targetColor=${ch.targetColor ?? ''}`);
    }

    // --- Per-change edit -> measure -> verify (E: no identical verifier retry — a failed
    // verification re-edits ONCE with Muse, then discards. Deterministic color changes are
    // verified locally with ΔE + mask, never via Spark.)
    type Candidate = { next: string; mask: boolean[]; bbox: NonNullable<ReturnType<typeof maskToBBox>>; local: boolean; notes: string };
    const measuredOk = (bbox: Candidate['bbox']) => bbox.width * bbox.height <= width * height * MAX_MEASURED_AREA_FRACTION;

    // Max 2 Muse calls per change (initial edit + one verifier-driven re-edit); when the
    // budget is exhausted the executor moves on to the next candidate.
    type MuseBudget = { calls: number };
    const applyMuse = async (base: string, ch: (typeof plan)[number], region: Region, prompt: string, budget: MuseBudget): Promise<Candidate | null> => {
      if (budget.calls >= 2) { console.info(`[generate ${job.id}] change ${ch.id} discarded: Muse call budget exhausted (max 2 per change)`); return null; }
      budget.calls++;
      // A: square CONTEXT box to Muse; separate smaller PASTE box (object + small margin).
      const contextBox = squareContextBox(region.bbox, width, height);
      const pasteBox = expandBox(region.bbox, 0.15, width, height);
      const relPaste = { x: pasteBox.x - contextBox.x, y: pasteBox.y - contextBox.y, width: pasteBox.width, height: pasteBox.height };
      const { cropDataUrl: contextCrop } = await cropDataUrl(base, contextBox);
      // ONE Muse call per attempt: a "keep the framing" re-prompt does not change Muse's
      // systematic shift and only doubles cost. Instead the shift/scale is measured and
      // compensated geometrically; rejection happens only on high RESIDUAL error.
      const edited = await providers.imageEdit.editMaskedRegion(await providerImage(contextCrop), { id: region.id, bbox: relPaste }, prompt);
      const est = await estimateAlignment(contextCrop, edited, relPaste);
      console.info(`[generate ${job.id}] change ${ch.id} alignment: shift (${est.shiftX}, ${est.shiftY})px · scale ${est.scale.toFixed(2)} · residual error ${est.error.toFixed(1)}`);
      if (!est.aligned) {
        console.info(`[generate ${job.id}] change ${ch.id} discarded: residual alignment error ${est.error.toFixed(1)} exceeds ${ALIGNMENT_MAX_RESIDUAL} after compensating shift (${est.shiftX}, ${est.shiftY})px scale ${est.scale.toFixed(2)} — edit likely repainted/reframed`);
        return null;
      }
      const alignedEdited = await alignEditedCrop(contextCrop, edited, est);
      // B: mask composition from large diff components inside the paste box only.
      const next = await compositeMaskedEdit(base, alignedEdited, contextBox, pasteBox);
      const mask = await diffMask(base, next, width, height);
      const bbox = maskToBBox(mask, width, height);
      if (!bbox) { console.info(`[generate ${job.id}] change ${ch.id} discarded: no measurable diff after masked composite`); return null; }
      if (!measuredOk(bbox)) { console.info(`[generate ${job.id}] change ${ch.id} discarded: measured diff ${bbox.width}x${bbox.height} (area ${bbox.width * bbox.height}px) exceeds area cap ${Math.floor(width * height * MAX_MEASURED_AREA_FRACTION)}px`); return null; }
      return { next, mask, bbox, local: false, notes: '' };
    };

    const applyLocalRecolor = async (base: string, ch: (typeof plan)[number], region: Region): Promise<Candidate | null> => {
      // D: recolor ONLY the object's own bbox pixels (never the expanded context), in OKLCH.
      const { cropDataUrl: objCrop, cropBox } = await cropDataUrl(base, region.bbox);
      const stats = await cropColorStats(objCrop);
      const targetHue = targetHueFromColor(ch.targetColor);
      if (ch.targetColor && targetHue === null) { console.info(`[generate ${job.id}] change ${ch.id}: local recolor skipped — target color "${ch.targetColor}" has no hue (achromatic/unknown), Muse fallback`); return null; }
      if (stats.saturatedFraction < 0.05) { console.info(`[generate ${job.id}] change ${ch.id}: local recolor skipped — low-chroma object (saturated fraction ${stats.saturatedFraction.toFixed(2)}), Muse fallback`); return null; }
      // Minimum OKLab ΔE of 0.12 against the original: try the planned hue first; if it
      // cannot reach the bar, fall back to the FARTHEST hue from the object's dominant hue.
      const dominantHue = await cropDominantHue(objCrop);
      const shifts = [105, 145, -105, -145, 180];
      const shift = shifts[[...ch.id].reduce((a, c) => a + c.charCodeAt(0), 0) % shifts.length];
      const hueCandidates: (number | undefined)[] = [targetHue ?? undefined];
      if (dominantHue !== null) for (const h of [(dominantHue + 180) % 360, (dominantHue + 120) % 360]) if (!hueCandidates.some(x => x !== undefined && Math.abs(x - h) < 5)) hueCandidates.push(h);
      let best: { recolored: string; meanDeltaE: number; changedPixels: number; hue: number | undefined } | null = null;
      for (const hue of hueCandidates) {
        const recolored = await recolorCrop(objCrop, shift, hue);
        const delta = await colorDeltaE(objCrop, recolored, cropBox.width, cropBox.height);
        if (delta.changedPixels >= 30 && (!best || delta.meanDeltaE > best.meanDeltaE)) best = { recolored, meanDeltaE: delta.meanDeltaE, changedPixels: delta.changedPixels, hue };
      }
      if (!best || best.meanDeltaE < 0.12) { console.info(`[generate ${job.id}] change ${ch.id}: local recolor skipped — best ΔE ${best ? best.meanDeltaE.toFixed(3) : 'n/a'} below 0.12 minimum, Muse fallback`); return null; }
      const next = await compositeMaskedEdit(base, best.recolored, region.bbox, region.bbox);
      const mask = await diffMask(base, next, width, height);
      const bbox = maskToBBox(mask, width, height);
      if (!bbox) { console.info(`[generate ${job.id}] change ${ch.id} discarded: recolor produced no measurable diff`); return null; }
      if (!measuredOk(bbox)) { console.info(`[generate ${job.id}] change ${ch.id} discarded: recolor diff ${bbox.width}x${bbox.height} (area ${bbox.width * bbox.height}px) exceeds area cap ${Math.floor(width * height * MAX_MEASURED_AREA_FRACTION)}px`); return null; }
      // E: local verification (ΔE + changed mask) — no Spark call for deterministic colors.
      return { next, mask, bbox, local: true, notes: `local OKLCH verify: ΔE ${best.meanDeltaE.toFixed(3)} over ${best.changedPixels}px, hue ${best.hue !== undefined ? Math.round(best.hue) + '°' : `shift ${shift}°`} (no Spark call)` };
    };

    const LOCAL_KIND = (type: string): LocalTransformKind | null =>
      /duplicate/i.test(type) ? 'duplicate' : /flip|mirror/i.test(type) ? 'flip' : /resize|scale/i.test(type) ? 'resize' : /rotate/i.test(type) ? 'rotate' : null;

    const applyLocalTransform = async (base: string, ch: (typeof plan)[number], region: Region, kind: LocalTransformKind): Promise<Candidate | null> => {
      // Deterministic geometric change of the WHOLE object, composed with the same masked
      // composition as Muse edits. Magnitude scales with difficulty (resize ±15-20%,
      // rotate 10-15°). No Muse fallback: if it cannot be measured, next candidate.
      const pasteBox = expandBox(region.bbox, kind === 'duplicate' ? 1.0 : 0.15, width, height);
      const { cropDataUrl: pasteCrop, cropBox } = await cropDataUrl(base, pasteBox);
      const rel = { x: region.bbox.x - cropBox.x, y: region.bbox.y - cropBox.y, width: region.bbox.width, height: region.bbox.height };
      const hash = [...ch.id].reduce((a, c) => a + c.charCodeAt(0), 0);
      const sign = hash % 2 === 0 ? 1 : -1;
      let editedPaste: string; let detail: string = kind;
      if (kind === 'duplicate') editedPaste = await duplicateObjectInPaste(pasteCrop, rel);
      else if (kind === 'flip') editedPaste = await transformObjectInPaste(pasteCrop, rel, 'flip');
      else if (kind === 'resize') {
        const mag = difficulty === 'easy' ? 0.20 : difficulty === 'hard' ? 0.15 : 0.17;
        const factor = 1 + sign * mag; detail = `resize x${factor.toFixed(2)}`;
        editedPaste = await transformObjectInPaste(pasteCrop, rel, 'resize', { resizeFactor: factor });
      } else {
        const deg = sign * (difficulty === 'easy' ? 15 : difficulty === 'hard' ? 10 : 12); detail = `rotate ${deg}°`;
        editedPaste = await transformObjectInPaste(pasteCrop, rel, 'rotate', { rotateDeg: deg });
      }
      const next = await compositeMaskedEdit(base, editedPaste, pasteBox, pasteBox);
      const mask = await diffMask(base, next, width, height);
      const bbox = maskToBBox(mask, width, height);
      if (!bbox) { console.info(`[generate ${job.id}] change ${ch.id} discarded: local ${detail} produced no measurable diff`); return null; }
      if (!measuredOk(bbox)) { console.info(`[generate ${job.id}] change ${ch.id} discarded: local ${detail} diff ${bbox.width}x${bbox.height} (area ${bbox.width * bbox.height}px) exceeds area cap ${Math.floor(width * height * MAX_MEASURED_AREA_FRACTION)}px`); return null; }
      const changedPixels = mask.reduce((a, v) => a + (v ? 1 : 0), 0);
      if (changedPixels < 30) { console.info(`[generate ${job.id}] change ${ch.id} discarded: local ${detail} changed only ${changedPixels}px (< 30)`); return null; }
      return { next, mask, bbox, local: true, notes: `local deterministic ${detail}: ${changedPixels}px changed (no Spark call)` };
    };

    const differences: Difference[] = [];
    let idx = 0;
    for (const ch of plan) {
      if (differences.length >= count) break; // candidates are a priority list: stop at count
      idx++;
      const region = regions.find(r => r.id === ch.regionId);
      if (!region) { console.info(`[generate ${job.id}] change ${ch.id} discarded: unknown regionId ${ch.regionId}`); continue; }
      setStage(`editing ${idx}/${plan.length} · ${differences.length}/${count} done`);
      const budget: MuseBudget = { calls: 0 };
      const isColor = /colou?r/i.test(ch.type);
      const localKind = job.mode === 'game' ? LOCAL_KIND(ch.type) : null;
      let candidate: Candidate | null = null;
      if (isColor) candidate = await applyLocalRecolor(current, ch, region);
      else if (localKind) candidate = await applyLocalTransform(current, ch, region, localKind);
      // Muse is reserved for remove / replace / add / QC defects, plus color changes the
      // deterministic recolor could not do. Local geometric transforms get no Muse fallback.
      if (!candidate && !localKind) candidate = await applyMuse(current, ch, region, ch.editPrompt, budget);
      if (!candidate) { console.info(`[generate ${job.id}] change ${ch.id} discarded: no aligned, measurable edit (next candidate)`); continue; }

      let notes = candidate.notes;
      if (!candidate.local) {
        setStage(`verifying ${idx}/${plan.length} · ${differences.length}/${count} done`);
        let verdict = await providers.vision.verify(aiImg, await providerImage(candidate.next), ch, candidate.bbox);
        if (!verdict.ok) {
          // E: re-edit ONCE within the same Muse budget (never re-ask the verifier the
          // same question), then discard and move to the next candidate.
          const retry = await applyMuse(current, ch, region, `${ch.editPrompt} The previous attempt failed verification (${verdict.notes}); apply the change more clearly and realistically, confined to the same object.`, budget);
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
    if (differences.length < count) console.info(`[generate ${job.id}] candidates exhausted: achieved ${differences.length}/${count} requested changes`);
    if (!differences.length) throw new Error('no change survived measurement/verification');

    job.levelId = saveImageLevel({ differences, original: img.dataUrl, modified: current, width, height, isMock: providers.segmentation.isMock, mode: job.mode, jobId: job.id });
    job.status = 'done'; setStage('done');
  } catch (e) {
    job.status = 'failed'; job.error = e instanceof Error ? e.message : String(e); job.updatedAt = Date.now(); void persistJob(job); // keep job.stage = where it failed
    console.error(`[generate ${job.id}] FAILED at stage "${job.stage}":`, e);
  }
}
