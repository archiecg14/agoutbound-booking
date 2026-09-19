/**
 * POST /api/cron/reconcile — the calendar half of reconcile.py, on a schedule.
 *
 * reconcile.py has four checks and two of them read the client's master ledger CSV, which
 * lives on Archie's Mac. Those cannot run in the cloud and stay that script's job. The two
 * that only need the database and Google are the ones with nobody watching them, and they
 * are the ones that hurt:
 *
 *   never_synced  — the row saved but the calendar write failed, so the booking exists and
 *                   the meeting does not. Nobody finds out until a prospect does not turn up.
 *   vanished      — we hold an event id Google no longer has. Deleted from the calendar app,
 *                   or the sync silently came apart.
 *
 * Deliberately NOT a rewrite of reconcile.py's ledger logic. Duplicating that would give two
 * implementations of the same rules to keep in step, which is how they drift.
 *
 * Silent when clean. It emails only on a finding, so a message in the inbox means something
 * is actually wrong — but it logs its counts every run, so "checked 3, all fine" in the log
 * is how you tell a working sweep from one that has stopped.
 */

import { serviceClient } from "@/lib/supabase";
import { checkBearer } from "@/lib/api-auth";
import { decryptSecret, isEncrypted } from "@/lib/crypto";
import { accessTokenFor } from "@/lib/google-calendar";
import { sendEmail, senderConfigured, fromAddressProblem } from "@/lib/email-sender";

/** How far back to look. Older than this and the call has happened; the report is history. */
const LOOKBACK_DAYS = 2;

type Finding = { kind: "never_synced" | "vanished"; bookingId: string; detail: string };

export async function POST(request: Request) {
  const auth = checkBearer(request.headers.get("authorization"), process.env.CRON_SECRET);
  if (!auth.ok) {
    if (auth.reason === "unconfigured") console.error("[reconcile] CRON_SECRET is not set");
    return Response.json({ error: "unauthorised" }, { status: 401 });
  }

  const db = serviceClient();
  const now = new Date();
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000).toISOString();

  const { data: bookings, error } = await db
    .from("bookings")
    .select("id, attendee_email, start_utc, google_event_id, connection_id")
    .eq("status", "confirmed")
    .gte("start_utc", since)
    .order("start_utc");

  // Fail loudly rather than reporting a clean run we did not actually perform. A reconcile
  // that silently checks nothing is worse than no reconcile, because it buys false comfort.
  if (error) {
    console.error("[reconcile] could not read bookings; reporting failure, not success", error);
    return Response.json({ error: "query_failed" }, { status: 500 });
  }

  const findings: Finding[] = [];
  const rows = bookings ?? [];

  // Check 1 needs no Google call at all: the row says confirmed and carries no event id.
  const needCalendar = [];
  for (const b of rows) {
    if (!b.google_event_id) {
      findings.push({
        kind: "never_synced",
        bookingId: b.id as string,
        detail: `${b.attendee_email} at ${b.start_utc} — no calendar event was ever created`,
      });
    } else {
      needCalendar.push(b);
    }
  }

  // Check 2: ask Google whether the events we think exist still do. One token per
  // connection, not per booking.
  const tokens = new Map<string, string>();
  let calendarChecked = 0;
  let calendarUnavailable = false;

  for (const b of needCalendar) {
    const connId = b.connection_id as string;
    try {
      if (!tokens.has(connId)) {
        const { data: conn } = await db
          .from("connections")
          .select("refresh_token_enc")
          .eq("id", connId)
          .maybeSingle();
        if (!conn) continue;
        const rt = isEncrypted(conn.refresh_token_enc)
          ? decryptSecret(conn.refresh_token_enc)
          : (conn.refresh_token_enc as string);
        tokens.set(connId, await accessTokenFor({ id: connId, refreshToken: rt }));
      }

      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${b.google_event_id}`,
        { headers: { Authorization: `Bearer ${tokens.get(connId)}` } },
      );

      if (res.status === 404) {
        findings.push({
          kind: "vanished",
          bookingId: b.id as string,
          detail: `${b.attendee_email} at ${b.start_utc} — event ${b.google_event_id} is not on the calendar`,
        });
      } else if (res.ok) {
        const ev = (await res.json()) as { status?: string };
        // A cancelled event against a confirmed row is the same disagreement as a missing
        // one: our side thinks the meeting is on, Google does not.
        if (ev.status === "cancelled") {
          findings.push({
            kind: "vanished",
            bookingId: b.id as string,
            detail: `${b.attendee_email} at ${b.start_utc} — event is cancelled in Google but confirmed here`,
          });
        }
      } else {
        // Not a finding. We could not check, and saying "fine" would be a lie.
        calendarUnavailable = true;
        console.error("[reconcile] calendar read failed", b.id, res.status);
      }
      calendarChecked++;
    } catch (err) {
      calendarUnavailable = true;
      console.error("[reconcile] calendar check threw", b.id, err);
    }
  }

  const summary = {
    ok: true,
    bookingsChecked: rows.length,
    calendarChecked,
    findings: findings.length,
    calendarUnavailable,
    kinds: findings.map((f) => f.kind),
  };

  // Logged every run, clean or not. Absence of this line is how you notice it stopped.
  console.log("[reconcile]", JSON.stringify(summary));

  if (findings.length && senderConfigured() && !fromAddressProblem()) {
    const host = process.env.RECONCILE_ALERT_TO || process.env.REMINDER_FROM;
    if (host) {
      const lines = findings.map((f) => `${f.kind.toUpperCase()}: ${f.detail} (booking ${f.bookingId})`);
      await sendEmail({
        to: host,
        subject: `Booking reconcile: ${findings.length} problem${findings.length === 1 ? "" : "s"}`,
        text: [
          "The booking system and Google Calendar disagree.",
          "",
          ...lines,
          "",
          calendarUnavailable ? "Some events could not be checked this run." : "",
          `Checked ${rows.length} confirmed booking(s) from the last ${LOOKBACK_DAYS} days.`,
        ].filter(Boolean).join("\n"),
      });
    }
  }

  return Response.json(summary);
}
