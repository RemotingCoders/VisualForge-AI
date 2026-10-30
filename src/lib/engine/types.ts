export type Mode = 'game' | 'qc';
export type BBox = { x: number; y: number; width: number; height: number };

export interface Region { id: string; bbox: BBox; maskRef?: string; label?: string; wholeObject?: boolean }

export interface PlannedChange {
  id: string; regionId: string; type: string; description: string; editPrompt: string; severity?: 'low' | 'medium' | 'high';
  /** Named target color for color changes (e.g. "blue"); the local recolor derives its hue from this so description matches pixels. */
  targetColor?: string;
}

export interface Difference {
  id: string; type: string; description: string;
  bbox: BBox; bbox_normalized: BBox; mask_url: string | null;
  centroid?: { x: number; y: number }; // center of mass of the measured diff — marker circles center here
  severity: 'low' | 'medium' | 'high';
  verification_status: 'verified' | 'needs_review' | 'rejected';
  verifier_notes: string;
}

export interface SegmentationProvider {
  readonly name: string; readonly isMock: boolean;
  /** SAM needs one short noun-phrase concept per request ("glasses", "red hat"). If concepts are
   *  omitted, the real provider first asks Muse Spark to list segmentable objects in the scene. */
  segment(imageRef: string, width: number, height: number, concepts?: string[]): Promise<Region[]>;
}
export interface VisionReasoningProvider {
  readonly name: string; readonly isMock: boolean;
  moderate(imageRef: string): Promise<{ ok: boolean; reason: string }>;
  plan(imageRef: string, regions: Region[], mode: Mode, count: number): Promise<PlannedChange[]>;
  verify(imageRef: string, modifiedRef: string, change: PlannedChange, measured: BBox): Promise<{ ok: boolean; notes: string }>;
}
export interface ImageEditProvider {
  readonly name: string; readonly isMock: boolean;
  editMaskedRegion(imageRef: string, region: Region, prompt: string): Promise<string>;
  generateScene(theme: string): Promise<string>;
}
export interface Providers { segmentation: SegmentationProvider; vision: VisionReasoningProvider; imageEdit: ImageEditProvider }
