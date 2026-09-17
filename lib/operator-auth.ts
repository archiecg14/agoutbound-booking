/**
 * Operator session auth.
 *
 * One operator, one password, a signed session cookie. Deliberately not a user table: there
 * is one person, and every account system that gets built "for later" arrives with password
 * resets, enumeration and lockout logic nobody asked for.
 *
 * What this is NOT is an excuse to be sloppy. The pages behind it show real contact data for
 * real clients, so:
 *   - an unset password fails CLOSED, never open
 *   - the password comparison is constant-time
 *   - the session is a signed, expiring payload, not a boolean cookie anyone can set
 */

import { timingSafeEqual } from "node:crypto";
import { signPayload, verifyPayload } from "./oauth.ts";

export const OPS_COOKIE = "agob_ops";
export const SESSION_HOURS = 12;

export type OpsSession = { k: "ops"; exp: number };

export type LoginResult =
  | { ok: true; token: string }
  | { ok: false; reason: "unconfigured" | "wrong" };

export function login(password: unknown): LoginResult {
  const expected = process.env.OPS_PASSWORD;

  // No password configured means nobody gets in. The tempting alternative — allow access
  // when unset, "just in dev" — is how an admin surface ends up open on a real deploy.
  if (!expected || expected.length < 12) return { ok: false, reason: "unconfigured" };
  if (typeof password !== "string") return { ok: false, reason: "wrong" };

  const a = Buffer.from(password, "utf8");
  const b = Buffer.from(expected, "utf8");
  // Length is compared first because timingSafeEqual throws on a mismatch. That leaks the
  // length, which is not useful on its own against a password the operator controls.
  const ok = a.length === b.length && timingSafeEqual(a, b);
  if (!ok) return { ok: false, reason: "wrong" };

  return { ok: true, token: signPayload({ k: "ops", exp: Date.now() + SESSION_HOURS * 3_600_000 }) };
}

/** True only for a signature we produced, with the right purpose, still in date. */
export function isOperator(cookieValue: string | null | undefined): boolean {
  const claims = verifyPayload<OpsSession>(cookieValue ?? null);
  // The purpose check stops a manage token or an OAuth state being presented as a session.
  return claims?.k === "ops";
}
