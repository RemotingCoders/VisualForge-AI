import { maskToBBox, normalizeBBox, enforceSpacing } from './geometry';
import type { Providers, Mode, Difference } from './types';

export type JobStage = 'moderating' | 'segmenting' | 'planning' | 'editing' | 'compositing' | 'measuring' | 'verifying' | 'done' | 'failed';
export interface PipelineResult { modifiedRef: string; differences: Difference[]; stages: JobStage[]; isMock: boolean }

/** Pixel-diff measurement: real mask/bbox derived from data, never trusted from the plan. */
export function measureDifferences(original: Uint8Array, modified: Uint8Array, w: number, h: number, threshold = 12): boolean[] {
  if (original.length !== modified.length) throw new Error('image buffers differ in size');
  const px = w * h, out = new Array<boolean>(px).fill(false);
  const channels = original.length / px;
  for (let i = 0; i < px; i++) { let d = 0; for (let c = 0; c < channels; c++) d = Math.max(d, Math.abs(original[i * channels + c] - modified[i * channels + c])); out[i] = d > threshold; }
  return out;
}
/** Composite invariant helper: pixels outside mask MUST equal original. */
export function compositePixel(original: number, edited: number, inMask: boolean): number { return inMask ? edited : original; }

export async function runPipeline(opts: {
  imageRef: string; width: number; height: number; mode: Mode; count: number; providers: Providers;
  measure: (changeId: string) => Promise<boolean[] | null>; onStage?: (s: JobStage) => void;
}): Promise<PipelineResult> {
  const { providers } = opts, stages: JobStage[] = [];
  const stage = (s: JobStage) => { stages.push(s); opts.onStage?.(s); };
  try {
    stage('moderating');
    const mod = await providers.vision.moderate(opts.imageRef);
    if (!mod.ok) throw new Error(`moderation rejected: ${mod.reason}`);
    stage('segmenting');
    const regions = enforceSpacing(await providers.segmentation.segment(opts.imageRef, opts.width, opts.height));
    stage('planning');
    const plan = (await providers.vision.plan(opts.imageRef, regions, opts.mode, opts.count)).slice(0, opts.count);
    stage('editing'); stage('compositing');
    let modifiedRef = opts.imageRef;
    for (const ch of plan) { const r = regions.find(x => x.id === ch.regionId); if (r) modifiedRef = await providers.imageEdit.editMaskedRegion(modifiedRef, r, ch.editPrompt); }
    stage('measuring'); stage('verifying');
    const diffs: Difference[] = [];
    for (const ch of plan) {
      const mask = await opts.measure(ch.id); if (!mask) continue;
      const bbox = maskToBBox(mask, opts.width, opts.height); if (!bbox) continue;
      let verdict = await providers.vision.verify(opts.imageRef, modifiedRef, ch, bbox);
      if (!verdict.ok) verdict = await providers.vision.verify(opts.imageRef, modifiedRef, ch, bbox); // retry ONCE
      diffs.push({ id: ch.id, type: ch.type, description: ch.description, bbox, bbox_normalized: normalizeBBox(bbox, opts.width, opts.height), mask_url: null, severity: ch.severity ?? 'medium', verification_status: verdict.ok ? 'verified' : 'needs_review', verifier_notes: verdict.notes });
    }
    stage('done');
    return { modifiedRef, differences: diffs, stages, isMock: providers.segmentation.isMock };
  } catch (e) { stage('failed'); throw e; }
}
