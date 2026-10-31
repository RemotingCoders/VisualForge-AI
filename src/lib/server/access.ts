import { timingSafeEqual } from 'node:crypto';

/** VF_ACCESS_CODE — public-demo credit protection for PAID generation.
 *  When the env var is defined (non-empty), POST /api/generate requires the same
 *  code in the request body; without the var, nothing is required (local dev).
 *  The comparison is constant-time so the code can't be probed byte by byte.
 *  Playing existing levels (demo, gallery, clicks, hints) never needs the code. */
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

/** Best-effort client IP for the per-IP generation rate limit (proxy headers first). */
export function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]!.trim() || 'unknown';
  return req.headers.get('x-real-ip') ?? 'unknown';
}
