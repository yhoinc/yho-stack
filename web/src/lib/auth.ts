// web/src/lib/auth.ts
import crypto from "crypto";
import { cookies } from "next/headers";

export type Role = "admin" | "staff";
export type Session = { user: string; role: Role };

const AUTH_SECRET = process.env.AUTH_SECRET || "dev-secret-change-me";

// hard-coded users (replace with DB when ready)
const USERS: Record<string, { password: string; role: Role }> = {
  admin: { password: "admin", role: "admin" },
  danny: { password: "Yho", role: "staff" },
  heejung: { password: "Yho", role: "staff" },
};

function sign(payload: object): string {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", AUTH_SECRET).update(data).digest("base64url");
  return `${data}.${sig}`;
}

function verify(token: string): any | null {
  const [data, sig] = token.split(".");
  if (!data || !sig) return null;
  const expect = crypto.createHmac("sha256", AUTH_SECRET).update(data).digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    return JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export async function loginUser(username: string, password: string): Promise<Session | null> {
  const u = USERS[username];
  if (!u || u.password !== password) return null;
  return { user: username, role: u.role };
}

export async function setSessionCookie(sess: Session) {
  const token = sign({ ...sess, iat: Date.now() });
  (await cookies()).set("session", token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 8, // 8h
  });
}

export async function clearSessionCookie() {
  (await cookies()).set("session", "", { path: "/", maxAge: 0 });
}

export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  const token = jar.get("session")?.value;
  if (!token) return null;
  const payload = verify(token);
  if (!payload) return null;
  return { user: payload.user, role: payload.role };
}

export async function requireRole(min: Role): Promise<Session | never> {
  const sess = await getSession();
  if (!sess) throw new Error("unauthenticated");
  if (min === "admin" && sess.role !== "admin") throw new Error("forbidden");
  return sess;
}
