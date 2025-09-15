// web/src/app/api/logout/route.ts
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "../../../lib/auth";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  // Clear cookie
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
  return res;
}
