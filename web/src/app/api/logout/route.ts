// web/src/app/api/logout/route.ts
import { NextResponse } from "next/server";
import { clearSessionCookie } from "../../../lib/auth";

export async function POST() {
  await clearSessionCookie();
  return NextResponse.json({ ok: true });
}
