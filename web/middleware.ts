// web/middleware.ts
import { NextResponse, type NextRequest } from "next/server";
// IMPORTANT: this path must be relative from project root
import { verifySession, type UserRole } from "./src/lib/auth";

const PUBLIC_PATHS = new Set<string>([
  "/login",
  "/forbidden",
  "/api/login",
  "/api/logout",
]);

// Which roles can access which top-level sections
const ACCESS: Record<UserRole, Array<string>> = {
  admin: ["employees", "payroll", "reports", "documents", ""], // "" = homepage
  staff: ["employees", "documents", ""],
};

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  // Skip Next internals and public assets
  if (
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/favicon") ||
    pathname.startsWith("/robots") ||
    pathname.startsWith("/sitemap")
  ) {
    return NextResponse.next();
  }

  // Public routes that never require auth
  if (PUBLIC_PATHS.has(pathname)) {
    return NextResponse.next();
  }

  // Verify session (cookie is read inside verifySession)
  const session = await verifySession(req);
  const hasSession = !!session;

  // If no session, send to /login and remember where they were going
  if (!hasSession) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = search ? `?next=${encodeURIComponent(pathname + search)}` : `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(url);
  }

  // Role-based gate
  const role = session.role as UserRole;
  const top = pathname.split("/")[1] ?? ""; // "", "employees", "payroll", ...
  const allowed = ACCESS[role] ?? [];

  if (!allowed.includes(top)) {
    const url = req.nextUrl.clone();
    url.pathname = "/forbidden";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

// Run on all paths except Next internals (handled above)
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
