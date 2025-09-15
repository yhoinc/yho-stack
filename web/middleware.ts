// web/middleware.ts
import { NextResponse, type NextRequest } from "next/server";

// Keep this in sync with src/lib/auth.ts
const SESSION_COOKIE = "yho_session";

// Paths that do NOT require auth
const PUBLIC: RegExp[] = [/^\/login$/, /^\/api\/login$/, /^\/api\/logout$/];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Skip Next internals & static files
  if (
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/favicon") ||
    pathname.startsWith("/assets/") ||
    pathname.match(/\.(png|jpg|jpeg|gif|svg|ico|css|js|map|txt|woff2?)$/)
  ) {
    return NextResponse.next();
  }

  // Allow public routes
  if (PUBLIC.some(rx => rx.test(pathname))) {
    return NextResponse.next();
  }

  // Read session cookie
  const session = req.cookies.get(SESSION_COOKIE)?.value ?? null;
  if (!session) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = pathname && pathname !== "/" ? `?next=${encodeURIComponent(pathname)}` : "";
    return NextResponse.redirect(url);
  }

  // Optionally restrict by role example:
  // const [, role] = session.split(":");
  // if (pathname.startsWith("/admin") && role !== "admin") {
  //   const url = req.nextUrl.clone();
  //   url.pathname = "/";
  //   return NextResponse.redirect(url);
  // }

  const res = NextResponse.next();
  res.headers.set("x-auth-mw", "1");
  return res;
}

// Match all paths and filter inside
export const config = {
  matcher: ["/:path*"],
};
