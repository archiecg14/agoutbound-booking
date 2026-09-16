/**
 * Per-lead booking tokens.
 *
 * Design note, because the obvious alternative is worse: the token carries NO payload. It
 * is 32 random bytes, base64url. The attribution — lead, campaign, wave, step — lives in
 * the `link_tokens` row and never travels in the URL.
 *
 * An HMAC-signed payload token would let us verify without touching the database, but we
 * have to touch it anyway to check expiry and single-use. Meanwhile a payload token leaks
 * the lead's details to anyone who sees the URL (including every proxy, referrer header and
 * over-the-shoulder glance), and it cannot be revoked. A random lookup key has neither
 * problem.
 *
 * Only the SHA-256 of the token is stored. A database leak therefore cannot be turned into
 * working booking links: you would need a preimage, not a row.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 32 bytes → 43 base64url characters. */
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type MintedToken = { token: string; tokenHash: string };

export function mintToken(): MintedToken {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Cheap shape check before any database round trip. Rejects the overwhelming majority of
 * junk — scanners, truncated links, pasted whitespace — without touching Postgres.
 */
export function isWellFormedToken(token: unknown): token is string {
  return typeof token === "string" && TOKEN_PATTERN.test(token);
}

/**
 * Constant-time hash comparison. Not needed for the indexed lookup itself, but used
 * anywhere a hash is compared in application code so the habit never has to be remembered.
 */
export function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
