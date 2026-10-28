export type Shape = { id: string; kind: 'circle' | 'rect' | 'star'; x: number; y: number; size: number; color: string };
import type { Difference } from './engine/types';
const COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];
function rng(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Procedural MOCK scene (no third-party images, no Meta calls). Differences derive from the actual rendered change. */
export function generateDemoScene(seed = 7): { original: Shape[]; modified: Shape[]; differences: Difference[] } {
  const r = rng(seed), original: Shape[] = [];
  for (let i = 0; i < 10; i++) original.push({ id: `s${i}`, kind: (['circle', 'rect', 'star'] as const)[i % 3], x: 30 + r() * 340, y: 30 + r() * 240, size: 18 + r() * 22, color: COLORS[i % COLORS.length] });
  const modified = original.map(s => ({ ...s })); const differences: Difference[] = [];
  const push = (s: Shape, type: string, description: string) => differences.push({ id: `diff-${differences.length + 1}`, type, description, bbox: { x: Math.max(0, s.x - s.size), y: Math.max(0, s.y - s.size), width: s.size * 2, height: s.size * 2 }, bbox_normalized: { x: Math.max(0, s.x - s.size) / 400, y: Math.max(0, s.y - s.size) / 300, width: (s.size * 2) / 400, height: (s.size * 2) / 300 }, mask_url: null, severity: 'medium', verification_status: 'needs_review', verifier_notes: 'MOCK scene — geometry-derived, not Meta-verified' });
  push(modified[1], 'change color', 'A shape changed color'); modified[1] = { ...modified[1], color: '#111827' };
  push(modified[3], 'remove object', 'An object disappeared'); modified.splice(3, 1);
  const added: Shape = { id: 'added', kind: 'star', x: 330, y: 55, size: 22, color: '#eab308' }; modified.push(added); push(added, 'add object', 'A new star appeared');
  const idx = modified.findIndex(s => s.id === 's5'); push(modified[idx], 'alter shape', 'A shape grew'); modified[idx] = { ...modified[idx], size: modified[idx].size * 1.7 };
  push(modified[0], 'change color', 'A shape changed color'); modified[0] = { ...modified[0], color: '#ffffff' };
  return { original, modified, differences };
}
export function renderShapes(shapes: Shape[]): string {
  return shapes.map(s => s.kind === 'circle' ? `<circle cx="${s.x}" cy="${s.y}" r="${s.size}" fill="${s.color}"/>`
    : s.kind === 'rect' ? `<rect x="${s.x - s.size}" y="${s.y - s.size}" width="${s.size * 2}" height="${s.size * 2}" rx="6" fill="${s.color}"/>`
    : `<text x="${s.x}" y="${s.y + s.size / 2}" font-size="${s.size * 2}" text-anchor="middle" fill="${s.color}">★</text>`).join('');
}
