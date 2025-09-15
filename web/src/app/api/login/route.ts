// web/src/app/api/login/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { loginUser, SESSION_COOKIE } from "../../../lib/auth";

export async function POST(req: Request) {
  const { username, password } = await req.json().catch(() => ({} as any));
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
    secure: true, // set false locally if needed, but keep true in prod/Render
    path: "/",
    maxAge: res.maxAge,
  });

  return NextResponse.json({ ok: true, role: res.role, username: res.username });
}
