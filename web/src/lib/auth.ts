// web/src/lib/auth.ts
/* Minimal cookie-based auth for YHO.
   Users are fixed (per requirements) and sessions are HMAC-signed with AUTH_SECRET.
   Works in Middleware (Edge) and Route Handlers (Node) via Web Crypto.
*/
export type UserRole = "admin" | "staff";
export const SESSION_COOKIE = "yho_session";

type UserRecord = { username: string; password: string; role: UserRole };

const USERS: UserRecord[] = [
  { username: "admin",  password: "admin", role: "admin" },
  { username: "danny",  password: "Yho",   role: "staff" },
  { username: "heejung", password: "Yho",  role: "staff" },
];

const b64url = (buf: ArrayBuffer | Uint8Array) =>
  Buffer.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

const fromB64url = (s: string) =>
  Uint8Array.from(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));

async function getKey() {
  const secret = process.env.AUTH_SECRET || "dev-secret-change-me";
  const enc = new TextEncoder().encode(secret);
  return await crypto.subtle.importKey(
    "raw",
    enc,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

/** Create a signed session token containing username, role, and exp (epoch seconds). */
export async function createSession(username: string, role: UserRole, ttlDays = 7) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: username, role, iat: now, exp: now + ttlDays * 86400 };

  const h = b64url(new TextEncoder().encode(JSON.stringify(header)));
  const p = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const data = new TextEncoder().encode(`${h}.${p}`);

  const key = await getKey();
  const sig = await crypto.subtle.sign("HMAC", key, data);
  const s = b64url(sig);

  return `${h}.${p}.${s}`;
}

/** Verify a session token. Returns { username, role } if valid, else null. */
export async function verifySession(token?: string | null): Promise<{ username: string; role: UserRole } | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [h, p, s] = parts;
  const key = await getKey();

  const data = new TextEncoder().encode(`${h}.${p}`);
  const sigOk = await crypto.subtle.verify("HMAC", key, fromB64url(s), data);
  if (!sigOk) return null;

  try {
    const payloadJson = new TextDecoder().decode(fromB64url(p));
    const payload = JSON.parse(payloadJson) as { sub: string; role: UserRole; exp: number };
    if (!payload?.sub || !payload?.role || !payload?.exp) return null;
    if (Math.floor(Date.now() / 1000) >= payload.exp) return null;
    return { username: payload.sub, role: payload.role };
  } catch {
    return null;
  }
}

/** Check username/password against the fixed users list. Returns role or null. */
export function validateUser(username: string, password: string): UserRole | null {
  const u = USERS.find(
    (x) => x.username.toLowerCase() === String(username || "").toLowerCase()
  );
  if (!u) return null;
  return u.password === password ? u.role : null;
}

/** Helper to format a Set-Cookie header for the session cookie. */
export function makeSessionCookie(token: string, maxAgeDays = 7) {
  const maxAge = maxAgeDays * 86400;
  // Path=/ makes the cookie available to the whole site; HttpOnly for security.
  // Secure;SameSite=Lax is good for first-party auth.
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

/** Helper to clear the cookie. */
export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
