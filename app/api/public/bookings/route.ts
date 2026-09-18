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
 *
 * This endpoint no longer books anything. Nobody has proved they own the address they typed,
 * so it creates a HOLD and emails a confirmation link; /c/<token> is where a booking is
 * actually made. Until then there is no calendar event and no invitation, which is the
 * point — a stranger must not be able to put a meeting in someone else's calendar, or make
 * the client's account send mail to an address chosen by a stranger.
 */

import { serviceClient } from "@/lib/supabase";
import {
  CalendarUnavailable,
  availabilityFor,
  loadPublicContext,
} from "@/lib/booking-context";
import {
  HOLD_MINUTES,
  composeConfirmEmail,
  confirmationRequired,
  confirmUrl,
  holdExpiresAt,
  mintConfirmToken,
} from "@/lib/confirm";
import { sendEmail, senderConfigured, fromAddressProblem } from "@/lib/email-sender";
import { finaliseBooking } from "@/lib/booking-finalise";
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

  const [emailCount, ipCount] = await Promise.all([
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
      : Promise.resolve({ count: 0, error: null }),
  ]);

  // Fail CLOSED. A failing count returns count=null with an error, and the previous
  // `count ?? 0` turned that into zero — so a transient database blip silently disabled
  // both limits on the one endpoint a stranger can reach. Verified against the live
  // database before changing it.
  if (emailCount.error || ipCount.error || emailCount.count === null || ipCount.count === null) {
    console.error("[public/bookings] limit check failed; refusing rather than allowing", {
      emailError: emailCount.error?.message,
      ipError: ipCount.error?.message,
    });
    return Response.json(
      { error: "We could not process that just now. Please try again shortly." },
      { status: 503 },
    );
  }

  const limits = checkLimits({
    futureBookingsForEmail: emailCount.count,
    bookingsFromIpLastHour: ipCount.count,
  });
  if (!limits.ok) return refuse(limits.reason);

  const mustConfirm = confirmationRequired();

  // A confirmation step cannot be allowed to half-work. Without a working sender nobody can
  // ever confirm, so a hold would be a slot quietly taken out of circulation and a prospect
  // left waiting for an email that is not coming. Refuse before anything is written, and
  // say so loudly in the log — this is a configuration fault, not a visitor's mistake.
  const base = process.env.APP_BASE_URL;
  const senderProblem = !base
    ? "APP_BASE_URL is not set, so no confirmation link can be built"
    : !senderConfigured()
      ? "no transactional sender configured (RESEND_API_KEY / REMINDER_FROM)"
      : fromAddressProblem();
  if (mustConfirm && (senderProblem || !base)) {
    console.error("[public/bookings] CANNOT CONFIRM BOOKINGS:", senderProblem);
    return Response.json(
      { error: "Online booking is temporarily unavailable. Please email us instead." },
      { status: 503 },
    );
  }

  // Release this person's own unconfirmed holds on this event type first. Someone who did
  // not receive the email and simply tries again would otherwise be blocked by their own
  // hold and told the time had gone — the most confusing possible failure.
  const { error: releaseErr } = await db
    .from("bookings")
    .update({ confirm_expires_at: now })
    .eq("event_type_id", eventType.id)
    .eq("attendee_email", req.email)
    .eq("status", "pending")
    .gt("confirm_expires_at", now);
  if (releaseErr) console.warn("[public/bookings] could not release earlier holds", releaseErr);

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

  // Booked outright, because REQUIRE_EMAIL_CONFIRMATION=false. Every other guard still
  // applies; what is missing is only the proof that the address belongs to the person who
  // typed it. This is the pre-confirmation behaviour, kept whole rather than deleted so the
  // two paths cannot drift while the sender is being set up.
  if (!mustConfirm) {
    const { data: direct, error: directErr } = await db
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

    if (directErr || !direct) {
      console.error("[public/bookings] insert failed", directErr);
      return refuse("slot_not_offered");
    }

    await finaliseBooking(db, {
      booking: { id: direct.id, startUtc: direct.start_utc, endUtc: direct.end_utc },
      connection: { id: connection.id, refreshToken: connection.refreshToken, email: connection.email },
      client: { name: client.name },
      eventType: { name: eventType.name },
      attendee: { name: req.name, email: req.email },
      note: req.note,
      source: "public",
      now,
    });

    return Response.json(
      { id: direct.id, start: direct.start_utc, end: direct.end_utc, limitPerHour: MAX_PER_IP_PER_HOUR },
      { status: 201 },
    );
  }

  const confirm = mintConfirmToken();

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
      // A hold, not a booking. Nothing downstream — reconcile, the ledger sync, the
      // reminder sweep — treats a pending row as a call that is going to happen.
      status: "pending",
      confirm_token_hash: confirm.tokenHash,
      confirm_expires_at: holdExpiresAt(now),
      source: "public",
      created_ip: ip,
    })
    .select("id, start_utc, end_utc")
    .single();

  if (insertErr || !booking) {
    // Usually the exclusion constraint catching a slot taken moments ago.
    console.error("[public/bookings] hold failed", insertErr);
    return refuse("slot_not_offered");
  }

  const mail = composeConfirmEmail({
    clientName: client.name,
    eventName: eventType.name,
    startUtc: booking.start_utc,
    endUtc: booking.end_utc,
    attendeeTz: req.timezone,
    url: confirmUrl(base as string, confirm.token),
  });

  const sent = await sendEmail({ to: req.email, subject: mail.subject, text: mail.text });

  if (!sent.ok) {
    // Release the slot immediately rather than leaving it held for fifteen minutes on
    // behalf of someone who was never told how to confirm.
    await db.from("bookings").update({ confirm_expires_at: now }).eq("id", booking.id);
    console.error("[public/bookings] confirmation email failed, hold released", booking.id, sent.reason);
    return Response.json(
      { error: "We could not send your confirmation email. Please check the address and try again." },
      { status: 502 },
    );
  }

  // 202, not 201: accepted, not created. There is no booking yet and the response must not
  // imply there is — the page tells them to go and check their email.
  return Response.json(
    {
      pending: true,
      start: booking.start_utc,
      end: booking.end_utc,
      email: req.email,
      holdMinutes: HOLD_MINUTES,
      limitPerHour: MAX_PER_IP_PER_HOUR,
    },
    { status: 202 },
  );
}
