// web/src/lib/auth.ts
// Minimal helpers for cookie-based session.
// NO Node 'crypto' here so it's Edge-safe.

export type UserRole = "admin" | "staff";
export const SESSION_COOKIE = "yho_session";

// Hard-coded users for now
const USERS: Record<string, { password: string; role: UserRole }> = {
  admin: { password: "admin", role: "admin" },
  danny: { password: "Yho", role: "staff" },
  heejung: { password: "Yho", role: "staff" },
};

export async function loginUser(username: string, password: string) {
  const rec = USERS[username];
  if (!rec || rec.password !== password) return null;
  // Cookie payload — keep it simple: "username:role"
  const token = `${username}:${rec.role}`;
  // 12 hours
  const maxAge = 60 * 60 * 12;
  return { token, role: rec.role, username, maxAge };
}

export function parseSessionCookie(raw: string | undefined | null) {
  if (!raw) return null;
  // token format: "username:role"
  const [username, role] = raw.split(":");
  if (!username || (role !== "admin" && role !== "staff")) return null;
  return { username, role: role as UserRole };
}
