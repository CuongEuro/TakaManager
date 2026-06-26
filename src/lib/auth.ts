// ---------------------------------------------------------------------------
// AUTH — zero-dependency. scrypt password hashing + HMAC-SHA256 signed session
// cookie (a minimal JWT-like token). No native modules → safe in this env.
// ---------------------------------------------------------------------------
import {
  randomBytes,
  scryptSync,
  createHmac,
  timingSafeEqual,
} from "crypto";
import { cookies } from "next/headers";

export const SESSION_COOKIE = "taka_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface SessionPayload {
  uid: string; // user id
  oid: string; // organization id (scoping key)
  email: string;
  name: string | null;
  role: string;
  exp: number; // epoch ms
}

function secret(): string {
  return process.env.AUTH_SECRET || "dev-insecure-secret";
}

// --- password hashing -----------------------------------------------------

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// --- session token (HMAC-signed) ------------------------------------------

function sign(body: string): string {
  return createHmac("sha256", secret()).update(body).digest("base64url");
}

export function createToken(
  payload: Omit<SessionPayload, "exp">,
  ttlMs = SESSION_TTL_MS
): string {
  const full: SessionPayload = { ...payload, exp: Date.now() + ttlMs };
  const body = Buffer.from(JSON.stringify(full)).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function verifyToken(token: string | undefined | null): SessionPayload | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  try {
    const expected = sign(body);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString()
    ) as SessionPayload;
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// --- request helpers ------------------------------------------------------

/** Read & verify the session from the request cookie (Node runtime only). */
export async function getSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  return verifyToken(store.get(SESSION_COOKIE)?.value);
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  secure: process.env.NODE_ENV === "production",
  maxAge: SESSION_TTL_MS / 1000,
};
