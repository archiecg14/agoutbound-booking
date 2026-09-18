/**
 * Email confirmation for public bookings.
 *
 * The per-lead path needs none of this. That link was mailed to one address, so using it
 * already proves control of the mailbox. The public page proves nothing — anyone can type
 * anyone's address — so until the address answers, what exists is a HOLD, not a booking.
 *
 * A hold is deliberately not a booking:
 *   - status 'pending', so reconcile.py, ledger-sync.py and the reminder sweep all skip it
 *   - no Google event, so nothing reaches the client's calendar and no invitation is sent
 *   - it blocks its slot for HOLD_MINUTES, then stops mattering without anyone acting
 *
 * Expiry is applied where availability is computed rather than by a sweeper. A cron job that
 * quietly stopped running would otherwise freeze a client's calendar behind holds nobody can
 * see, and that failure would be invisible until a prospect complained. Expired rows are
 * left alone as an honest record of an abandoned attempt.
 *
 * The token is 32 random bytes with only its SHA-256 stored, matching link_tokens. The
 * alternative — an HMAC payload, as manage tokens use — was rejected because the row has to
 * be read anyway to check the hold has not expired, so storing a hash costs nothing and
 * makes a database leak useless to an attacker.
 */

import { hashToken, isWellFormedToken, mintToken, type MintedToken } from "./tokens.ts";

/** How long a slot is held for someone who has not answered their email yet. */
export const HOLD_MINUTES = 15;

export type ConfirmRefusal = "invalid_token" | "not_found" | "expired" | "cancelled" | "slot_gone";

export function mintConfirmToken(): MintedToken {
  return mintToken();
}

export { hashToken as hashConfirmToken, isWellFormedToken as isWellFormedConfirmToken };

export function holdExpiresAt(now: string): string {
  return new Date(Date.parse(now) + HOLD_MINUTES * 60_000).toISOString();
}

export function confirmUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/c/${token}`;
}

export type HoldRow = { status: string; confirmExpiresAt: string | null };

/**
 * Whether this hold can still become a booking. Pure, so every branch is testable without a
 * database or a clock.
 *
 * An already-confirmed row is a SUCCESS, not an error. People click the link twice, mail
 * clients prefetch it, and someone who sees "this link is invalid" after successfully
 * booking will assume they have no call and book again.
 */
export function canConfirm(
  row: HoldRow | null,
  now: string,
): { ok: true; already: boolean } | { ok: false; reason: ConfirmRefusal } {
  if (!row) return { ok: false, reason: "not_found" };
  if (row.status === "confirmed") return { ok: true, already: true };
  if (row.status === "cancelled" || row.status === "rescheduled") {
    return { ok: false, reason: "cancelled" };
  }
  if (row.status !== "pending") return { ok: false, reason: "not_found" };

  const exp = row.confirmExpiresAt ? Date.parse(row.confirmExpiresAt) : Number.NaN;
  const nowMs = Date.parse(now);
  // A pending row with no expiry is not a hold this code created. Treating it as valid
  // would mean any such row could be confirmed forever.
  if (Number.isNaN(exp) || Number.isNaN(nowMs)) return { ok: false, reason: "expired" };
  if (nowMs > exp) return { ok: false, reason: "expired" };

  return { ok: true, already: false };
}

/**
 * The confirmation email.
 *
 * Carries NO text the booker typed — not their note, and not even their name.
 *
 * The whole point of this step is that the address is unverified, so this email may land in
 * the inbox of someone who did nothing. Reflecting a stranger's free text into a mail sent
 * from the client's own sending domain would turn the confirmation step into the delivery
 * channel it exists to close. The greeting is worth less than that.
 */
export function composeConfirmEmail(a: {
  clientName: string;
  eventName: string;
  startUtc: string;
  endUtc: string;
  attendeeTz: string;
  url: string;
}): { subject: string; text: string } {
  const tz = a.attendeeTz || "UTC";
  const fmt = (iso: string, opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...opts }).format(new Date(iso));

  const day = fmt(a.startUtc, { weekday: "long", day: "numeric", month: "long" });
  const from = fmt(a.startUtc, { hour: "2-digit", minute: "2-digit", hour12: false });
  const to = fmt(a.endUtc, { hour: "2-digit", minute: "2-digit", hour12: false });

  return {
    subject: `Confirm your call with ${a.clientName}`,
    text: [
      `One tap and your ${a.eventName.toLowerCase()} is booked.`,
      "",
      `When:  ${day}, ${from}–${to} (${tz.replace(/_/g, " ")})`,
      `With:  ${a.clientName}`,
      "",
      `Confirm: ${a.url}`,
      "",
      `The time is held for ${HOLD_MINUTES} minutes.`,
      "",
      "If you didn't ask for this, ignore this email. Nothing is booked, no invitation",
      "will be sent, and the time is released automatically.",
    ].join("\n"),
  };
}

export function confirmRefusalMessage(reason: ConfirmRefusal): { title: string; body: string } {
  switch (reason) {
    case "expired":
      return {
        title: "This hold has expired",
        body: "We only hold a time for a few minutes. Pick another time and we'll send a fresh link.",
      };
    case "cancelled":
      return { title: "Nothing to confirm", body: "This booking has already been cancelled." };
    case "slot_gone":
      return {
        title: "That time has gone",
        body: "Someone confirmed it first. Pick another time — it only takes a moment.",
      };
    default:
      return {
        title: "This link is not valid",
        body: "It may have already been used. If you're not sure whether you're booked, just book again.",
      };
  }
}
