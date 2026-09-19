/**
 * POST /api/cron/reminders — send whatever is due.
 *
 * Authenticated with a shared secret: an open endpoint that sends email is a spam cannon
 * pointed at your own attendees. Designed to be safe to run often and safe to run twice —
 * the unique (booking_id, kind) constraint plus the status transition mean an overlapping
 * run cannot double-send.
 */

import { serviceClient } from "@/lib/supabase";
import { checkBearer } from "@/lib/api-auth";
import { sendEmail, senderConfigured, fromAddressProblem } from "@/lib/email-sender";
import { decide, subjectFor, type ReminderKind } from "@/lib/reminders";

export async function POST(request: Request) {
  const auth = checkBearer(request.headers.get("authorization"), process.env.CRON_SECRET);
  if (!auth.ok) {
    if (auth.reason === "unconfigured") console.error("[cron] CRON_SECRET is not set");
    return Response.json({ error: "unauthorised" }, { status: 401 });
  }

  const db = serviceClient();
  const now = new Date().toISOString();

  const { data: due, error } = await db
    .from("reminders")
    .select("id, booking_id, kind, due_at, status, attempts")
    .eq("status", "pending")
    .lte("due_at", now)
    .order("due_at")
    .limit(100);

  if (error) {
    console.error("[cron] reminder query failed", error);
    return Response.json({ error: "query_failed" }, { status: 500 });
  }

  const configProblem = senderConfigured() ? fromAddressProblem() : "no sender configured";
  const counts = { considered: due?.length ?? 0, sent: 0, skipped: 0, failed: 0 };

  for (const r of due ?? []) {
    const { data: b } = await db
      .from("bookings")
      .select("id, status, start_utc, attendee_email, client_id")
      .eq("id", r.booking_id)
      .maybeSingle();

    const { data: client } = b
      ? await db.from("clients").select("name").eq("id", b.client_id).maybeSingle()
      : { data: null };

    const decision = decide(
      { id: r.id, bookingId: r.booking_id, kind: r.kind as ReminderKind, dueAt: r.due_at, status: r.status, attempts: r.attempts },
      b && { id: b.id, status: b.status, startUtc: b.start_utc, attendeeEmail: b.attendee_email },
      now,
    );

    if (decision.action === "wait") continue;

    if (decision.action === "skip") {
      counts.skipped++;
      await db.from("reminders").update({ status: "skipped", last_error: decision.reason }).eq("id", r.id);
      continue;
    }

    // Recorded as skipped with the reason, never as sent. A reminder nobody received must
    // not look like one that went out.
    if (configProblem) {
      counts.skipped++;
      await db.from("reminders").update({ status: "skipped", last_error: configProblem }).eq("id", r.id);
      continue;
    }

    // Claim the row BEFORE sending, conditional on it still being pending.
    //
    // The select above filters on pending, but the update that followed the send did not,
    // so two overlapping sweeps could both read the same row as pending and both send it.
    // That is reachable now there is a scheduler: if the sender degrades and a batch runs
    // past the ten-minute interval, the next sweep starts on top of the last one and the
    // attendee gets the same reminder twice. Claiming first is what makes this file's
    // "safe to run twice" header actually true.
    //
    // The trade-off, stated plainly: a crash between the claim and the send leaves a
    // reminder marked sent that nobody received. That is rarer than an overlapping run and
    // quieter than mailing a customer twice, and `sent_at` with no matching send is
    // visible in the table if it is ever worth chasing.
    const { data: claimed } = await db
      .from("reminders")
      .update({ status: "sent", sent_at: new Date().toISOString() })
      .eq("id", r.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();

    // Another sweep got there first. Not an error, and not ours to count.
    if (!claimed) continue;

    const subject = subjectFor(r.kind as ReminderKind, client?.name ?? "us");
    const result = await sendEmail({
      to: b!.attendee_email,
      subject,
      text: `${subject}\n\nIf you need to move or cancel it, use the link in your calendar invitation.`,
    });

    if (result.ok) {
      counts.sent++;
    } else {
      counts.failed++;
      await db
        .from("reminders")
        .update({
          // A non-retryable failure is terminal; retrying it forever just hides it.
          status: result.retryable ? "pending" : "failed",
          // Hand the claim back. Left set, a retryable failure would keep a sent_at it
          // never earned, and the row would read as delivered.
          sent_at: null,
          attempts: r.attempts + 1,
          last_error: result.reason,
        })
        .eq("id", r.id);
    }
  }

  if (configProblem) console.error("[cron] reminders skipped:", configProblem);
  return Response.json({ ok: true, ...counts, configProblem });
}
