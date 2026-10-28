import { generateDemoScene } from './demoScene';
import type { Difference } from './engine/types';
/** Server-only store: difference annotations live here, NEVER in the client payload. */
const g = globalThis as unknown as { __vfLevels?: Map<string, Difference[]> };
if (!g.__vfLevels) g.__vfLevels = new Map();
export function createDemoLevel(seed = 7) {
  const id = `demo-${seed}-${Math.random().toString(36).slice(2, 8)}`;
  const scene = generateDemoScene(seed);
  g.__vfLevels!.set(id, scene.differences);
  return { levelId: id, original: scene.original, modified: scene.modified, total: scene.differences.length };
}
export function getDifferences(levelId: string) { return g.__vfLevels!.get(levelId) ?? null; }
