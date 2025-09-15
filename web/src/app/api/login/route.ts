// web/src/app/api/login/route.ts
import { NextRequest, NextResponse } from "next/server";
import {
  validateUser,
  createSession,
  makeSessionCookie,
  type UserRole,
} from "@/lib/auth";

export async function POST(req: NextRequest) {
  try {
    const { username, password } = await req.json();

    const role = validateUser(String(username || ""), String(password || ""));
    if (!role) {
      return NextResponse.json({ ok: false, error: "Invalid credentials" }, { status: 401 });
    }

    // create signed token and set cookie
    const token = await createSession(username, role as UserRole, 7);
    const res = NextResponse.json({ ok: true, role });
    res.headers.set("Set-Cookie", makeSessionCookie(token, 7));
    return res;
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message || "Login failed" }, { status: 400 });
  }
}
