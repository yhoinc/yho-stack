// web/src/app/api/login/route.ts
import { NextRequest, NextResponse } from "next/server";
import { loginUser, setSessionCookie, type UserRole } from "../../../lib/auth";

export async function POST(req: NextRequest) {
  try {
    const { username, password } = await req.json();

    // loginUser returns: { token, role, username, maxAge } | null
    const user = await loginUser(username, password);
    if (!user) {
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }

    // Send minimal payload back
    const res = NextResponse.json({ ok: true, role: user.role as UserRole });

    // IMPORTANT: setSessionCookie(res, token: string, maxAgeSeconds: number)
    setSessionCookie(res, user.token, user.maxAge);

    return res;
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? "Login failed" },
      { status: 400 }
    );
  }
}
