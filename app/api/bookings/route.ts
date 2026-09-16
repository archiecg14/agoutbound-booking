/**
 * POST /api/bookings — the write path.
 *
 * Next 16 route handler. POST is never cached, so no cache directives are needed here.
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
import { hashToken, isWellFormedToken } from "@/lib/tokens";
import { computeSlots, type Interval } from "@/lib/availability";
import {
  decideBooking,
  publicRefusal,
  validateRequestShape,
  type BookingRefusal,
} from "@/lib/booking-checks";
import { ConnectionNeedsReconsent, createEvent, getFreeBusy } from "@/lib/google-calendar";

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

  const rawToken = (body as Record<string, unknown>).token;
  if (!isWellFormedToken(rawToken)) return refuse("token_malformed");

  const db = serviceClient();
  const now = new Date().toISOString();

  // 1. Resolve the link. The raw token is never stored, so we look up by hash.
  const { data: tokenRow, error: tokenErr } = await db
    .from("link_tokens")
    .select("id, event_type_id, client_id, lead_email, campaign_id, wave, sequence_step, expires_at, used_at")
    .eq("token_hash", hashToken(rawToken))
    .maybeSingle();

  if (tokenErr) {
    console.error("[bookings] token lookup failed", tokenErr);
    return Response.json({ error: "Something went wrong." }, { status: 500 });
  }
  if (!tokenRow) return refuse("token_not_found");

  // 2. Event type and the calendar it books into.
  const { data: eventType } = await db
    .from("event_types")
    .select("id, client_id, connection_id, name, duration_min, buffer_before, buffer_after, min_notice_min, date_range_days, active")
    .eq("id", tokenRow.event_type_id)
    .maybeSingle();

  if (!eventType) return refuse("event_mismatch");

  const { data: connection } = await db
    .from("connections")
    .select("id, refresh_token_enc, status")
    .eq("id", eventType.connection_id)
    .maybeSingle();

  if (!connection || connection.status !== "active") return refuse("event_inactive");

  // 3. Rebuild availability server-side. The client's claim about which slot is free is
  //    never trusted — it is only ever used to select from what we independently computed.
  const windowFrom = new Date(Date.parse(req.start) - DAY_MS).toISOString();
  const windowTo = new Date(Date.parse(req.start) + DAY_MS).toISOString();

  const [{ data: rules }, { data: overrides }, { data: existing }] = await Promise.all([
    db.from("availability_rules").select("weekday, start_local, end_local, timezone").eq("connection_id", connection.id),
    db.from("availability_overrides").select("on_date, kind, start_local, end_local, timezone").eq("connection_id", connection.id),
    db.from("bookings").select("start_utc, end_utc").eq("connection_id", connection.id).eq("status", "confirmed")
      .gte("start_utc", windowFrom).lte("end_utc", windowTo),
  ]);

  let googleBusy: Interval[] = [];
  try {
    googleBusy = await getFreeBusy(
      { id: connection.id, refreshToken: connection.refresh_token_enc },
      windowFrom,
      windowTo,
    );
  } catch (err) {
    if (err instanceof ConnectionNeedsReconsent) {
      await db.from("connections").update({ status: "needs_reconsent", last_error: String(err.cause ?? err) }).eq("id", connection.id);
      console.error("[bookings] connection needs reconsent", connection.id);
      // Refusing is the only safe answer: without freebusy we would be booking blind.
      return Response.json({ error: "This calendar is temporarily unavailable." }, { status: 503 });
    }
    console.error("[bookings] freebusy failed", err);
    return Response.json({ error: "This calendar is temporarily unavailable." }, { status: 503 });
  }

  const busy: Interval[] = [
    ...googleBusy,
    ...(existing ?? []).map((b) => ({ start: b.start_utc as string, end: b.end_utc as string })),
  ];

  const offeredSlots = computeSlots({
    rules: (rules ?? []).map((r) => ({
      weekday: r.weekday as number,
      startLocal: r.start_local as string,
      endLocal: r.end_local as string,
      timezone: r.timezone as string,
    })),
    overrides: (overrides ?? []).map((o) => ({
      onDate: o.on_date as string,
      kind: o.kind as "block" | "open",
      startLocal: o.start_local as string | null,
      endLocal: o.end_local as string | null,
      timezone: o.timezone as string,
    })),
    busy,
    eventType: {
      durationMin: eventType.duration_min,
      bufferBeforeMin: eventType.buffer_before,
      bufferAfterMin: eventType.buffer_after,
      minNoticeMin: eventType.min_notice_min,
      dateRangeDays: eventType.date_range_days,
      slotIntervalMin: 15,
    },
    from: windowFrom,
    to: windowTo,
    now,
  });

  // 4. Decide. All refusal rules live in booking-checks.ts, not here.
  const decision = decideBooking({
    token: {
      id: tokenRow.id,
      eventTypeId: tokenRow.event_type_id,
      clientId: tokenRow.client_id,
      leadEmail: tokenRow.lead_email,
      expiresAt: tokenRow.expires_at,
      usedAt: tokenRow.used_at,
    },
    eventType: {
      id: eventType.id,
      clientId: eventType.client_id,
      connectionId: eventType.connection_id,
      durationMin: eventType.duration_min,
      active: eventType.active,
    },
    request: req,
    offeredSlots,
    now,
  });

  if (!decision.ok) return refuse(decision.reason);

  // 5. Claim the token. Conditional on used_at being null, so a concurrent second request
  //    updates zero rows and is told the link is spent.
  const { data: claimed } = await db
    .from("link_tokens")
    .update({ used_at: now })
    .eq("id", tokenRow.id)
    .is("used_at", null)
    .select("id")
    .maybeSingle();

  if (!claimed) return refuse("token_used");

  // 6. Insert. The exclusion constraint is the last word on double-booking.
  const { data: booking, error: insertErr } = await db
    .from("bookings")
    .insert({
      event_type_id: eventType.id,
      connection_id: connection.id,
      client_id: eventType.client_id,
      link_token_id: tokenRow.id,
      lead_email: tokenRow.lead_email,
      campaign_id: tokenRow.campaign_id,
      wave: tokenRow.wave,
      sequence_step: tokenRow.sequence_step,
      attendee_name: req.attendeeName,
      attendee_email: req.attendeeEmail,
      attendee_tz: req.attendeeTz,
      start_utc: decision.start,
      end_utc: decision.end,
      status: "confirmed",
    })
    .select("id, start_utc, end_utc")
    .single();

  if (insertErr || !booking) {
    // Release the claim so the same link can be used for a different time.
    await db.from("link_tokens").update({ used_at: null }).eq("id", tokenRow.id);
    console.error("[bookings] insert failed", insertErr);
    return refuse("slot_not_offered");
  }

  // 7. Calendar write. Allowed to fail; reconcile.py picks up google_event_id IS NULL.
  try {
    const event = await createEvent(
      { id: connection.id, refreshToken: connection.refresh_token_enc },
      {
        summary: eventType.name,
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
