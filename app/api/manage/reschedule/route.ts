/**
 * POST /api/manage/reschedule — an attendee moves their own booking.
 *
 * Updated in place rather than cancelled-and-recreated. The booking id is what the master
 * ledger stores in booking_uid, so a new row would orphan that reference and break the
 * attribution this whole system exists to preserve. `rescheduled_from` in the schema is for
 * a future keep-the-history mode, and is deliberately unused for now.
 *
 * Availability is recomputed server-side, exactly as at first booking. The attendee's
 * requested time is only ever used to select from what the server itself offered.
 */

import { serviceClient } from "@/lib/supabase";
import {
  CalendarUnavailable,
  availabilityFor,
  loadBookingById,
} from "@/lib/booking-context";
import { canManage, manageRefusalMessage, readManageToken } from "@/lib/manage";
import { patchEventTime } from "@/lib/google-calendar";

const DAY_MS = 86_400_000;

export async function POST(request: Request) {
  let body: { token?: string; start?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "That request could not be understood." }, { status: 400 });
  }

  const claims = readManageToken(body.token ?? null);
  const start = body.start;
  if (!claims || typeof start !== "string" || Number.isNaN(Date.parse(start))) {
    return Response.json({ error: "This link is not valid." }, { status: 404 });
  }

  const db = serviceClient();
  const booking = await loadBookingById(db, claims.bookingId);
  const now = new Date().toISOString();

  const allowed = canManage(booking && { status: booking.status, startUtc: booking.startUtc }, now);
  if (!allowed.ok) {
    const { status, message } = manageRefusalMessage(allowed.reason);
    return Response.json({ error: message, code: allowed.reason }, { status });
  }

  const b = booking!;
  const wanted = new Date(start).toISOString();

  let slots;
  try {
    slots = await availabilityFor(
      db,
      b,
      new Date(Date.parse(wanted) - DAY_MS).toISOString(),
      new Date(Date.parse(wanted) + DAY_MS).toISOString(),
      now,
      // Without this the attendee is blocked by the meeting they are trying to move.
      { start: b.startUtc, end: b.endUtc },
    );
  } catch (err) {
    if (err instanceof CalendarUnavailable) {
      return Response.json({ error: "This calendar is temporarily unavailable." }, { status: 503 });
    }
    console.error("[manage] reschedule availability failed", err);
    return Response.json({ error: "Something went wrong." }, { status: 500 });
  }

  const match = slots.find((s) => s.start === wanted);
  if (!match) {
    const { status, message } = manageRefusalMessage("slot_not_offered");
    return Response.json({ error: message, code: "slot_not_offered" }, { status });
  }

  const { error } = await db
    .from("bookings")
    .update({ start_utc: match.start, end_utc: match.end })
    .eq("id", b.id)
    // Still confirmed, or there is nothing to move. Guards against a cancellation that
    // landed between the check above and this write.
    .eq("status", "confirmed");

  if (error) {
    // The exclusion constraint lands here when the new slot was taken a moment ago.
    console.error("[manage] reschedule update failed", error);
    const { status, message } = manageRefusalMessage("slot_not_offered");
    return Response.json({ error: message, code: "slot_not_offered" }, { status });
  }

  if (b.googleEventId) {
    try {
      await patchEventTime(b.connection, b.googleEventId, match.start, match.end);
      await db
        .from("bookings")
        .update({ google_synced_at: new Date().toISOString() })
        .eq("id", b.id);
    } catch (err) {
      // The move stands; the calendar is now stale and reconcile.py will say so. Failing
      // the request here would tell the attendee it did not work when it did.
      console.error("[manage] calendar patch failed after reschedule", b.id, err);
    }
  }

  return Response.json({ ok: true, start: match.start, end: match.end });
}
