import { randomUUID } from 'node:crypto';
import { generateDemoScene } from './demoScene';
import { persistImageLevel } from './server/db';
import type { Difference, Mode } from './engine/types';
/** Server-only store: difference annotations live here, NEVER in the client payload. */
const g = globalThis as unknown as {
  __vfLevels?: Map<string, Difference[]>;
  __vfImageLevels?: Map<string, { original: string; modified: string; width: number; height: number; isMock: boolean; mode: Mode; theme?: string; revisedPrompt?: string; notice?: string }>;
  __vfDemoScenes?: Map<string, { original: unknown; modified: unknown }>;
  __vfQcSessions?: QcSessionRecord[];
};
if (!g.__vfLevels) g.__vfLevels = new Map();
if (!g.__vfImageLevels) g.__vfImageLevels = new Map();
if (!g.__vfDemoScenes) g.__vfDemoScenes = new Map();
if (!g.__vfQcSessions) g.__vfQcSessions = [];
export function createDemoLevel(seed = 7) {
  const id = `demo-${seed}-${Math.random().toString(36).slice(2, 8)}`;
  const scene = generateDemoScene(seed);
  g.__vfLevels!.set(id, scene.differences);
  g.__vfDemoScenes!.set(id, { original: scene.original, modified: scene.modified });
  return { levelId: id, original: scene.original, modified: scene.modified, total: scene.differences.length };
}
export function getDemoPayload(levelId: string) {
  const scene = g.__vfDemoScenes!.get(levelId);
  const diffs = g.__vfLevels!.get(levelId);
  if (!scene || !diffs) return null;
  return { levelId, demo: true as const, original: scene.original, modified: scene.modified, total: diffs.length, isMock: true };
}
export function saveImageLevel(level: { differences: Difference[]; original: string; modified: string; width: number; height: number; isMock: boolean; mode?: Mode; jobId?: string; theme?: string; revisedPrompt?: string; notice?: string }): string {
  const id = randomUUID();
  g.__vfLevels!.set(id, level.differences);
  g.__vfImageLevels!.set(id, { original: level.original, modified: level.modified, width: level.width, height: level.height, isMock: level.isMock, mode: level.mode ?? 'game', theme: level.theme, revisedPrompt: level.revisedPrompt, notice: level.notice });
  void persistImageLevel(id, { ...level, mode: level.mode ?? 'game' }); // durable copy in Supabase (no-op if not configured)
  return id;
}
export function getDifferences(levelId: string) { return g.__vfLevels!.get(levelId) ?? null; }
/** Public game payload: board images + totals only — no annotations (anti-cheat). */
export function getLevelPayload(levelId: string) {
  const img = g.__vfImageLevels!.get(levelId);
  const diffs = g.__vfLevels!.get(levelId);
  if (!img || !diffs) return null;
  return { levelId, original: img.original, modified: img.modified, width: img.width, height: img.height, total: diffs.length, isMock: img.isMock, mode: img.mode, theme: img.theme, revisedPrompt: img.revisedPrompt, notice: img.notice };
}

/** QC trainer session, recorded when the trainee reveals a real QC level
 *  (mirrored to visualforge_qc_sessions best-effort). */
export interface QcSessionRecord {
  id: string; levelId: string; correct: number; missed: number; falsePositives: number;
  accuracy: number; durationSec: number; createdAt: number;
}
export function recordQcSession(levelId: string, stats: { correct: number; missed: number; falsePositives: number; accuracy: number; durationSec: number }): QcSessionRecord {
  const rec: QcSessionRecord = { id: randomUUID(), levelId, ...stats, createdAt: Date.now() };
  g.__vfQcSessions!.push(rec);
  return rec;
}
export function getQcSessions(levelId?: string): QcSessionRecord[] {
  return levelId ? g.__vfQcSessions!.filter(s => s.levelId === levelId) : [...g.__vfQcSessions!];
}
