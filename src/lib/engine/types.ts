import type { SamMask } from './meta';

export type Mode = 'game' | 'qc';
export type Difficulty = 'easy' | 'medium' | 'hard';
export type BBox = { x: number; y: number; width: number; height: number };

export interface Region { id: string; bbox: BBox; maskRef?: string; label?: string; wholeObject?: boolean; /** Real SAM mask as emitted by the API (payload form); decoded via @meta-sam/parser when VF_SAM_MASKS=true. */ samMask?: SamMask }

export interface PlannedChange {
  id: string; regionId: string; type: string; description: string; editPrompt: string; severity?: 'low' | 'medium' | 'high';
  /** Named target color for color changes (e.g. "blue"); the local recolor derives its hue from this so description matches pixels. */
  targetColor?: string;
  /** QC mode: the exact pixel box INSIDE the region where the defect goes (several
   *  defects may share one part/region, each with its own non-overlapping targetBox).
   *  Context and paste boxes derive from it — never from the whole region. */
  targetBox?: BBox;
  /** QC mode: short name of the part/feature the defect sits on (e.g. "flange edge"). */
  partConcept?: string;
}

export interface Difference {
  id: string; type: string; description: string;
  bbox: BBox; bbox_normalized: BBox; mask_url: string | null;
  centroid?: { x: number; y: number }; // center of mass of the measured diff — marker circles center here
  /** Flat COCO polygon [x1,y1,x2,y2,...] traced from the MEASURED diff mask (QC export); absent when unavailable. */
  segmentation?: number[];
  /** Real measured area of the diff mask in pixels (COCO `area`); absent when unavailable. */
  area_px?: number;
  severity: 'low' | 'medium' | 'high';
  verification_status: 'verified' | 'needs_review' | 'rejected';
  verifier_notes: string;
  /** Capability 2: exactly 3 progressive hints (vague → precise), written by ONE Spark
   *  call per level after measurement. Absent on levels generated before the capability
   *  or when the hint call failed — /api/hint synthesizes positional fallbacks then. */
  hints?: string[];
  /** Capability 2: Spark-rated difficulty of THIS difference, 1 (easiest) to 5 (hardest).
   *  Drives hint targeting (easiest pending first) and difficulty-weighted scoring. */
  difficulty?: number;
  /** QC defect classification (ONE Spark call per level, after measurement; migration
   *  0005): the PLANNED type stays in `type`; Spark's visual re-classification of the
   *  measured before/after crops lands here. Exports use the classified type, and
   *  confidence < 0.6 is exported separately as needs_review. */
  classifiedType?: string;
  classifiedSeverity?: number; // 1 (cosmetic) .. 5 (critical)
  classificationConfidence?: number; // 0..1
  classificationLabel?: string;
  /** Challenge the AI inspector (migration 0006): how detectable this difference is
   *  FOR SPARK, accumulated over AI challenges — attempts, hits, the modes Spark has
   *  found it in, and detectability = hits / attempts (0..1). Absent until challenged. */
  detectability?: number;
  aiChallenges?: number;
  aiHits?: number;
  aiFoundModes?: string[];
}

