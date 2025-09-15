// web/src/app/api/login/route.ts
import { NextRequest, NextResponse } from "next/server";
import { loginUser, setSessionCookie, type UserRole } from "../../../lib/auth";

export async function POST(req: NextRequest) {
  try {
    const { username, password } = await req.json();

    const user = await loginUser(username, password); // returns { token, role, username, maxAge } | null
    if (!user) {
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }

    // respond
    const res = NextResponse.json({ ok: true, role: user.role as UserRole });

    // NOTE: setSessionCookie(res, session, maxAgeSeconds)
    setSessionCookie(res, { username: user.username, role: user.role as UserRole }, user.maxAge);

    return res;
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? "Login failed" },
      { status: 400 }
    );
  }
}
