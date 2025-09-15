// web/middleware.ts
import { NextResponse, type NextRequest } from "next/server";

// IMPORTANT: keep this name in sync with /src/lib/auth.ts
const SESSION_COOKIE = "yho_session";

// Public paths that do NOT require auth
const PUBLIC = [/^\/login$/, /^\/api\/login$/, /^\/api\/logout$/];

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  // Skip Next internals & static assets
  if (
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/favicon") ||
    pathname.startsWith("/robots") ||
    pathname.startsWith("/sitemap")
  ) {
    return NextResponse.next();
  }

  // Allow public routes
  if (PUBLIC.some((re) => re.test(pathname))) {
    return NextResponse.next();
  }

  // Require a session cookie for everything else
  const hasSession = !!req.cookies.get(SESSION_COOKIE)?.value;
  if (!hasSession) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = search
      ? `?next=${encodeURIComponent(pathname + search)}`
      : `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(url);
  }

  // (Optional) mark that middleware ran, for debugging in DevTools
  const res = NextResponse.next();
  res.headers.set("x-mw-hit", "1");
  return res;
}

// Catch all paths; we filter inside the function
export const config = {
  matcher: ["/:path*"],
};
