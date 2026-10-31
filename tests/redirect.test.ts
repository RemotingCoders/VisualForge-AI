import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '../src/middleware';

// Legacy-host redirect: visualforge-ai.onrender.com -> VF_PUBLIC_HOST (301),
// only when VF_PUBLIC_HOST is set. Offline — NextRequest is constructed by hand.

const req = (url: string) => new NextRequest(url);

describe('middleware: legacy host redirect', () => {
  const prev = process.env.VF_PUBLIC_HOST;
  beforeEach(() => { delete process.env.VF_PUBLIC_HOST; });
  afterEach(() => { if (prev === undefined) delete process.env.VF_PUBLIC_HOST; else process.env.VF_PUBLIC_HOST = prev; });

  it('does nothing when VF_PUBLIC_HOST is unset (local dev never redirects)', () => {
    const res = middleware(req('https://visualforge-ai.onrender.com/play?level=abc'));
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('301-redirects the legacy host to the same path + query on the new host', () => {
    process.env.VF_PUBLIC_HOST = 'visualforge-ai.taplinko.store';
    const res = middleware(req('https://visualforge-ai.onrender.com/play?level=abc'));
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://visualforge-ai.taplinko.store/play?level=abc');
    const root = middleware(req('http://visualforge-ai.onrender.com/'));
    expect(root.status).toBe(301);
    expect(root.headers.get('location')).toBe('https://visualforge-ai.taplinko.store/');
  });

  it('serves the new host (and any other host) normally — no redirect loop', () => {
    process.env.VF_PUBLIC_HOST = 'visualforge-ai.taplinko.store';
    expect(middleware(req('https://visualforge-ai.taplinko.store/qc')).status).toBe(200);
    expect(middleware(req('http://localhost:3000/play')).status).toBe(200);
  });
});
