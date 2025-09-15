// web/src/app/api/login/route.ts
import { NextRequest, NextResponse } from "next/server";
import { loginUser, setSessionCookie } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const { username, password } = await req.json();

  const sess = await loginUser(username, password);
  if (!sess) {
    return NextResponse.json({ ok: false, error: "Invalid credentials" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true, user: { username: sess.username, role: sess.role } });
  setSessionCookie(res, sess.token, sess.maxAge);
  return res;
}
