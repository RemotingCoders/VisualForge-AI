import { NextResponse, type NextRequest } from 'next/server';

/** Public-host migration: the live demo moved from Render's subdomain to
 *  visualforge-ai.taplinko.store. Any request that still arrives under the
 *  legacy host gets a permanent redirect (301) to the SAME path on the new
 *  host — but only when VF_PUBLIC_HOST is set, so local dev and any instance
 *  without a canonical host never redirect. The new domain itself is served
 *  normally, so there is no redirect loop. */
const LEGACY_HOST = 'visualforge-ai.onrender.com';

export function middleware(req: NextRequest) {
  const publicHost = process.env.VF_PUBLIC_HOST;
  if (!publicHost) return NextResponse.next();
  if (req.nextUrl.hostname.toLowerCase() !== LEGACY_HOST) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.protocol = 'https:';
  url.hostname = publicHost;
  url.port = '';
  return NextResponse.redirect(url, 301);
}

export const config = { matcher: '/:path*' };
