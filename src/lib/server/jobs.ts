import { randomUUID } from 'node:crypto';
import { enforceSpacing, maskToBBox, maskCentroid, maskToPolygon, normalizeBBox, overlaps } from '../engine/geometry';
import { maskRasterToFrame } from '../engine/meta';
import type { Providers, Mode, Difficulty, Difference, Region, PlannedChange } from '../engine/types';
import { normalizeImage, cropDataUrl, expandBox, expandMask, diffMask, providerImage, clampBox, recolorCrop, squareContextBox, compositeMaskedEdit, estimateAlignment, alignEditedCrop, ALIGNMENT_MAX_RESIDUAL, cropColorStats, colorDeltaE, targetHueFromColor, cropDominantHue, transformObjectInPaste, duplicateObjectInPaste, extractOnePassComponents, compositeOnePassComponents, type OnePassComponent, type LocalTransformKind } from './imageOps';
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
  // Per-model call counters + per-stage wall time, printed in the final summary.
  const calls = { muse: 0, spark: 0, sam: 0 };
  const stageMs: Record<string, number> = {};
  let stageStartedAt = Date.now(); let stageName = 'init';
  const flushStage = () => { stageMs[stageName] = (stageMs[stageName] ?? 0) + (Date.now() - stageStartedAt); stageStartedAt = Date.now(); };
  const setStage = (s: string) => { flushStage(); stageName = s.replace(/\d+/g, 'n'); job.stage = s; job.updatedAt = Date.now(); console.info(`[generate ${job.id}] stage: ${s}`); void persistJob(job); };
  let modeUsed = job.mode === 'qc' ? 'crops (qc)' : 'crops';
  const logSummary = (differences: Difference[]) => {
    flushStage();
    const stages = Object.entries(stageMs).filter(([k]) => k !== 'init').map(([k, ms]) => `${k}=${(ms / 1000).toFixed(1)}s`).join(' ');
    console.info(`[generate ${job.id}] summary: mode=${modeUsed} · differences ${differences.length}/${count} · calls muse=${calls.muse} spark=${calls.spark} sam=${calls.sam} · stage time: ${stages}`);
  };
  try {
    job.status = 'running';
    setStage('normalizing');
    const img = await normalizeImage(imageDataUrl, 1024);
    const { width, height } = img;
    let current = img.dataUrl;
    const aiImg = await providerImage(img.dataUrl); // light JPEG twin for API calls (same dimensions)

    setStage('moderating');
    const mod = await providers.vision.moderate(aiImg); calls.spark++;
    if (!mod.ok) throw new Error(`moderation rejected: ${mod.reason}`);

    const differences: Difference[] = [];
    const difficulty = job.difficulty ?? 'medium';

    // VF_SAM_MASKS: real SAM masks via the official parser. The object's mask as a
    // full-frame boolean[], or null with the reason logged — callers fall back to the
    // bbox/diff-only behavior of today. Zero extra API calls (masks ride on SAM responses).
    const samMasksOn = process.env.VF_SAM_MASKS === 'true';
    const samFrameMask = (region: Region, changeId: string): boolean[] | null => {
      if (!samMasksOn) return null;
      if (!region.samMask) { console.info(`[generate ${job.id}] change ${changeId}: SAM mask unavailable (region has no SAM mask) — falling back to bbox`); return null; }
      try {
        const frame = maskRasterToFrame(region.samMask, region.bbox, width, height);
        const bool = Array.from(frame, v => v === 1);
        if (!bool.some(Boolean)) { console.info(`[generate ${job.id}] change ${changeId}: SAM mask empty after decode — falling back to bbox`); return null; }
        return bool;
      } catch (e) {
        console.info(`[generate ${job.id}] change ${changeId}: SAM mask decode failed (${e instanceof Error ? e.message : String(e)}) — falling back to bbox`);
        return null;
      }
    };
    const maskSubgrid = (frameMask: boolean[], box: { x: number; y: number; width: number; height: number }): boolean[] => {
      const out: boolean[] = [];
      for (let y = 0; y < box.height; y++) for (let x = 0; x < box.width; x++) out.push(frameMask[(box.y + y) * width + (box.x + x)]);
      return out;
    };

    // ============ CROP PREP: segmentation + planning, launched IN PARALLEL with the
    // one-pass Muse call below — both depend only on the ORIGINAL image. The resulting
    // plan is used only if one-pass delivers less than N (game top-up/fallback) or in QC.
    const prepareCropPlan = async (): Promise<{ regions: Region[]; plan: PlannedChange[] }> => {
      setStage('segmenting');
      const rawRegions = await providers.segmentation.segment(aiImg, width, height); calls.sam++;
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
      const planned = await providers.vision.plan(aiImg, regions, job.mode, count + 3, difficulty); calls.spark++;
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
      return { regions, plan };
    };
    const cropPrep = prepareCropPlan();
    void cropPrep.catch(() => { /* rejection surfaces only if the executor awaits it */ });

    // ================= ONE-PASS (game mode main path) =================
    // One full-image Muse call -> global alignment compensation -> low-pass/new-edge
    // extraction (calibrated offline) -> compose ONLY the chosen components over the
    // original -> re-measure -> ONE batched Spark review. If it delivers less than N,
    // the crop pipeline below tops up directly (no second one-pass pass).
    type Measured = { mask: boolean[]; bbox: NonNullable<ReturnType<typeof maskToBBox>> };
    const measureComposed = async (composed: string, comps: OnePassComponent[]): Promise<(Measured & { comp: OnePassComponent })[]> => {
      const fullMask = await diffMask(img.dataUrl, composed, width, height);
      const out: (Measured & { comp: OnePassComponent })[] = [];
      for (const comp of comps) {
        const zone = expandMask(comp.mask, width, height, 6);
        const mask = fullMask.map((v, i) => v && zone[i]);
        const bbox = maskToBBox(mask, width, height);
        if (bbox) out.push({ comp, mask, bbox });
      }
      return out;
    };
    const reviewMeasured = async (composed: string, measured: (Measured & { comp: OnePassComponent })[]): Promise<(Measured & { comp: OnePassComponent; description: string; type: string; notes: string })[]> => {
      if (!measured.length) return [];
      if (!providers.vision.reviewDifferences) {
        return measured.map((m, i) => ({ ...m, description: `Difference ${differences.length + i + 1}`, type: 'other', notes: 'no batched review available on this provider' }));
      }
      const pairs = await Promise.all(measured.map(async (m, i) => {
        const box = squareContextBox(m.bbox, width, height, 192);
        const before = await cropDataUrl(img.dataUrl, box);
        const after = await cropDataUrl(composed, box);
        return { index: i, before: await providerImage(before.cropDataUrl), after: await providerImage(after.cropDataUrl), bbox: { x: m.bbox.x - box.x, y: m.bbox.y - box.y, width: m.bbox.width, height: m.bbox.height } };
      }));
      const reviews = await providers.vision.reviewDifferences(pairs); calls.spark++;
      const kept: (Measured & { comp: OnePassComponent; description: string; type: string; notes: string })[] = [];
      for (const m of measured) {
        const i = measured.indexOf(m);
        const r = reviews.find(x => x.index === i);
        console.info(`[generate ${job.id}] onepass review #${i}: ok=${r?.ok ?? 'missing'} type=${r?.type ?? ''} description="${r?.description ?? ''}" notes="${r?.notes ?? ''}"`);
        if (r?.ok) kept.push({ ...m, description: r.description, type: r.type || 'other', notes: r.notes });
      }
      return kept;
    };
    const runOnePassPass = async (passBase: string, want: number, label: string): Promise<string | null> => {
      if (!providers.imageEdit.editFullImage || want <= 0) return null;
      const prompt = label === 'pass1'
        ? `Make exactly ${want} minimal, realistic differences for a spot-the-difference game (for example: remove a small part of an object, add a small detail to an object, add a small object in an empty area). To get variety, vary the kind of change: add a small detail, remove a small part, add a small object, change one color, swap one element. Keep everything else pixel-identical: same framing, scale, colors and lighting.`
        : `Make exactly ${want} additional minimal, realistic differences for a spot-the-difference game, in places that do not already contain a difference. To get variety, vary the kind of change: add a small detail, remove a small part, add a small object, change one color, swap one element. Keep everything else pixel-identical: same framing, scale, colors and lighting.`;
      const edited = await providers.imageEdit.editFullImage(await providerImage(passBase), prompt); calls.muse++;
      const est = await estimateAlignment(passBase, edited);
      console.info(`[generate ${job.id}] onepass ${label} alignment: shift (${est.shiftX}, ${est.shiftY})px · scale ${est.scale.toFixed(2)} · residual error ${est.error.toFixed(1)}`);
      if (!est.aligned) { console.info(`[generate ${job.id}] onepass ${label} discarded: residual alignment error ${est.error.toFixed(1)} exceeds ${ALIGNMENT_MAX_RESIDUAL}`); return null; }
      const aligned = await alignEditedCrop(passBase, edited, est);
      const { components, discarded } = await extractOnePassComponents(passBase, aligned);
      // Aggregate discard log: one summary line (specks by area + re-render noise total);
      // individually list only discards >= 24px, top 10 by score (area x meanAmp).
      const specks = discarded.filter(d => d.area < 24);
      const bigDiscards = discarded.filter(d => d.area >= 24).sort((a, b) => b.area * b.meanAmp - a.area * a.meanAmp);
      console.info(`[generate ${job.id}] onepass ${label} discards: ${specks.length} specks by area (<24px) · ${discarded.length - specks.length} re-render noise components`);
      for (const d of bigDiscards.slice(0, 10)) console.info(`[generate ${job.id}] onepass ${label} discarded component: ${d.area}px amp ${d.meanAmp.toFixed(1)} bbox (${d.bbox.x},${d.bbox.y}) ${d.bbox.width}x${d.bbox.height} — ${d.reason}`);
      for (const c of components) console.info(`[generate ${job.id}] onepass ${label} component: ${c.area}px amp ${c.meanAmp.toFixed(1)} meanLp ${c.meanLp.toFixed(1)} newEdge ${c.meanNewEdge.toFixed(1)} tex ${c.meanTex.toFixed(1)} score ${Math.round(c.score)} bbox (${c.bbox.x},${c.bbox.y}) ${c.bbox.width}x${c.bbox.height}`);
      const fresh = components.filter(c => !differences.some(d => overlaps(d.bbox, c.bbox, 4)));
      // Shape gate BEFORE the Spark review: a real difference is LOCAL — reject bboxes
      // spanning >40% of the image width/height or with aspect ratio > 6.
      const local = fresh.filter(c => {
        const aspect = Math.max(c.bbox.width / c.bbox.height, c.bbox.height / c.bbox.width);
        if (c.bbox.width > width * 0.4 || c.bbox.height > height * 0.4 || aspect > 6) {
          console.info(`[generate ${job.id}] onepass ${label} discarded component: ${c.area}px amp ${c.meanAmp.toFixed(1)} bbox (${c.bbox.x},${c.bbox.y}) ${c.bbox.width}x${c.bbox.height} — forma no local (bbox ${Math.round(c.bbox.width / width * 100)}% del ancho, ${Math.round(c.bbox.height / height * 100)}% del alto, aspecto ${aspect.toFixed(1)})`);
          return false;
        }
        return true;
      });
      const chosen = local.slice(0, want);
      console.info(`[generate ${job.id}] onepass ${label}: chose ${chosen.length}/${components.length} components (${local.length} local, not overlapping existing differences)`);
      if (!chosen.length) return null;
      let composed = await compositeOnePassComponents(passBase, aligned, chosen);
      let kept = await reviewMeasured(composed, await measureComposed(composed, chosen));
      if (!kept.length) return null;
      if (kept.length < chosen.length) { // recompose without the Spark-rejected components, re-measure only (no second review)
        const keptComps = kept.map(k => k.comp);
        composed = await compositeOnePassComponents(passBase, aligned, keptComps);
        const remeasured = await measureComposed(composed, keptComps);
        kept = remeasured.map(m => { const prev = kept.find(k => k.comp === m.comp)!; return { ...m, description: prev.description, type: prev.type, notes: prev.notes }; });
        if (!kept.length) return null;
      }
      for (const k of kept) {
        differences.push({
          id: `onepass-${differences.length + 1}`, type: k.type, description: k.description, bbox: k.bbox, bbox_normalized: normalizeBBox(k.bbox, width, height),
          segmentation: maskToPolygon(k.mask, width, height) ?? undefined,
          area_px: k.mask.reduce((a, v) => a + (v ? 1 : 0), 0),
          centroid: maskCentroid(k.mask, width, height) ?? { x: k.bbox.x + k.bbox.width / 2, y: k.bbox.y + k.bbox.height / 2 },
          mask_url: null, severity: 'medium', verification_status: 'verified', verifier_notes: `one-pass ${label}: ${k.notes}`,
        });
      }
      return composed;
    };

    if (job.mode === 'game') {
      try {
        setStage('one-pass: editing full image (Muse)');
        const afterPass1 = await runOnePassPass(img.dataUrl, count, 'pass1');
        if (afterPass1) { current = afterPass1; modeUsed = 'one-pass'; }
        // No second one-pass pass: if pass 1 delivered less than N, the crop pipeline
        // (already segmented + planned in parallel, below) tops up directly.
      } catch (e) {
        console.info(`[generate ${job.id}] one-pass failed (${e instanceof Error ? e.message : String(e)}) — falling back to crop pipeline`);
      }
      if (differences.length) console.info(`[generate ${job.id}] one-pass delivered ${differences.length}/${count} — ${differences.length < count ? 'crop pipeline will top up' : 'no crop pipeline needed'}`);
    }

    // ================= CROP EXECUTOR (QC always; game top-up / fallback) =================
    // Consumes the segmentation + plan prepared in parallel above (already done by now in
    // the common case, so topping up after one-pass costs no extra SAM/Spark latency).
    const cropTopUp = async (): Promise<void> => {
    const { regions, plan } = await cropPrep;

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
      budget.calls++; calls.muse++;
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
      // B: mask composition from large diff components inside the paste box only;
      // VF_SAM_MASKS unions the object's real SAM mask into the paste alpha.
      const frameMask = samFrameMask(region, ch.id);
      const objectMask = frameMask ? maskSubgrid(frameMask, pasteBox) : undefined;
      if (objectMask) console.info(`[generate ${job.id}] change ${ch.id}: SAM mask union in composite (${objectMask.filter(Boolean).length}px of paste box)`);
      const next = await compositeMaskedEdit(base, alignedEdited, contextBox, pasteBox, objectMask);
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
      // The planned target color is EXACT: when targetColor names a hue we recolor to
      // THAT hue (yellow=100°, green=145°, red=29° in OKLCH) and nothing else. Only when
      // targetColor is empty do we pick the hue FARTHEST from the object's current
      // dominant hue (dominant + 180°). Never a hash-derived shift, never "the candidate
      // with the biggest ΔE" (that used to override the requested color: yellow star
      // came out green, green "1" came out red).
      // VF_SAM_MASKS: recolor ONLY the object's real mask pixels (dilated 1px, no
      // feather). The hue measurements below are scoped to the same mask: the
      // unrecolored remainder of the bbox must not pollute the result-hue gate.
      const frameMask = samFrameMask(region, ch.id);
      let recolorMask: boolean[] | null = null;
      if (frameMask) {
        recolorMask = expandMask(maskSubgrid(frameMask, cropBox), cropBox.width, cropBox.height, 1);
        console.info(`[generate ${job.id}] change ${ch.id}: SAM mask applied to recolor (${recolorMask.filter(Boolean).length}/${cropBox.width * cropBox.height}px of bbox)`);
      }
      const dominantHue = await cropDominantHue(objCrop, recolorMask);
      let chosenHue: number | null = targetHue;
      if (chosenHue === null && dominantHue !== null) chosenHue = (dominantHue + 180) % 360;
      if (chosenHue === null) { console.info(`[generate ${job.id}] change ${ch.id}: local recolor skipped — no target hue and no dominant hue, Muse fallback`); return null; }
      const recolored = await recolorCrop(objCrop, 0, chosenHue, recolorMask);
      const delta = await colorDeltaE(objCrop, recolored, cropBox.width, cropBox.height);
      const resultHue = await cropDominantHue(recolored, recolorMask);
      const hueDist = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
      console.info(`[generate ${job.id}] change ${ch.id} color: target="${ch.targetColor ?? ''}" targetHue=${targetHue !== null ? Math.round(targetHue) + '°' : 'none'} chosenHue=${Math.round(chosenHue)}° dominantBefore=${dominantHue !== null ? Math.round(dominantHue) + '°' : 'none'} resultHue=${resultHue !== null ? Math.round(resultHue) + '°' : 'none'} ΔE=${delta.meanDeltaE.toFixed(3)} changedPx=${delta.changedPixels}`);
      if (targetHue !== null && resultHue !== null && hueDist(resultHue, targetHue) > 35) { console.info(`[generate ${job.id}] change ${ch.id}: local recolor rejected — result hue ${Math.round(resultHue)}° does not match target ${Math.round(targetHue)}°, Muse fallback`); return null; }
      if (delta.changedPixels < 30 || delta.meanDeltaE < 0.12) { console.info(`[generate ${job.id}] change ${ch.id}: local recolor skipped — ΔE ${delta.meanDeltaE.toFixed(3)} / ${delta.changedPixels}px below minimum (ΔE 0.12, 30px), Muse fallback`); return null; }
      const best = { recolored, meanDeltaE: delta.meanDeltaE, changedPixels: delta.changedPixels, hue: chosenHue };
      const next = await compositeMaskedEdit(base, best.recolored, region.bbox, region.bbox);
      const mask = await diffMask(base, next, width, height);
      const bbox = maskToBBox(mask, width, height);
      if (!bbox) { console.info(`[generate ${job.id}] change ${ch.id} discarded: recolor produced no measurable diff`); return null; }
      if (!measuredOk(bbox)) { console.info(`[generate ${job.id}] change ${ch.id} discarded: recolor diff ${bbox.width}x${bbox.height} (area ${bbox.width * bbox.height}px) exceeds area cap ${Math.floor(width * height * MAX_MEASURED_AREA_FRACTION)}px`); return null; }
      // E: local verification (ΔE + changed mask) — no Spark call for deterministic colors.
      return { next, mask, bbox, local: true, notes: `local OKLCH verify: ΔE ${best.meanDeltaE.toFixed(3)} over ${best.changedPixels}px, target hue ${Math.round(best.hue)}° result hue ${resultHue !== null ? Math.round(resultHue) + '°' : 'n/a'} (no Spark call)` };
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

    let idx = 0;
    for (const ch of plan) {
      if (differences.length >= count) break; // candidates are a priority list: stop at count
      idx++;
      const region = regions.find(r => r.id === ch.regionId);
      if (!region) { console.info(`[generate ${job.id}] change ${ch.id} discarded: unknown regionId ${ch.regionId}`); continue; }
      if (differences.some(d => overlaps(d.bbox, region.bbox, 4))) { console.info(`[generate ${job.id}] change ${ch.id} discarded: region overlaps an already-accepted difference`); continue; }
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
        // Verify the change IN ISOLATION: the image as it was JUST BEFORE this change
        // (current) vs the candidate, BOTH cropped to the context box. Comparing the
        // original against the accumulated image made the verifier reject changes for
        // "differences outside the region" that were earlier, already-accepted changes.
        const verifyChange = async (cand: Candidate): Promise<{ ok: boolean; notes: string }> => {
          const contextBox = squareContextBox(region.bbox, width, height);
          const rel = { x: cand.bbox.x - contextBox.x, y: cand.bbox.y - contextBox.y, width: cand.bbox.width, height: cand.bbox.height };
          const { cropDataUrl: beforeCrop } = await cropDataUrl(current, contextBox);
          const { cropDataUrl: afterCrop } = await cropDataUrl(cand.next, contextBox);
          const verdict = await providers.vision.verify(await providerImage(beforeCrop), await providerImage(afterCrop), ch, rel); calls.spark++;
          return verdict;
        };
        let verdict = await verifyChange(candidate);
        if (!verdict.ok) {
          // E: re-edit ONCE within the same Muse budget (never re-ask the verifier the
          // same question), then discard and move to the next candidate.
          const retry = await applyMuse(current, ch, region, `${ch.editPrompt} The previous attempt failed verification (${verdict.notes}); apply the change more clearly and realistically, confined to the same object.`, budget);
          if (retry) {
            verdict = await verifyChange(retry);
            if (verdict.ok) candidate = retry;
          }
          if (!verdict.ok) { console.info(`[generate ${job.id}] change ${ch.id} discarded after re-edit: ${verdict.notes}`); continue; }
        }
        notes = verdict.notes;
      }
      differences.push({
        id: ch.id, type: ch.type, description: ch.description, bbox: candidate.bbox, bbox_normalized: normalizeBBox(candidate.bbox, width, height),
        segmentation: maskToPolygon(candidate.mask, width, height) ?? undefined,
        area_px: candidate.mask.reduce((a, v) => a + (v ? 1 : 0), 0),
        centroid: maskCentroid(candidate.mask, width, height) ?? { x: candidate.bbox.x + candidate.bbox.width / 2, y: candidate.bbox.y + candidate.bbox.height / 2 },
        mask_url: null, severity: ch.severity ?? 'medium',
        verification_status: 'verified', verifier_notes: notes,
      });
      current = candidate.next;
    }
    if (differences.length < count) console.info(`[generate ${job.id}] crop candidates exhausted: at ${differences.length}/${count} requested changes`);
    }; // end cropTopUp

    if (differences.length < count) {
      if (job.mode === 'game' && differences.length > 0) modeUsed = 'one-pass + crops';
      try { await cropTopUp(); }
      catch (e) {
        if (!differences.length) throw e;
        console.info(`[generate ${job.id}] crop top-up failed (${e instanceof Error ? e.message : String(e)}) — keeping the ${differences.length} one-pass difference(s)`);
      }
    }
    if (!differences.length) throw new Error('no change survived measurement/verification');
    logSummary(differences);

    job.levelId = saveImageLevel({ differences, original: img.dataUrl, modified: current, width, height, isMock: providers.segmentation.isMock, mode: job.mode, jobId: job.id });
    job.status = 'done'; setStage('done');
  } catch (e) {
    job.status = 'failed'; job.error = e instanceof Error ? e.message : String(e); job.updatedAt = Date.now(); void persistJob(job); // keep job.stage = where it failed
    console.error(`[generate ${job.id}] FAILED at stage "${job.stage}":`, e);
  }
}
