/**
 * Shared-secret auth for the internal endpoints.
 *
 * `/api/bookings` is public by necessity — a prospect calls it. `/api/links` is the
 * opposite: anyone who can mint links can mint one for any lead and any campaign, so it is
 * authenticated and must stay that way.
 *
 * Comparison is constant-time. A byte-by-byte early-exit comparison leaks the secret to a
 * patient caller one character at a time, and this endpoint is reachable from the internet.
 */

import { timingSafeEqual } from "node:crypto";

export type AuthResult = { ok: true } | { ok: false; reason: "missing" | "invalid" | "unconfigured" };

export function checkBearer(header: string | null, expected: string | undefined): AuthResult {
  // An unset key must never mean "allow". A misconfigured deploy fails closed.
  if (!expected) return { ok: false, reason: "unconfigured" };
  if (!header) return { ok: false, reason: "missing" };

  const match = /^Bearer (.+)$/.exec(header.trim());
  if (!match) return { ok: false, reason: "missing" };

  const given = Buffer.from(match[1], "utf8");
  const want = Buffer.from(expected, "utf8");

  // timingSafeEqual throws on a length mismatch, so length is checked first — which does
  // leak the secret's length. That is an acceptable trade: length alone is not useful, and
  // the alternative (hashing both sides first) adds a dependency on hash choice for no
  // practical gain here.
  if (given.length !== want.length) return { ok: false, reason: "invalid" };
  return timingSafeEqual(given, want) ? { ok: true } : { ok: false, reason: "invalid" };
}
