import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// Opaque token prefixes (not JWTs — random strings, hashed at rest).
export const TOKEN_PREFIX = {
  access: "amcp_at_",
  refresh: "amcp_rt_",
  code: "amcp_ac_"
} as const;

/** 32 bytes of entropy, base64url, with a human-readable prefix. */
export function generateToken(prefix: string): string {
  return prefix + randomBytes(32).toString("base64url");
}

/** Random id for pending authorizations / chains (no secret value). */
export function randomId(bytes = 16): string {
  return randomBytes(bytes).toString("base64url");
}

/** SHA-256 hex. Tokens and agent secrets are only ever stored hashed. */
export function sha256hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Constant-time comparison of two hex digests. */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/**
 * PKCE S256 verification: BASE64URL(SHA256(verifier)) must equal the challenge.
 * Only S256 is supported (plain is rejected upstream).
 */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!verifier || !challenge) return false;
  const computed = createHash("sha256").update(verifier, "utf8").digest("base64url");
  if (computed.length !== challenge.length) return false;
  try {
    return timingSafeEqual(Buffer.from(computed), Buffer.from(challenge));
  } catch {
    return false;
  }
}

/** Hash a console password with scrypt. Returns "salt:hash" (both hex). */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

/** Verify a password against a stored "salt:hash". Constant-time. */
export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  try {
    const hash = scryptSync(password, Buffer.from(saltHex, "hex"), 64);
    const expected = Buffer.from(hashHex, "hex");
    return hash.length === expected.length && timingSafeEqual(hash, expected);
  } catch {
    return false;
  }
}

/** Parse a cookie header into a map. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/** Extract a Bearer token from an Authorization header. */
export function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m && m[1] ? m[1].trim() : null;
}
