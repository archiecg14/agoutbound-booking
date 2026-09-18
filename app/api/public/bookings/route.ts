/**
 * POST /api/public/bookings — anyone can call this, which is the whole problem it solves.
 *
 * With no token there is no gate, so the limits are the gate: one future booking per email
 * per event type, a per-hour cap by truncated IP, and a honeypot field. All three read live
 * from the database rather than from in-process state that resets on every deploy.
 *
 * Bookings are recorded with source='public' and no campaign attribution. A website visitor
 * has no campaign, and inventing one would corrupt exactly the funnel numbers this system
 * exists to keep honest.
 */

import { serviceClient } from "@/lib/supabase";
import {
  CalendarUnavailable,
  availabilityFor,
  loadPublicContext,
} from "@/lib/booking-context";
import { createEvent } from "@/lib/google-calendar";
import { manageUrl, mintManageToken } from "@/lib/manage";
import { notifyHost } from "@/lib/booking-notification";
import { scheduleFor } from "@/lib/reminders";
import {
  MAX_PER_IP_PER_HOUR,
  checkLimits,
  publicRefusalMessage,
  bucketFromHeaders,
  validatePublicRequest,
  type PublicRefusal,
} from "@/lib/public-booking";

const DAY_MS = 86_400_000;

function refuse(reason: PublicRefusal) {
  const { status, message } = publicRefusalMessage(reason);
  console.warn(`[public/bookings] refused: ${reason}`);
  return Response.json({ error: message, code: reason }, { status });
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  const clientSlug = url.searchParams.get("client");
  const eventSlug = url.searchParams.get("event");
  if (!clientSlug || !eventSlug) return refuse("not_public");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return refuse("invalid_request");
  }

  const parsed = validatePublicRequest(body);
  if (!parsed.ok) return refuse(parsed.reason);
  const req = parsed.value;

  const db = serviceClient();
  const now = new Date().toISOString();

  const loaded = await loadPublicContext(db, clientSlug, eventSlug);
  if (!loaded.ok) return refuse("not_public");
  const { eventType, connection, client } = loaded.context;

  // Limits first, before any Google call. A blocked request should cost us nothing.
  // Fails closed: anything we cannot attribute lands in one shared bucket and shares one
  // hourly allowance, rather than skipping the limit entirely as the first version did.
  const ip = bucketFromHeaders(request.headers);
  const hourAgo = new Date(Date.parse(now) - 3_600_000).toISOString();

  const [{ count: futureForEmail }, { count: fromIp }] = await Promise.all([
    db
      .from("bookings")
      .select("id", { count: "exact", head: true })
      .eq("event_type_id", eventType.id)
      .eq("attendee_email", req.email)
      .eq("status", "confirmed")
      .gte("start_utc", now),
    ip
      ? db
          .from("bookings")
          .select("id", { count: "exact", head: true })
          .eq("created_ip", ip)
          .eq("source", "public")
          .gte("created_at", hourAgo)
      : Promise.resolve({ count: 0 }),
  ]);

  const limits = checkLimits({
    futureBookingsForEmail: futureForEmail ?? 0,
    bookingsFromIpLastHour: fromIp ?? 0,
  });
  if (!limits.ok) return refuse(limits.reason);

  // Availability is recomputed server-side, exactly as on the per-lead path.
  let slots;
  try {
    slots = await availabilityFor(
      db,
      loaded.context,
      new Date(Date.parse(req.start) - DAY_MS).toISOString(),
      new Date(Date.parse(req.start) + DAY_MS).toISOString(),
      now,
    );
  } catch (err) {
    if (err instanceof CalendarUnavailable) {
      return Response.json({ error: "This calendar is temporarily unavailable." }, { status: 503 });
    }
    console.error("[public/bookings] availability failed", err);
    return Response.json({ error: "Something went wrong." }, { status: 500 });
  }

  const match = slots.find((s) => s.start === req.start);
  if (!match) return refuse("slot_not_offered");

  const { data: booking, error: insertErr } = await db
    .from("bookings")
    .insert({
      event_type_id: eventType.id,
      connection_id: connection.id,
      client_id: eventType.clientId,
      link_token_id: null,
      lead_email: null,
      campaign_id: null,
      wave: null,
      sequence_step: null,
      attendee_name: req.name,
      attendee_email: req.email,
      attendee_tz: req.timezone,
      answers: req.note ? { note: req.note } : {},
      start_utc: match.start,
      end_utc: match.end,
      status: "confirmed",
      source: "public",
      created_ip: ip,
    })
    .select("id, start_utc, end_utc")
    .single();

  if (insertErr || !booking) {
    // Usually the exclusion constraint catching a slot taken moments ago.
    console.error("[public/bookings] insert failed", insertErr);
    return refuse("slot_not_offered");
  }

  const reminders = scheduleFor(booking.start_utc, booking.end_utc, now);
  if (reminders.length) {
    const { error: remErr } = await db
      .from("reminders")
      .insert(reminders.map((r) => ({ booking_id: booking.id, kind: r.kind, due_at: r.dueAt })));
    if (remErr) console.error("[public/bookings] scheduling reminders failed", booking.id, remErr);
  }

  const manageLine = process.env.APP_BASE_URL
    ? `Need to change this? ${manageUrl(process.env.APP_BASE_URL, mintManageToken(booking.id, booking.end_utc))}`
    : null;

  try {
    const event = await createEvent(
      { id: connection.id, refreshToken: connection.refreshToken },
      {
        summary: `${eventType.name} — ${client.name}`,
        description: [req.note, manageLine].filter(Boolean).join("\n\n") || undefined,
        startIso: booking.start_utc,
        endIso: booking.end_utc,
        attendeeEmail: req.email,
        attendeeName: req.name,
        idempotencyKey: booking.id,
      },
    );
    await db
      .from("bookings")
      .update({ google_event_id: event.id, google_synced_at: new Date().toISOString() })
      .eq("id", booking.id);
  } catch (err) {
    console.error("[public/bookings] calendar write failed, booking stands unsynced", booking.id, err);
  }


  // Tell the host. Never fatal: a booking without its notification is an annoyance, a
  // booking lost to a bounced email is revenue.
  try {
    const { data: tzRow } = await db
      .from("availability_rules")
      .select("timezone")
      .eq("connection_id", connection.id)
      .limit(1)
      .maybeSingle();

    const result = await notifyHost(connection.email, {
      clientName: client.name,
      eventName: eventType.name,
      attendeeName: req.name,
      attendeeEmail: req.email,
      startUtc: booking.start_utc,
      endUtc: booking.end_utc,
      hostTimezone: tzRow?.timezone ?? null,
      note: req.note,
      campaignId: null,
      wave: null,
      source: "public",
    });
    if (!result.sent) console.warn("[public/bookings] host not notified:", result.reason);
  } catch (err) {
    console.error("[public/bookings] host notification threw", err);
  }

  return Response.json(
    { id: booking.id, start: booking.start_utc, end: booking.end_utc, limitPerHour: MAX_PER_IP_PER_HOUR },
    { status: 201 },
  );
}
