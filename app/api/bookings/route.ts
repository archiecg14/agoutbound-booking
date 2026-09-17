/**
 * POST /api/bookings — the write path.
 *
 * Next 16 route handler. POST is never cached, so no cache directives are needed here.
 *
 * Availability is loaded through the SAME module the booking page reads from
 * (lib/booking-context.ts). That is deliberate: two implementations would eventually
 * disagree, and the visible symptom would be a prospect being refused a time the page had
 * just offered them.
 *
 * Ordering is the interesting part. The token is CLAIMED before the booking is inserted,
 * because two concurrent requests carrying the same link must not both pass a read-only
 * "is it used?" check. The claim is a conditional update; losing that race is indistinguish-
 * able from a reused link, which is the correct outcome. If the insert then fails — almost
 * always the exclusion constraint catching a slot that went in a millisecond earlier — the
 * claim is released so the prospect can pick another time with the same link.
 *
 * The calendar write is deliberately AFTER the booking row exists and is allowed to fail.
 * A booking recorded without a calendar event is recoverable (google_event_id is null and
 * reconcile.py finds it). A calendar event with no booking row is not.
 */

import { serviceClient } from "@/lib/supabase";
import {
  decideBooking,
  publicRefusal,
  validateRequestShape,
  type BookingRefusal,
} from "@/lib/booking-checks";
import {
  CalendarUnavailable,
  availabilityFor,
  loadBookingContext,
} from "@/lib/booking-context";
import { createEvent } from "@/lib/google-calendar";
import { manageUrl, mintManageToken } from "@/lib/manage";
import { scheduleFor } from "@/lib/reminders";

const DAY_MS = 86_400_000;

function refuse(reason: BookingRefusal) {
  const { status, message } = publicRefusal(reason);
  console.warn(`[bookings] refused: ${reason}`);
  return Response.json({ error: message, code: reason }, { status });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return refuse("invalid_request");
  }

  const req = validateRequestShape(body);
  if (!req) return refuse("invalid_request");

  const db = serviceClient();
  const now = new Date().toISOString();

  let loaded;
  try {
    loaded = await loadBookingContext(db, (body as Record<string, unknown>).token);
  } catch (err) {
    console.error("[bookings] context load failed", err);
    return Response.json({ error: "Something went wrong." }, { status: 500 });
  }
  if (!loaded.ok) return refuse(loaded.reason);

  const { token, eventType, connection } = loaded.context;

  // Recompute availability around the requested time. The client's claim about which slot
  // is free is never trusted — it only ever selects from what the server itself produced.
  const windowFrom = new Date(Date.parse(req.start) - DAY_MS).toISOString();
  const windowTo = new Date(Date.parse(req.start) + DAY_MS).toISOString();

  let offeredSlots;
  try {
    offeredSlots = await availabilityFor(db, loaded.context, windowFrom, windowTo, now);
  } catch (err) {
    if (err instanceof CalendarUnavailable) {
      console.error("[bookings] calendar unavailable", connection.id, err.needsReconsent);
      // Refusing is the only safe answer: without freebusy we would be booking blind.
      return Response.json({ error: "This calendar is temporarily unavailable." }, { status: 503 });
    }
    console.error("[bookings] availability failed", err);
    return Response.json({ error: "Something went wrong." }, { status: 500 });
  }

  const decision = decideBooking({
    token: {
      id: token.id,
      eventTypeId: token.eventTypeId,
      clientId: token.clientId,
      leadEmail: token.leadEmail,
      expiresAt: token.expiresAt,
      usedAt: token.usedAt,
    },
    eventType: {
      id: eventType.id,
      clientId: eventType.clientId,
      connectionId: eventType.connectionId,
      durationMin: eventType.durationMin,
      active: eventType.active,
    },
    request: req,
    offeredSlots,
    now,
  });

  if (!decision.ok) return refuse(decision.reason);

  // Claim the token. Conditional on used_at being null, so a concurrent second request
  // updates zero rows and is told the link is spent.
  const { data: claimed } = await db
    .from("link_tokens")
    .update({ used_at: now })
    .eq("id", token.id)
    .is("used_at", null)
    .select("id")
    .maybeSingle();

  if (!claimed) return refuse("token_used");

  // Insert. The exclusion constraint is the last word on double-booking.
  const { data: booking, error: insertErr } = await db
    .from("bookings")
    .insert({
      event_type_id: eventType.id,
      connection_id: connection.id,
      client_id: eventType.clientId,
      link_token_id: token.id,
      lead_email: token.leadEmail,
      campaign_id: token.campaignId,
      wave: token.wave,
      sequence_step: token.sequenceStep,
      attendee_name: req.attendeeName,
      attendee_email: req.attendeeEmail,
      attendee_tz: req.attendeeTz,
      answers: req.note ? { note: req.note } : {},
      start_utc: decision.start,
      end_utc: decision.end,
      status: "confirmed",
    })
    .select("id, start_utc, end_utc")
    .single();

  if (insertErr || !booking) {
    // Release the claim so the same link can be used for a different time.
    await db.from("link_tokens").update({ used_at: null }).eq("id", token.id);
    console.error("[bookings] insert failed", insertErr);
    return refuse("slot_not_offered");
  }

  // Reminders. Scheduled before the calendar write so a Google outage does not also cost
  // the attendee their reminders. Failure here is logged, never fatal: a booking that
  // exists without reminders is far better than a lost booking.
  const reminders = scheduleFor(booking.start_utc, booking.end_utc, now);
  if (reminders.length) {
    const { error: remErr } = await db.from("reminders").insert(
      reminders.map((r) => ({ booking_id: booking.id, kind: r.kind, due_at: r.dueAt })),
    );
    if (remErr) console.error("[bookings] scheduling reminders failed", booking.id, remErr);
  }

  // Calendar write. Allowed to fail; reconcile.py picks up google_event_id IS NULL.
  //
  // The manage link goes in the event description because the calendar invite is the ONLY
  // thing we send — there is no confirmation email from us by design. Without this the
  // attendee has no way to reschedule or cancel and will simply not turn up.
  const manageLine = process.env.APP_BASE_URL
    ? `Need to change this? ${manageUrl(process.env.APP_BASE_URL, mintManageToken(booking.id, booking.end_utc))}`
    : null;

  try {
    const event = await createEvent(
      { id: connection.id, refreshToken: connection.refreshToken },
      {
        summary: eventType.name,
        description: [req.note, manageLine].filter(Boolean).join("\n\n") || undefined,
        startIso: booking.start_utc,
        endIso: booking.end_utc,
        attendeeEmail: req.attendeeEmail,
        attendeeName: req.attendeeName,
        idempotencyKey: booking.id,
      },
    );
    await db
      .from("bookings")
      .update({ google_event_id: event.id, google_synced_at: new Date().toISOString() })
      .eq("id", booking.id);
  } catch (err) {
    console.error("[bookings] calendar write failed, booking stands unsynced", booking.id, err);
  }

  return Response.json(
    { id: booking.id, start: booking.start_utc, end: booking.end_utc },
    { status: 201 },
  );
}
