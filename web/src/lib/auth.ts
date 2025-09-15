import { SignJWT, jwtVerify, type JWTPayload } from "jose";

const secret = new TextEncoder().encode(process.env.AUTH_SECRET || "dev-secret-change");
export const SESSION_COOKIE = "session";

export type UserRole = "admin" | "staff";
export type SessionPayload = JWTPayload & { u: string; role: UserRole };

export async function createSession(payload: { u: string; role: UserRole }) {
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secret);
}

export async function verifySession(token: string | undefined): Promise<SessionPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret);
    return payload as SessionPayload;
  } catch {
    return null;
  }
}
