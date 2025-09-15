// web/src/app/api/login/route.ts
import { NextResponse } from "next/server";
import { createSession, SESSION_COOKIE, type UserRole } from "@/lib/auth";

type Cred = { password: string; role: UserRole };

// Hard-coded users you requested:
const USERS: Record<string, Cred> = {
  admin:   { password: "admin", role: "admin" },
  danny:   { password: "Yho",   role: "staff" },
  heejung: { password: "Yho",   role: "staff" },
};

export async function POST(req: Request) {
  const { username, password } = await req.json().catch(() => ({}));
  if (!username || !password) {
    return NextResponse.json({ ok: false, error: "Missing credentials" }, { status: 400 });
  }

  const rec = USERS[username];
  if (!rec || rec.password !== password) {
    return NextResponse.json({ ok: false, error: "Invalid username/password" }, { status: 401 });
  }

  const token = await createSession({ u: username, role: rec.role });
  const res = NextResponse.json({ ok: true, role: rec.role });

  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7, // 7 days
  });

  return res;
}
