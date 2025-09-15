import { NextRequest, NextResponse } from "next/server";
import { verifySession, SESSION_COOKIE, type UserRole } from "@/lib/auth";

// Paths to gate
const PROTECTED_PREFIXES = ["/employees", "/documents", "/payroll", "/reports"] as const;
type ProtectedPath = (typeof PROTECTED_PREFIXES)[number];

const ACCESS: Record<UserRole, ProtectedPath[]> = {
  admin:  ["/employees", "/documents", "/payroll", "/reports"],
  staff:  ["/employees", "/documents"], // danny + heejung
};

function isProtectedPath(pathname: string) {
  return PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Allow public assets & login page
  if (pathname.startsWith("/_next") || pathname.startsWith("/favicon") || pathname === "/login") {
    return NextResponse.next();
  }

  if (!isProtectedPath(pathname)) {
    // Everything else is public (home page, etc.) — change if you want tighter rules
    return NextResponse.next();
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySession(token);

  if (!session) {
    const url = new URL("/login", req.url);
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  // Role check
  const allowed = ACCESS[session.role as UserRole] || [];
  const ok = allowed.some((p) => pathname === p || pathname.startsWith(p + "/"));
  if (!ok) {
    return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.next();
}

// Only run for app routes (not static files)
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
