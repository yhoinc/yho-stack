// web/src/app/api/login/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { loginUser, SESSION_COOKIE } from "@/src/lib/auth";

export async function POST(req: Request) {
  const { username, password } = await req.json().catch(() => ({}));
  if (!username || !password) {
    return NextResponse.json({ ok: false, error: "Missing credentials" }, { status: 400 });
  }
  const res = await loginUser(username, password);
  if (!res) {
    return NextResponse.json({ ok: false, error: "Invalid username or password" }, { status: 401 });
  }
  const jar = await cookies();
  jar.set(SESSION_COOKIE, res.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: res.maxAge,
  });
  return NextResponse.json({ ok: true, role: res.role, username: res.username });
}
