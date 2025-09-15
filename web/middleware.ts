// web/middleware.ts
import { NextRequest, NextResponse } from "next/server";
import { verifySession, SESSION_COOKIE } from "@/lib/auth";
import { canAccess, defaultRouteFor, type UserRole } from "@/lib/rbac";

// Public routes that never require auth
const PUBLIC_ALLOW = new Set<string>([
  "/login",
  "/api/login",
  "/api/logout",
  "/forbidden",
]);

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Allow Next.js internals & static assets
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.startsWith("/public")
  ) {
    return NextResponse.next();
  }

  // Public routes pass through
  if (PUBLIC_ALLOW.has(pathname)) {
    return NextResponse.next();
  }

  // Verify session
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySession(token); // -> { username, role } | null

  // Not logged in -> redirect to login (don’t render anything)
  if (!session) {
    const url = new URL("/login", req.url);
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  // Logged in but check RBAC
  const role = session.role as UserRole;
  if (!canAccess(pathname, role)) {
    // Option A: Send to a "forbidden" page
    const url = new URL("/forbidden", req.url);
    url.searchParams.set("to", pathname);
    return NextResponse.redirect(url);

    // Option B (alternative): push to their default landing
    // const url = new URL(defaultRouteFor(role), req.url);
    // return NextResponse.redirect(url);
  }

  // Everything ok
  return NextResponse.next();
}

// Apply to all routes (except static) so nothing leaks
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
