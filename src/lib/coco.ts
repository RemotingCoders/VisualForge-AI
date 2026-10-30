import type { BBox } from './engine/types';

export interface CocoImage { id: number; file_name: string; width: number; height: number }
export interface CocoAnnotation { id: number; image_id: number; category_id: number; bbox: [number, number, number, number]; area: number; iscrowd: 0; segmentation?: number[][] }
export function toCOCO(images: CocoImage[], anns: { imageId: number; categoryId: number; bbox: BBox; segmentation?: number[]; area?: number }[], categories: { id: number; name: string }[]) {
  return {
    info: { description: 'VisualForge AI synthetic dataset — validate before industrial use', synthetic: true },
    images, categories,
    annotations: anns.map((a, i): CocoAnnotation => ({ id: i + 1, image_id: a.imageId, category_id: a.categoryId, bbox: [a.bbox.x, a.bbox.y, a.bbox.width, a.bbox.height], area: a.area ?? a.bbox.width * a.bbox.height, iscrowd: 0, ...(a.segmentation ? { segmentation: [a.segmentation] } : {}) })),
  };
}
export function toYOLO(bbox: BBox, imgW: number, imgH: number, classId: number): string {
  const cx = (bbox.x + bbox.width / 2) / imgW, cy = (bbox.y + bbox.height / 2) / imgH;
  return `${classId} ${cx.toFixed(6)} ${cy.toFixed(6)} ${(bbox.width / imgW).toFixed(6)} ${(bbox.height / imgH).toFixed(6)}`;
}

export const QC_DEFECT_CATEGORIES = ['scratch', 'crack', 'dent', 'missing component', 'corrosion', 'misalignment', 'wrong color', 'foreign object'];

/** Category table for a set of differences: known QC defects first (stable ids), then any extras. */
export function qcCategories(diffs: { type: string }[]): { id: number; name: string }[] {
  const names = [...QC_DEFECT_CATEGORIES];
  for (const d of diffs) if (!names.includes(d.type)) names.push(d.type);
  return names.map((name, i) => ({ id: i + 1, name }));
}

type ExportableDiff = { type: string; bbox: BBox; verification_status: string; segmentation?: number[]; area_px?: number };

/**
 * QC dataset from a REAL generated level. Only `verified` differences are exported, and the
 * bbox is the MEASURED defect bbox (from the pixel-diff mask), never the edit crop box.
 */
export function buildQCCoco(diffs: ExportableDiff[], width: number, height: number, fileName: string) {
  const verified = diffs.filter(d => d.verification_status === 'verified');
  const categories = qcCategories(verified);
  const catId = new Map(categories.map(c => [c.name, c.id]));
  return toCOCO(
    [{ id: 1, file_name: fileName, width, height }],
    verified.map(d => ({ imageId: 1, categoryId: catId.get(d.type)!, bbox: d.bbox, segmentation: d.segmentation, area: d.area_px })),
    categories,
  );
}

export function buildQCYolo(diffs: ExportableDiff[], width: number, height: number): string {
  const verified = diffs.filter(d => d.verification_status === 'verified');
  const categories = qcCategories(verified);
  const classIdx = new Map(categories.map((c, i) => [c.name, i])); // YOLO classes are 0-based
  return verified.map(d => toYOLO(d.bbox, width, height, classIdx.get(d.type)!)).join('\n');
}
