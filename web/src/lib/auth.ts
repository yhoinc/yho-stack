// web/src/lib/auth.ts
import { createHmac, timingSafeEqual } from "crypto";

export type UserRole = "admin" | "staff";

/** Cookie + secret */
export const SESSION_COOKIE = "yho_session";
const AUTH_SECRET = process.env.AUTH_SECRET || "dev-secret-change-me";

/** In-memory user list (simple demo auth). */
type UserRow = {
  username: string;
  password: string; // plain for demo only
  role: UserRole;
  // Which sections they can access (middleware also checks role)
  scopes: Array<"employees" | "documents" | "payroll" | "reports" | "all">;
};

const USERS: UserRow[] = [
  { username: "admin",  password: "admin", role: "admin", scopes: ["all"] },
  { username: "danny",  password: "Yho",   role: "staff", scopes: ["employees", "documents"] },
  { username: "heejung",password: "Yho",   role: "staff", scopes: ["employees", "documents"] },
];

/** Find a user by creds (constant-time compare on password where possible). */
function findUser(username: string, password: string): UserRow | null {
  const u = USERS.find(x => x.username === username);
  if (!u) return null;
  // Simple compare (demo). For production, hash & salt.
  return u.password === password ? u : null;
}

/** Tiny HMAC-signed token (not JWT) */
function sign(data: string): string {
  const sig = createHmac("sha256", AUTH_SECRET).update(data).digest("base64url");
  return sig;
}
function verify(data: string, sig: string): boolean {
  try {
    const expect = createHmac("sha256", AUTH_SECRET).update(data).digest();
    const got = Buffer.from(sig, "base64url");
    return expect.length === got.length && timingSafeEqual(expect, got);
  } catch {
    return false;
  }
}

type SessionPayload = { username: string; role: UserRole; iat: number };
type ParsedToken = { payload: SessionPayload; rawPayload: string; sig: string };

/** Make a short token ~ "base64(payload).sig" */
function encodeSession(p: SessionPayload): string {
  const raw = Buffer.from(JSON.stringify(p)).toString("base64url");
  const sig = sign(raw);
  return `${raw}.${sig}`;
}
function decodeSession(token: string): ParsedToken | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [raw, sig] = parts;
  if (!verify(raw, sig)) return null;
  try {
    const payload = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as SessionPayload;
    if (!payload?.username || !payload?.role) return null;
    return { payload, rawPayload: raw, sig };
  } catch {
    return null;
  }
}

/** PUBLIC: log in -> returns token + role + cookie maxAge */
export async function loginUser(username: string, password: string) {
  const u = findUser(String(username || ""), String(password || ""));
  if (!u) return null;
  const payload: SessionPayload = { username: u.username, role: u.role, iat: Math.floor(Date.now()/1000) };
  const token = encodeSession(payload);
  // 7 days
  return { token, role: u.role, username: u.username, maxAge: 60 * 60 * 24 * 7 };
}

/** PUBLIC: verify cookie -> user or null */
export function verifySession(token: string | undefined | null) {
  if (!token) return null;
  const parsed = decodeSession(token);
  if (!parsed) return null;
  const { username, role } = parsed.payload;
  const user = USERS.find(u => u.username === username && u.role === role);
  if (!user) return null;
  return { username, role, scopes: user.scopes };
}

/** PUBLIC: cookie helpers for NextResponse */
export function setSessionCookie(res: import("next/server").NextResponse, token: string, maxAgeSec: number) {
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: maxAgeSec,
  });
}
export function clearSessionCookie(res: import("next/server").NextResponse) {
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: 0,
  });
}

/** Optional helper: route-level access */
export function userHasAccess(pathname: string, role: UserRole, scopes: UserRow["scopes"]) {
  if (role === "admin" || scopes.includes("all")) return true;
  if (pathname.startsWith("/employees")) return scopes.includes("employees");
  if (pathname.startsWith("/documents")) return scopes.includes("documents");
  if (pathname.startsWith("/payroll"))   return scopes.includes("payroll");
  if (pathname.startsWith("/reports"))   return scopes.includes("reports");
  return false;
}
