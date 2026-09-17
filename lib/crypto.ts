/**
 * Envelope encryption for stored OAuth refresh tokens.
 *
 * The bookings schema calls the column `refresh_token_enc`. Until this module existed the
 * code wrote plaintext into it, which is the worst of both worlds: a name that tells every
 * future reader the secret is protected, and a value that isn't. Either encrypt it or
 * rename the column — this file is the first option.
 *
 * A refresh token is a long-lived key to a client's calendar. It survives password changes
 * and is not covered by the database's own at-rest encryption once someone holds a service
 * key or a backup dump.
 *
 * AES-256-GCM: authenticated, so tampering fails loudly rather than decrypting to rubbish.
 * Format is v1.<iv>.<ciphertext>.<tag>, all base64url, versioned so the scheme can be
 * rotated without guessing at what old rows contain.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12; // 96 bits, the GCM standard
const KEY_BYTES = 32;

export class CryptoNotConfigured extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoNotConfigured";
  }
}

/**
 * Key from env, as 32 bytes of base64. Generate one with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */
function key(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  // Never fall back to a default or derived key. A deploy without this must fail, not
  // quietly encrypt everything with a value an attacker can read in the source.
  if (!raw) throw new CryptoNotConfigured("TOKEN_ENCRYPTION_KEY is not set");

  const buf = Buffer.from(raw, "base64");
  if (buf.length !== KEY_BYTES) {
    throw new CryptoNotConfigured(
      `TOKEN_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${buf.length}`,
    );
  }
  return buf;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), enc.toString("base64url"), tag.toString("base64url")].join(".");
}

export function decryptSecret(stored: string): string {
  const parts = stored.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("stored secret is not in the expected v1 format");
  }

  const [, ivB64, dataB64, tagB64] = parts;
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  // Throws if the ciphertext or tag was altered. That is the point: a tampered token must
  // fail, never silently decrypt to something usable.
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]).toString("utf8");
}

/** True when a stored value looks like this scheme rather than a legacy plaintext row. */
export function isEncrypted(stored: string): boolean {
  return stored.startsWith(`${VERSION}.`) && stored.split(".").length === 4;
}
