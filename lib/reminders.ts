/**
 * Reminder scheduling. Pure — no I/O, no clock.
 *
 * The deliverability constraint shapes this whole module. AG Outbound's cold-email domains
 * currently land in Microsoft's junk folder, so a reminder sent from that infrastructure is
 * worse than no reminder at all: it manufactures the no-show it was meant to prevent, and
 * it spends sending reputation on a person who already agreed to the call.
 *
 * So:
 *   1. Reminders go out over a transactional sender on a SEPARATE domain from the
 *      cold-email domains. Campaign reputation and booking reputation must not share a
 *      fate — a spam complaint on outreach must not stop a confirmed attendee being
 *      reminded, and vice versa.
 *   2. With no sender configured, reminders are recorded as 'skipped' with a reason. They
 *      are never silently dropped, and never counted as sent.
 *   3. Google's own invitation and update emails already reach the attendee from Google's
 *      infrastructure. Those are not reminders and arrive regardless of any of this.
 *
 * UNVERIFIED: whether an organiser's `reminders.overrides` on a Google event reach the
 * ATTENDEE or only the organiser's own copy. Attendee-side reminder behaviour is governed
 * by the attendee's own calendar settings, so this module does not assume Google will
 * remind them.
 */

export type ReminderKind = "day_before" | "hour_before" | "follow_up";

export type ScheduledReminder = { kind: ReminderKind; dueAt: string };

/** Minutes before the call (negative means after it ends). */
export const OFFSETS: Record<ReminderKind, number> = {
  day_before: 24 * 60,
  hour_before: 60,
  follow_up: -30,
};

/**
 * What a booking should have scheduled. Anything already in the past at scheduling time is
 * omitted rather than created-and-immediately-due: a booking made 20 minutes before the
 * call should not fire an "in an hour" reminder the moment it is created.
 */
export function scheduleFor(startUtc: string, endUtc: string, now: string): ScheduledReminder[] {
  const start = Date.parse(startUtc);
  const end = Date.parse(endUtc);
  const nowMs = Date.parse(now);
  if (Number.isNaN(start) || Number.isNaN(end) || Number.isNaN(nowMs)) return [];

  const out: ScheduledReminder[] = [];
  for (const kind of Object.keys(OFFSETS) as ReminderKind[]) {
    const offset = OFFSETS[kind];
    const base = offset >= 0 ? start : end;
    const due = base - offset * 60_000;
    if (due <= nowMs) continue;
    out.push({ kind, dueAt: new Date(due).toISOString() });
  }
  return out.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
}

export type ReminderRow = {
  id: string;
  bookingId: string;
  kind: ReminderKind;
  dueAt: string;
  status: string;
  attempts: number;
};

export type BookingSnapshot = {
  id: string;
  status: string;
  startUtc: string;
  attendeeEmail: string;
};

export type Decision =
  | { action: "send" }
  | { action: "skip"; reason: string }
  | { action: "wait" };

export const MAX_ATTEMPTS = 3;

/**
 * Whether one pending reminder should go out right now.
 *
 * Every refusal here is a case where sending would actively harm: reminding someone about a
 * call that was cancelled, or arriving so late it tells them about a meeting that already
 * happened.
 */
export function decide(
  reminder: ReminderRow,
  booking: BookingSnapshot | null,
  now: string,
  lateToleranceMin = 120,
): Decision {
  if (reminder.status !== "pending") return { action: "skip", reason: "not pending" };
  if (!booking) return { action: "skip", reason: "booking no longer exists" };

  const nowMs = Date.parse(now);
  const dueMs = Date.parse(reminder.dueAt);
  if (Number.isNaN(nowMs) || Number.isNaN(dueMs)) return { action: "skip", reason: "unparseable time" };
  if (dueMs > nowMs) return { action: "wait" };

  if (booking.status === "cancelled") return { action: "skip", reason: "booking cancelled" };
  if (reminder.attempts >= MAX_ATTEMPTS) return { action: "skip", reason: "too many attempts" };
  if (!booking.attendeeEmail) return { action: "skip", reason: "no attendee email" };

  // A reminder that missed its window is worse than none. "Your call is in an hour" arriving
  // three hours late is confusing at best and makes the sender look broken at worst.
  if (reminder.kind !== "follow_up" && nowMs - dueMs > lateToleranceMin * 60_000) {
    return { action: "skip", reason: "too late to be useful" };
  }

  // The follow-up is the exception: it is sent after the call by design.
  if (reminder.kind !== "follow_up" && Date.parse(booking.startUtc) <= nowMs) {
    return { action: "skip", reason: "call has already started" };
  }

  return { action: "send" };
}

export function subjectFor(kind: ReminderKind, clientName: string): string {
  switch (kind) {
    case "day_before":
      return `Tomorrow: your call with ${clientName}`;
    case "hour_before":
      return `In an hour: your call with ${clientName}`;
    case "follow_up":
      return `Thanks for your time — ${clientName}`;
  }
}
