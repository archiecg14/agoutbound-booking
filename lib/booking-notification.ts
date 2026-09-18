/**
 * "You've been booked" — the email to the person whose calendar it is.
 *
 * Separate from reminders, which go to the attendee. This one goes to the host, and it is
 * the difference between finding out now and finding out when the calendar alert fires.
 *
 * It sends over the same transactional sender as reminders, which means the same domain
 * rule applies: never a cold-outreach domain. A booking notification that damages campaign
 * reputation would be a self-inflicted wound.
 *
 * Failure is never fatal. A booking that exists but whose notification did not send is a
 * minor annoyance; a booking that failed because an email bounced is lost revenue. The
 * callers log and move on.
 */

import { sendEmail, senderConfigured, fromAddressProblem } from "./email-sender.ts";

export type BookingNotification = {
  clientName: string;
  eventName: string;
  attendeeName: string;
  attendeeEmail: string;
  startUtc: string;
  endUtc: string;
  /** The host's own zone, so the time reads the way they think about it. */
  hostTimezone: string | null;
  note: string | null;
  /** Null for a public booking — a website visitor has no campaign. */
  campaignId: string | null;
  wave: string | null;
  source: "link" | "public";
};

function fmt(iso: string, tz: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...opts }).format(new Date(iso));
}

export function composeBookingEmail(n: BookingNotification): { subject: string; text: string } {
  // Never guess the host's zone. An unlabelled time in the wrong zone is worse than a
  // labelled one in UTC, because the reader has no way to know it is wrong.
  const tz = n.hostTimezone || "UTC";

  const day = fmt(n.startUtc, tz, { weekday: "long", day: "numeric", month: "long" });
  const from = fmt(n.startUtc, tz, { hour: "2-digit", minute: "2-digit", hour12: false });
  const to = fmt(n.endUtc, tz, { hour: "2-digit", minute: "2-digit", hour12: false });

  const who = n.attendeeName?.trim() || n.attendeeEmail;
  const subject = `New booking: ${who} — ${day}, ${from}`;

  const lines = [
    `${who} has booked a ${n.eventName.toLowerCase()}.`,
    "",
    `When:  ${day}, ${from}–${to} (${tz.replace(/_/g, " ")})`,
    `Email: ${n.attendeeEmail}`,
  ];

  // Attribution earns its place only when it exists. Printing "campaign: none" on every
  // public booking is noise that trains you to stop reading the email.
  if (n.source === "link" && (n.campaignId || n.wave)) {
    lines.push(`From:  campaign ${n.campaignId ?? "?"}${n.wave ? `, wave ${n.wave}` : ""}`);
  } else if (n.source === "public") {
    lines.push("From:  your booking page");
  }

  if (n.note) {
    lines.push("", "They added:", n.note);
  }

  lines.push("", "It is already in your calendar.");
  return { subject, text: lines.join("\n") };
}

/**
 * Send it. Returns what happened rather than throwing, so a caller can log without a
 * try/catch around something that must never break a booking.
 */
export async function notifyHost(
  to: string | null,
  n: BookingNotification,
): Promise<{ sent: boolean; reason?: string }> {
  if (!to || !to.includes("@")) return { sent: false, reason: "no host email on the connection" };
  if (!senderConfigured()) return { sent: false, reason: "no sender configured" };

  const problem = fromAddressProblem();
  if (problem) return { sent: false, reason: problem };

  const { subject, text } = composeBookingEmail(n);
  const result = await sendEmail({ to, subject, text });
  return result.ok ? { sent: true } : { sent: false, reason: result.reason };
}
