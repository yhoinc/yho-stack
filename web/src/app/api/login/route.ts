// web/src/app/api/login/route.ts
import { NextRequest, NextResponse } from "next/server";
import { loginUser, setSessionCookie } from "../../../lib/auth";

export async function POST(req: NextRequest) {
  const { username, password } = await req.json();
  const sess = await loginUser(username, password);
  if (!sess) {
    return NextResponse.json({ ok: false, error: "Invalid credentials" }, { status: 401 });
  }
  await setSessionCookie(sess);
  return NextResponse.json({ ok: true, role: sess.role });
}
