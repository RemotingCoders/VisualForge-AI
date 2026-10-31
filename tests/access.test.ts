import { describe, it, expect, afterEach, vi } from 'vitest';
import { POST } from '../src/app/api/generate/route';

/** VF_ACCESS_CODE + per-IP rate limit on POST /api/generate. The provider is the
 *  offline MOCK in tests (no paid calls): a passing request returns the labeled
 *  demo level immediately. Supabase is disabled under tests (NODE_ENV=test), so
 *  the daily cap falls back to the in-memory job count. Each test uses its own
 *  IPs so the in-memory rate-limit windows never bleed across cases. */
const gen = (ip: string, body: Record<string, unknown>) => POST(new Request('http://localhost/api/generate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
  body: JSON.stringify(body),
}));

afterEach(() => { vi.unstubAllEnvs(); });

describe('VF_ACCESS_CODE guard on POST /api/generate', () => {
  it('401s when the code is missing or wrong, passes with the right code', async () => {
    vi.stubEnv('VF_ACCESS_CODE', 'judges-2026');
    const missing = await gen('10.1.0.1', { count: 3, mode: 'game' });
    expect(missing.status).toBe(401);
    expect((await missing.json()).error).toBe('access code required');

    const wrong = await gen('10.1.0.1', { count: 3, mode: 'game', accessCode: 'not-the-code' });
    expect(wrong.status).toBe(401);
    expect((await wrong.json()).error).toBe('access code required');

    const ok = await gen('10.1.0.1', { count: 3, mode: 'game', accessCode: 'judges-2026' });
    expect(ok.status).toBe(200);
    expect((await ok.json()).isMock).toBe(true); // offline demo path — no paid call in tests
  });

  it('requires nothing when VF_ACCESS_CODE is not defined (local dev)', async () => {
    vi.stubEnv('VF_ACCESS_CODE', '');
    const res = await gen('10.2.0.1', { count: 3, mode: 'game' });
    expect(res.status).toBe(200);
    expect((await res.json()).isMock).toBe(true);
  });

  it('429s the 6th generation from one IP within the hour, other IPs unaffected', async () => {
    vi.stubEnv('VF_ACCESS_CODE', 'judges-2026');
    for (let i = 0; i < 5; i++) {
      expect((await gen('10.3.0.1', { count: 3, mode: 'game', accessCode: 'judges-2026' })).status).toBe(200);
    }
    const sixth = await gen('10.3.0.1', { count: 3, mode: 'game', accessCode: 'judges-2026' });
    expect(sixth.status).toBe(429);
    expect((await sixth.json()).error).toContain('5 per hour');
    expect((await gen('10.3.0.2', { count: 3, mode: 'game', accessCode: 'judges-2026' })).status).toBe(200);
  });
});
