/** Per-IP generation rate limit: max 5 generations per hour per IP address.
 *  Active in public-demo mode (VF_ACCESS_CODE set — local dev stays friction-free;
 *  the daily job cap always applies regardless). In-memory sliding window (per
 *  server instance) with opportunistic cleanup of expired entries — credit
 *  protection for the public demo, not a security boundary. */
export const RATE_LIMIT_MAX = 5;
export const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

const g = globalThis as unknown as { __vfGenHits?: Map<string, number[]> };
if (!g.__vfGenHits) g.__vfGenHits = new Map();

/** AI-inspector challenge limit: 10 challenges per hour per IP (a challenge costs
 *  one Spark call). NO access code required — separate bucket from generation. */
export const CHALLENGE_LIMIT_MAX = 10;

const gc = globalThis as unknown as { __vfChallengeHits?: Map<string, number[]> };
if (!gc.__vfChallengeHits) gc.__vfChallengeHits = new Map();

export function hitChallengeRateLimit(ip: string, now = Date.now()): { ok: boolean; retryAfterSec: number } {
  const hits = (gc.__vfChallengeHits!.get(ip) ?? []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (hits.length >= CHALLENGE_LIMIT_MAX) {
    gc.__vfChallengeHits!.set(ip, hits);
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((hits[0]! + RATE_LIMIT_WINDOW_MS - now) / 1000)) };
  }
  hits.push(now);
  gc.__vfChallengeHits!.set(ip, hits);
  for (const [key, list] of gc.__vfChallengeHits!) {
    if (key !== ip && !list.some(t => now - t < RATE_LIMIT_WINDOW_MS)) gc.__vfChallengeHits!.delete(key);
  }
  return { ok: true, retryAfterSec: 0 };
}
export function hitGenerationRateLimit(ip: string, now = Date.now()): { ok: boolean; retryAfterSec: number } {
  const hits = (g.__vfGenHits!.get(ip) ?? []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (hits.length >= RATE_LIMIT_MAX) {
    g.__vfGenHits!.set(ip, hits);
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((hits[0]! + RATE_LIMIT_WINDOW_MS - now) / 1000)) };
  }
  hits.push(now);
  g.__vfGenHits!.set(ip, hits);
  // Cleanup: drop IPs whose window has fully expired so the map can't grow forever.
  for (const [key, list] of g.__vfGenHits!) {
    if (key !== ip && !list.some(t => now - t < RATE_LIMIT_WINDOW_MS)) g.__vfGenHits!.delete(key);
  }
  return { ok: true, retryAfterSec: 0 };
}
