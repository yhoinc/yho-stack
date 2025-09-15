// web/src/app/api/login/route.ts
import { NextRequest, NextResponse } from "next/server";
import { loginUser, SESSION_COOKIE } from "../../../lib/auth";

export async function POST(req: NextRequest) {
  const { username, password } = await req.json();

  const user = await loginUser(String(username || ""), String(password || ""));
  if (!user) {
    return NextResponse.json({ ok: false, error: "Invalid credentials" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true, role: user.role });

  // Set httpOnly cookie (12h)
  res.cookies.set(SESSION_COOKIE, user.token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: user.maxAge,
  });

  return res;
}
