/**
 * Google OAuth helpers: scopes, signed payloads, and the consent URL.
 *
 * Two different signed values here, doing different jobs:
 *
 *   invite — proves the person opening the connect link was sent it by us. Without it,
 *            /api/oauth/start is an open endpoint and anyone on the internet can attach
 *            their own calendar to a client of yours.
 *   state  — standard OAuth CSRF protection, matched against an httpOnly cookie on the
 *            callback so a forged redirect cannot complete a connection.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Scoped to /api/oauth so it is not sent with every booking-page request. */
export const OAUTH_NONCE_COOKIE = "agob_oauth_nonce";

/**
 * The narrowest scopes that do the job.
 *
 * - openid        non-sensitive; gives the stable account id, so a client changing their
 *                 email address does not look like a different calendar.
 * - freebusy      read busy blocks without reading event contents. We never need titles,
 *                 attendees or descriptions, so we never ask for them.
 * - events        create the booking. `calendar.app.created` would be narrower but is
 *                 confined to secondary calendars the app itself made, and the decision
 *                 (SPEC.md §3) is to book into the primary calendar.
 *
 * None of these are RESTRICTED, so no CASA security assessment is triggered.
 */
export const SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/calendar.events",
] as const;

/**
 * The HMAC key for every signed payload this app produces: connect invites, OAuth state,
 * manage tokens and operator sessions.
 *
 * Deliberately NOT the same value as LINKS_API_KEY. That one is a bearer token handed to
 * the lead-build tooling so it can mint links; whoever holds it would otherwise also be
 * able to forge a manage token for any booking and sign themselves an operator session.
 * A bearer credential you distribute and a signing key you never distribute are different
 * things and must not be one variable.
 *
 * There is no fallback to LINKS_API_KEY on purpose. A fallback lets someone believe they
 * have separated the two when they have not.
 *
 * Rotating this invalidates every live manage link already sitting in a calendar invitation
 * and signs out every operator session.
 */
function secret(): string {
  const s = process.env.SIGNING_KEY;
  if (!s) throw new Error("SIGNING_KEY is not set");
  return s;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** `<base64url(json)>.<sig>` — compact, URL-safe, and tamper-evident. */
export function signPayload(data: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(data), "utf8").toString("base64url");
  return `${body}.${sign(body)}`;
}

export function verifyPayload<T = Record<string, unknown>>(token: string | null): T | null {
  if (!token) return null;
  const idx = token.lastIndexOf(".");
  if (idx <= 0) return null;

  const body = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  if (!safeEqual(sig, sign(body))) return null;

  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      exp?: number;
    };
    // Expiry is enforced here rather than by each caller, so a route cannot forget to.
    if (typeof parsed.exp === "number" && parsed.exp <= Date.now()) return null;
    return parsed as T;
  } catch {
    return null;
  }
}

export function makeInvite(clientId: string, ttlMinutes = 60 * 24 * 7): string {
  return signPayload({ k: "invite", clientId, exp: Date.now() + ttlMinutes * 60_000 });
}

export function newNonce(): string {
  return randomBytes(24).toString("base64url");
}

export function consentUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
  loginHint?: string;
}): string {
  const p = new URLSearchParams({
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    // Both are required to be handed a refresh token. Without prompt=consent Google
    // returns one only on the very first grant, so a reconnect silently yields an
    // access token that expires in an hour and a connection that dies the same day.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: args.state,
  });
  if (args.loginHint) p.set("login_hint", args.loginHint);
  return `${AUTH_URL}?${p.toString()}`;
}

/**
 * Read the account id out of the id_token without verifying its signature.
 *
 * Safe here, and only here: this value arrives in the direct TLS response from Google's
 * token endpoint, not via the browser, so there is no untrusted party in the path. An
 * id_token arriving any other way MUST be verified properly before it is trusted.
 */
export function subjectFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      sub?: string;
    };
    return claims.sub ?? null;
  } catch {
    return null;
  }
}
