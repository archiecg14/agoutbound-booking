/**
 * Public booking — the tokenless path.
 *
 * Every other entry point is gated by a minted per-lead token, which does two jobs at once:
 * it carries attribution, and it is the thing that stops a stranger filling a client's
 * calendar. A public page has neither, so the limits below are not an afterthought — they
 * are the entire gate.
 *
 * Nothing here trusts the browser. The name and email are collected because there is no
 * lead record to pre-fill from, so they are validated as untrusted input, and the booking
 * is recorded with source='public' and no campaign attribution. A website visitor genuinely
 * has no campaign, and inventing one would poison the funnel numbers this system exists to
 * keep honest.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** One future booking per person per event type. */
export const MAX_FUTURE_PER_EMAIL = 1;
/** Bookings from one address per hour, across all event types. */
export const MAX_PER_IP_PER_HOUR = 3;

export type PublicBookingRequest = {
  start: string;
  name: string;
  email: string;
  timezone: string;
  note: string | null;
};

export type PublicRefusal =
  | "invalid_request"
  | "not_public"
  | "event_inactive"
  | "slot_not_offered"
  | "already_booked"
  | "rate_limited"
  | "rejected";

function isIanaZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate the submitted form.
 *
 * `company` is a honeypot: a hidden field no human ever fills. Anything in it is a bot, and
 * the caller is told "rejected" without explanation — a bot that learns why it failed is a
 * bot that tries again differently.
 */
export function validatePublicRequest(
  body: unknown,
): { ok: true; value: PublicBookingRequest } | { ok: false; reason: PublicRefusal } {
  if (typeof body !== "object" || body === null) return { ok: false, reason: "invalid_request" };
  const b = body as Record<string, unknown>;

  if (typeof b.company === "string" && b.company.trim().length > 0) {
    return { ok: false, reason: "rejected" };
  }

  const start = b.start;
  if (typeof start !== "string" || Number.isNaN(Date.parse(start))) {
    return { ok: false, reason: "invalid_request" };
  }

  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (name.length < 2 || name.length > 200) return { ok: false, reason: "invalid_request" };

  const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
  if (!EMAIL.test(email) || email.length > 320) return { ok: false, reason: "invalid_request" };

  if (!isIanaZone(b.timezone)) return { ok: false, reason: "invalid_request" };

  let note: string | null = null;
  if (typeof b.note === "string" && b.note.trim().length > 0) {
    if (b.note.length > 2000) return { ok: false, reason: "invalid_request" };
    note = b.note.trim();
  }

  return {
    ok: true,
    value: { start: new Date(start).toISOString(), name, email, timezone: b.timezone, note },
  };
}

/**
 * Whether this request is allowed through, given what the database already holds.
 *
 * Pure, so both limits are testable without a database or a clock. The counts come from the
 * caller's live queries — never from anything cached in a process that restarts.
 */
export function checkLimits(args: {
  futureBookingsForEmail: number;
  bookingsFromIpLastHour: number;
}): { ok: true } | { ok: false; reason: PublicRefusal } {
  // One person holding several future slots on the same event type is either confused or
  // squatting the calendar. Either way they should talk to a human.
  if (args.futureBookingsForEmail >= MAX_FUTURE_PER_EMAIL) {
    return { ok: false, reason: "already_booked" };
  }
  if (args.bookingsFromIpLastHour >= MAX_PER_IP_PER_HOUR) {
    return { ok: false, reason: "rate_limited" };
  }
  return { ok: true };
}

/**
 * Re-exported so callers have one place to look. The implementation moved to client-ip.ts
 * after a review found the original spoofable (it trusted the left-most x-forwarded-for
 * entry) and wrong for IPv6 (it destroyed `::` compression, collapsing distinct networks
 * into one bucket).
 */
export { ipBucket as truncateIp, bucketFromHeaders, UNKNOWN_BUCKET } from "./client-ip.ts";

export function publicRefusalMessage(reason: PublicRefusal): { status: number; message: string } {
  switch (reason) {
    case "already_booked":
      return {
        status: 409,
        message: "You already have a call booked. Check your calendar, or reply to the invitation to move it.",
      };
    case "rate_limited":
      return { status: 429, message: "Too many bookings from here just now. Please try again shortly." };
    case "slot_not_offered":
      return { status: 409, message: "That time has just gone. Please pick another." };
    case "not_public":
    case "event_inactive":
      return { status: 404, message: "This booking page is not available." };
    case "rejected":
      // Deliberately indistinguishable from an ordinary validation failure.
      return { status: 400, message: "That request could not be understood." };
    default:
      return { status: 400, message: "That request could not be understood." };
  }
}
