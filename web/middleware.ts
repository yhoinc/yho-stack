// web/middleware.ts
import { NextResponse, type NextRequest } from "next/server";
// Use a RELATIVE import from project root (works on Render)
import { verifySession, SESSION_COOKIE, type UserRole } from "./src/lib/auth";

const PUBLIC_PATHS = new Set<string>([
  "/login",
  "/forbidden",
  "/api/login",
  "/api/logout",
]);

// Section access per role
const ACCESS: Record<UserRole, Array<string>> = {
  admin: ["", "employees", "payroll", "reports", "documents"], // "" = homepage
  staff: ["", "employees", "documents"],
};

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  // Skip Next internals & obvious public assets
  if (
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/favicon") ||
    pathname.startsWith("/robots") ||
    pathname.startsWith("/sitemap")
  ) {
    return NextResponse.next();
  }

  // Public routes never require auth
  if (PUBLIC_PATHS.has(pathname)) {
    return NextResponse.next();
  }

  // Get the cookie value and validate it
  const cookieVal = req.cookies.get(SESSION_COOKIE)?.value ?? "";
  const session = await verifySession(cookieVal); // <— pass string, not the request
  const hasSession = !!session;

  // Not logged in → redirect to /login and preserve intended dest
  if (!hasSession) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = search
      ? `?next=${encodeURIComponent(pathname + search)}`
      : `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(url);
  }

  // Role-based gating
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

// Apply to everything except Next internals / favicon
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
