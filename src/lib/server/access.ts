import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

/** VF_ACCESS_CODE — public-demo credit protection for PAID Meta calls.
 *  When the env var is defined (non-empty), EVERY route that calls Meta's models
 *  requires the same code in the request body; without the var, nothing is
 *  required (local dev). The comparison is constant-time so the code can't be
 *  probed byte by byte. Routes that never call Meta (gallery, stored levels,
 *  clicks, saved hints, exports) never need the code. */
export function accessCodeRequired(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.VF_ACCESS_CODE?.length);
}

export function accessCodeOk(provided: unknown, env: Record<string, string | undefined> = process.env): boolean {
  const expected = env.VF_ACCESS_CODE ?? '';
  if (!expected) return true; // not configured -> open (local development)
  if (typeof provided !== 'string' || !provided) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false; // timingSafeEqual needs equal lengths
  return timingSafeEqual(a, b);
}

/** Exact copy answered when a Meta-calling route is hit without the judge code:
 *  it says where the code lives AND names the free fallback (the gallery). */
export const META_ACCESS_MESSAGE = "This action uses Meta's models and needs the judge access code from the hackathon submission. The gallery is free to play.";

/** THE single access rule for every route that calls Meta's models — level/scene
 *  generation, theme moderation, "Race against Spark", "Challenge the AI
 *  inspector", and any future one. Returns the 401 response to send, or null
 *  when the request may proceed (right code, or no code configured → local dev
 *  stays open). One helper + one route-walking test (tests/spend.test.ts) so a
 *  new Meta-calling route can't silently forget the gate. */
export function requireMetaAccess(provided: unknown, env: Record<string, string | undefined> = process.env): NextResponse | null {
  if (accessCodeOk(provided, env)) return null;
  return NextResponse.json({ error: META_ACCESS_MESSAGE }, { status: 401 });
}

/** Best-effort client IP for the per-IP generation rate limit (proxy headers first). */
export function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]!.trim() || 'unknown';
  return req.headers.get('x-real-ip') ?? 'unknown';
}
