/**
 * Manage tokens — the credential that lets an attendee reschedule or cancel.
 *
 * Deliberately NOT a second row in link_tokens. The booking link is single-use and is
 * consumed the moment it books; a manage credential has to outlive that, and giving a
 * prospect a second stored token to lose is more machinery for no benefit.
 *
 * Instead it is an HMAC over the booking id with an expiry baked in. Nothing to store,
 * nothing to clean up, and it cannot be forged without the signing secret. The booking id
 * is a UUID, so the token does not leak anything about the lead the way an email-derived
 * one would.
 *
 * It expires a while AFTER the call, not at the start time: someone who needs to cancel
 * ten minutes late still should be able to, and a link that dies exactly at the meeting is
 * useless precisely when it is most needed.
 */

import { signPayload, verifyPayload } from "./oauth.ts";

/** How long after the call ends the manage link keeps working. */
export const MANAGE_GRACE_HOURS = 24;

export type ManageClaims = { k: "manage"; bookingId: string; exp: number };

export function mintManageToken(bookingId: string, endUtc: string): string {
  const end = Date.parse(endUtc);
  const exp = Number.isNaN(end)
    ? Date.now() + 30 * 86_400_000
    : end + MANAGE_GRACE_HOURS * 3_600_000;
  return signPayload({ k: "manage", bookingId, exp });
}

export function readManageToken(token: string | null): ManageClaims | null {
  const claims = verifyPayload<ManageClaims>(token);
  // The purpose check matters: without it, any signed payload this app produces — an OAuth
  // state, a connect invite — would be accepted as a manage credential.
  if (!claims || claims.k !== "manage" || typeof claims.bookingId !== "string") return null;
  return claims;
}

export function manageUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/m/${token}`;
}

export type ManageRefusal =
  | "not_found"
  | "already_cancelled"
  | "too_late"
  | "invalid_token"
  | "slot_not_offered";

/**
 * Whether a booking can still be changed. Pure, so the rule is testable without a database.
 *
 * Cancelling after the call has started is allowed — it is how a no-show gets recorded
 * honestly. Rescheduling into the past is not, because the new time has to be bookable.
 */
export function canManage(
  booking: { status: string; startUtc: string } | null,
  now: string,
): { ok: true } | { ok: false; reason: ManageRefusal } {
  if (!booking) return { ok: false, reason: "not_found" };
  if (booking.status === "cancelled") return { ok: false, reason: "already_cancelled" };

  const nowMs = Date.parse(now);
  const end = Date.parse(booking.startUtc);
  if (Number.isNaN(nowMs) || Number.isNaN(end)) return { ok: false, reason: "invalid_token" };

  // The token's own expiry is the real guard; this catches a booking so old that acting on
  // it would be surprising rather than helpful.
  if (nowMs > end + MANAGE_GRACE_HOURS * 3_600_000) return { ok: false, reason: "too_late" };
  return { ok: true };
}

export function manageRefusalMessage(reason: ManageRefusal): { status: number; message: string } {
  switch (reason) {
    case "already_cancelled":
      return { status: 409, message: "This booking has already been cancelled." };
    case "too_late":
      return { status: 409, message: "This booking can no longer be changed." };
    case "slot_not_offered":
      return { status: 409, message: "That time is no longer available. Please pick another." };
    default:
      return { status: 404, message: "This link is not valid." };
  }
}
