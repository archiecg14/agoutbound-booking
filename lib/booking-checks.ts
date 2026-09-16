/**
 * The booking decision, as a pure function.
 *
 * Every rule that can refuse a booking lives here so it can be tested without a database,
 * a network, or a clock. The route handler does I/O and then asks this module what the
 * answer is; it never decides anything itself.
 *
 * The ordering of the checks is deliberate: cheapest and most-likely-to-fail first, and
 * availability last, because availability is the only check that needs the slot list.
 */

import type { Interval } from "./availability.ts";

export type LinkTokenRow = {
  id: string;
  eventTypeId: string;
  clientId: string;
  leadEmail: string;
  expiresAt: string;
  usedAt: string | null;
};

export type EventTypeRow = {
  id: string;
  clientId: string;
  connectionId: string;
  durationMin: number;
  active: boolean;
};

export type BookingRequest = {
  start: string;
  attendeeName: string;
  attendeeEmail: string;
  attendeeTz: string;
  /** The one optional free-text box on the confirm step. */
  note: string | null;
};

/**
 * Machine-readable reasons. The HTTP layer maps several of these to one vague public
 * message on purpose — a stranger probing links should not be able to tell "no such token"
 * from "already used" — while the code stays specific enough to debug from a log.
 */
export type BookingRefusal =
  | "token_malformed"
  | "token_not_found"
  | "token_expired"
  | "token_used"
  | "event_inactive"
  | "event_mismatch"
  | "invalid_request"
  | "slot_not_offered";

export type BookingDecision =
  | { ok: true; start: string; end: string }
  | { ok: false; reason: BookingRefusal };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isIanaZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0) return false;
  try {
    // Throws RangeError on an unknown zone. This is the only reliable runtime check.
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function validateRequestShape(body: unknown): BookingRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;

  const start = b.start;
  const name = b.attendeeName;
  const email = b.attendeeEmail;
  const tz = b.attendeeTz;

  if (typeof start !== "string" || Number.isNaN(Date.parse(start))) return null;
  if (typeof name !== "string" || name.trim().length === 0 || name.length > 200) return null;
  if (typeof email !== "string" || !EMAIL.test(email) || email.length > 320) return null;
  if (!isIanaZone(tz)) return null;

  // Optional, but if present it must be a string of sane length — an unbounded free-text
  // field is an unbounded row, and it ends up rendered in a calendar invite.
  let note: string | null = null;
  if (b.note !== undefined && b.note !== null) {
    if (typeof b.note !== "string" || b.note.length > 2000) return null;
    const trimmed = b.note.trim();
    note = trimmed.length > 0 ? trimmed : null;
  }

  return {
    start: new Date(start).toISOString(),
    attendeeName: name.trim(),
    attendeeEmail: email.trim().toLowerCase(),
    attendeeTz: tz,
    note,
  };
}

export function decideBooking(args: {
  token: LinkTokenRow | null;
  eventType: EventTypeRow | null;
  request: BookingRequest;
  /** Slots computed for the requested day. The client's word is never taken for this. */
  offeredSlots: Interval[];
  now: string;
}): BookingDecision {
  const { token, eventType, request, offeredSlots, now } = args;

  if (!token) return { ok: false, reason: "token_not_found" };

  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) return { ok: false, reason: "invalid_request" };

  if (Date.parse(token.expiresAt) <= nowMs) return { ok: false, reason: "token_expired" };
  if (token.usedAt !== null) return { ok: false, reason: "token_used" };

  if (!eventType) return { ok: false, reason: "event_mismatch" };
  if (eventType.id !== token.eventTypeId) return { ok: false, reason: "event_mismatch" };
  if (eventType.clientId !== token.clientId) return { ok: false, reason: "event_mismatch" };
  if (!eventType.active) return { ok: false, reason: "event_inactive" };

  // The requested start must be one the server itself offered. A client that posts an
  // arbitrary instant — out of hours, mid-meeting, in the past — is refused here rather
  // than relying on the database constraint to catch it later.
  const match = offeredSlots.find((s) => s.start === request.start);
  if (!match) return { ok: false, reason: "slot_not_offered" };

  return { ok: true, start: match.start, end: match.end };
}

/**
 * What the caller is told. Several distinct refusals collapse to one message so that
 * probing a link cannot enumerate valid tokens; the reason code still goes to the log.
 */
export function publicRefusal(reason: BookingRefusal): { status: number; message: string } {
  switch (reason) {
    case "token_malformed":
    case "token_not_found":
    case "token_expired":
    case "token_used":
      return { status: 404, message: "This booking link is no longer valid." };
    case "event_inactive":
    case "event_mismatch":
      return { status: 404, message: "This booking link is no longer valid." };
    case "slot_not_offered":
      return { status: 409, message: "That time is no longer available. Please pick another." };
    case "invalid_request":
      return { status: 400, message: "That request could not be understood." };
  }
}
