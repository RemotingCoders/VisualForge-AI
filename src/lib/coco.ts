import type { BBox } from './engine/types';

export interface CocoImage { id: number; file_name: string; width: number; height: number }
export interface CocoAnnotation { id: number; image_id: number; category_id: number; bbox: [number, number, number, number]; area: number; iscrowd: 0 }
export function toCOCO(images: CocoImage[], anns: { imageId: number; categoryId: number; bbox: BBox }[], categories: { id: number; name: string }[]) {
  return {
    info: { description: 'VisualForge AI synthetic dataset — validate before industrial use', synthetic: true },
    images, categories,
    annotations: anns.map((a, i): CocoAnnotation => ({ id: i + 1, image_id: a.imageId, category_id: a.categoryId, bbox: [a.bbox.x, a.bbox.y, a.bbox.width, a.bbox.height], area: a.bbox.width * a.bbox.height, iscrowd: 0 })),
  };
}
export function toYOLO(bbox: BBox, imgW: number, imgH: number, classId: number): string {
  const cx = (bbox.x + bbox.width / 2) / imgW, cy = (bbox.y + bbox.height / 2) / imgH;
  return `${classId} ${cx.toFixed(6)} ${cy.toFixed(6)} ${(bbox.width / imgW).toFixed(6)} ${(bbox.height / imgH).toFixed(6)}`;
}