export interface SegmentationProvider {
  readonly name: string; readonly isMock: boolean;
  /** SAM needs one short noun-phrase concept per request ("glasses", "red hat"). If concepts are
   *  omitted, the real provider first asks Muse Spark to list segmentable objects in the scene.
   *  `mode` steers that concept listing: QC asks for PARTS/FEATURES of the piece (mounting
   *  hole, flange edge…), never the whole piece, so SAM returns several usable regions. */
  segment(imageRef: string, width: number, height: number, concepts?: string[], mode?: Mode): Promise<Region[]>;
}
/** One batched verdict per one-pass difference, from its original/modified crop pair. */
export interface DifferenceReview { index: number; ok: boolean; description: string; type: string; notes: string }
/** Capability 2: Spark's hints + difficulty rating for one measured difference. */
export interface DifferenceHints { index: number; difficulty: number; hints: string[] }
/** One Spark finding in the AI-inspector challenge (bbox normalized 0..1). */
export interface AiFinding { bbox_normalized: BBox; label: string; confidence: number }
/** QC defect classification for one measured defect (before/after crops judged by Spark). */
export interface DefectClassification { index: number; defectType: string; severity: number; confidence: number; label: string }
/** The canonical QC defect categories (planner, classifier schema, COCO/YOLO exports). */
export const QC_DEFECT_CATEGORIES = ['scratch', 'crack', 'dent', 'missing component', 'corrosion', 'misalignment', 'wrong color', 'foreign object'];
export interface VisionReasoningProvider {
  readonly name: string; readonly isMock: boolean;
  moderate(imageRef: string): Promise<{ ok: boolean; reason: string }>;
  /** Text-only theme moderation (VF_THEME_GENERATION): Spark judges the theme BEFORE any
   *  paid image generation. Optional like reviewDifferences — the theme path fails loudly
   *  when a provider does not implement it. */
  moderateTheme?(text: string): Promise<{ ok: boolean; reason: string }>;
  plan(imageRef: string, regions: Region[], mode: Mode, count: number, difficulty?: Difficulty): Promise<PlannedChange[]>;
  verify(imageRef: string, modifiedRef: string, change: PlannedChange, measured: BBox): Promise<{ ok: boolean; notes: string }>;
  /** ONE call reviewing N crop pairs (before/after interleaved in `pairs` order). Used by one-pass mode. */
  reviewDifferences?(pairs: { index: number; before: string; after: string; bbox: BBox }[]): Promise<DifferenceReview[]>;
  /** Capability 2: ONE call per level, AFTER differences are measured. For each difference
   *  (identified by index) Spark returns exactly 3 progressive hints and a difficulty
   *  rating 1 (easiest) – 5 (hardest). Optional: levels still generate without it. */
  generateHints?(differences: { index: number; description: string; type: string; bbox_normalized: BBox }[]): Promise<DifferenceHints[]>;
  /** QC: ONE call per level AFTER measurement — Spark re-classifies each measured defect
   *  from its before/after crops (defectType within QC_DEFECT_CATEGORIES, severity 1-5,
   *  confidence 0-1, short label). Optional: QC levels still generate without it. */
  classifyDefects?(items: { index: number; before: string; after: string; plannedType: string }[]): Promise<DefectClassification[]>;
  /** Challenge the AI inspector: ONE call — Spark inspects the target image (plus the
   *  reference first when withReference) and returns findings with normalized boxes.
   *  It NEVER receives the annotations; the server validates findings against them.
   *  Optional: the challenge endpoint fails loudly when a provider lacks it. */
  inspectImage?(imageRefs: string[], opts: { kind: 'qc' | 'game'; withReference: boolean }): Promise<AiFinding[]>;
}
/** A generated scene (VF_THEME_GENERATION): the image plus the prompt Muse Image
 *  actually used, which the API echoes back as data[].revised_prompt. */
export interface GeneratedScene { image: string; revisedPrompt?: string }
export interface ImageEditProvider {
  readonly name: string; readonly isMock: boolean;
  editMaskedRegion(imageRef: string, region: Region, prompt: string): Promise<string>;
  /** Full-image edit with the RAW prompt (no preservation-guard suffix — the one-pass prompt
   *  already carries its own "keep everything else pixel-identical" clause). One-pass mode. */
  editFullImage?(imageRef: string, prompt: string): Promise<string>;
  /** kind 'scene' = spot-the-difference scene (Play theme); 'part' = a single
   *  manufactured part photo (QC describe-a-part, no photo upload needed). */
  generateScene(theme: string, kind?: 'scene' | 'part'): Promise<GeneratedScene>;
}
export interface Providers { segmentation: SegmentationProvider; vision: VisionReasoningProvider; imageEdit: ImageEditProvider }
