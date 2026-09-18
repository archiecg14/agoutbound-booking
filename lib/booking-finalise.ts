/**
 * Everything that happens once a booking is genuinely a booking.
 *
 * On the public path this no longer runs at submit time — it runs when the confirmation
 * link is opened, which is the first moment we know the address is real. Extracted so the
 * two halves of that flow cannot drift apart: whatever the confirm page does on success is
 * exactly what the old single-step path did.
 *
 * Every step here is best-effort by design. A booking that exists but whose calendar write
 * or notification failed is an annoyance somebody can fix; a booking refused because an
 * email bounced is lost revenue. The row is already committed before any of this is called,
 * and reconcile.py is what catches anything left unsynced.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createEvent } from "./google-calendar.ts";
import { manageUrl, mintManageToken } from "./manage.ts";
import { notifyHost } from "./booking-notification.ts";
import { scheduleFor } from "./reminders.ts";

export type FinaliseInput = {
  booking: { id: string; startUtc: string; endUtc: string };
  connection: { id: string; refreshToken: string; email: string };
  client: { name: string };
  eventType: { name: string };
  attendee: { name: string; email: string };
  note: string | null;
  source: "link" | "public";
  now: string;
};

export type FinaliseResult = {
  calendarSynced: boolean;
  remindersScheduled: number;
  hostNotified: boolean;
};

export async function finaliseBooking(
  db: SupabaseClient,
  input: FinaliseInput,
): Promise<FinaliseResult> {
  const { booking, connection, client, eventType, attendee } = input;
  const result: FinaliseResult = { calendarSynced: false, remindersScheduled: 0, hostNotified: false };
  const tag = `[finalise:${input.source}]`;

  const reminders = scheduleFor(booking.startUtc, booking.endUtc, input.now);
  if (reminders.length) {
    const { error } = await db
      .from("reminders")
      .insert(reminders.map((r) => ({ booking_id: booking.id, kind: r.kind, due_at: r.dueAt })));
    if (error) console.error(`${tag} scheduling reminders failed`, booking.id, error);
    else result.remindersScheduled = reminders.length;
  }

  const manageLine = process.env.APP_BASE_URL
    ? `Need to change this? ${manageUrl(process.env.APP_BASE_URL, mintManageToken(booking.id, booking.endUtc))}`
    : null;

  try {
    const event = await createEvent(
      { id: connection.id, refreshToken: connection.refreshToken },
      {
        summary: `${eventType.name} — ${client.name}`,
        // The attendee's note is deliberately absent on the public path, and kept out here
        // for both: Google mails this invitation from the client's real account, so the
        // description is a delivery channel wearing a trusted sender's name. The host still
        // gets the note in the notification below.
        description: input.source === "public" ? (manageLine ?? undefined) : [input.note, manageLine].filter(Boolean).join("\n\n") || undefined,
        startIso: booking.startUtc,
        endIso: booking.endUtc,
        attendeeEmail: attendee.email,
        attendeeName: attendee.name,
        idempotencyKey: booking.id,
      },
    );
    await db
      .from("bookings")
      .update({ google_event_id: event.id, google_synced_at: new Date().toISOString() })
      .eq("id", booking.id);
    result.calendarSynced = true;
  } catch (err) {
    console.error(`${tag} calendar write failed, booking stands unsynced`, booking.id, err);
  }

  try {
    const { data: tzRow } = await db
      .from("availability_rules")
      .select("timezone")
      .eq("connection_id", connection.id)
      .limit(1)
      .maybeSingle();

    const sent = await notifyHost(connection.email, {
      clientName: client.name,
      eventName: eventType.name,
      attendeeName: attendee.name,
      attendeeEmail: attendee.email,
      startUtc: booking.startUtc,
      endUtc: booking.endUtc,
      hostTimezone: (tzRow?.timezone as string | undefined) ?? null,
      note: input.note,
      campaignId: null,
      wave: null,
      source: input.source,
    });
    result.hostNotified = sent.sent;
    if (!sent.sent) console.warn(`${tag} host not notified:`, sent.reason);
  } catch (err) {
    console.error(`${tag} host notification threw`, err);
  }

  return result;
}
