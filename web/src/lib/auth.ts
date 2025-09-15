// web/src/lib/auth.ts
// Minimal cookie-based session helpers usable on Edge runtime.

export type UserRole = "admin" | "staff";
export const SESSION_COOKIE = "yho_session";

// TODO: replace with a real user store
const USERS: Record<string, { password: string; role: UserRole }> = {
  admin: { password: "admin", role: "admin" },
  danny: { password: "Yho", role: "staff" },
  heejung: { password: "Yho", role: "staff" },
};

export async function loginUser(username: string, password: string) {
  const rec = USERS[username];
  if (!rec || rec.password !== password) return null;
  const token = `${username}:${rec.role}`; // "username:role"
  const maxAge = 60 * 60 * 12; // 12h
  return { token, role: rec.role, username, maxAge };
}

export function parseSessionCookie(raw: string | undefined | null) {
  if (!raw) return null;
  const [username, role] = raw.split(":");
  if (!username || (role !== "admin" && role !== "staff")) return null;
  return { username, role: role as UserRole };
}
