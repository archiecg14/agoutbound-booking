import test from "node:test";
import assert from "node:assert/strict";
import { MAX_ATTEMPTS, decide, scheduleFor, subjectFor } from "./reminders.ts";
import { fromAddressProblem, sendEmail, senderConfigured } from "./email-sender.ts";

const START = "2026-09-20T10:00:00.000Z";
const END = "2026-09-20T10:30:00.000Z";

const rem = (over: Partial<Parameters<typeof decide>[0]> = {}) => ({
  id: "r1",
  bookingId: "b1",
  kind: "hour_before" as const,
  dueAt: "2026-09-20T09:00:00.000Z",
  status: "pending",
  attempts: 0,
  ...over,
});

const bk = (over: Partial<Parameters<typeof decide>[1] & object> = {}) => ({
  id: "b1",
  status: "confirmed",
  startUtc: START,
  attendeeEmail: "jane@example.com",
  ...over,
});

// ── scheduling ──────────────────────────────────────────────────────────────

test("a booking well in advance gets all three reminders, in order", () => {
  const s = scheduleFor(START, END, "2026-09-01T00:00:00Z");
  assert.deepEqual(s.map((r) => r.kind), ["day_before", "hour_before", "follow_up"]);
  assert.equal(s[0].dueAt, "2026-09-19T10:00:00.000Z");
  assert.equal(s[1].dueAt, "2026-09-20T09:00:00.000Z");
  assert.equal(s[2].dueAt, "2026-09-20T11:00:00.000Z", "30 minutes after the call ends");
});

test("a short-notice booking does not schedule reminders already in the past", () => {
  // Booked 20 minutes before the call: an "in an hour" reminder would be due immediately
  // and fire the moment the cron next ran, which is absurd.
  const s = scheduleFor(START, END, "2026-09-20T09:40:00Z");
  assert.deepEqual(s.map((r) => r.kind), ["follow_up"]);
});

test("unparseable times schedule nothing rather than throwing", () => {
  assert.deepEqual(scheduleFor("nope", END, "2026-09-01T00:00:00Z"), []);
  assert.deepEqual(scheduleFor(START, END, "nope"), []);
});

// ── the send decision ───────────────────────────────────────────────────────

test("a due reminder for a live booking is sent", () => {
  assert.deepEqual(decide(rem(), bk(), "2026-09-20T09:00:30Z"), { action: "send" });
});

test("a reminder that is not due yet waits", () => {
  assert.deepEqual(decide(rem(), bk(), "2026-09-20T08:00:00Z"), { action: "wait" });
});

test("a cancelled booking is never reminded", () => {
  const d = decide(rem(), bk({ status: "cancelled" }), "2026-09-20T09:00:30Z");
  assert.equal(d.action, "skip");
});

test("a reminder that missed its window is skipped, not sent late", () => {
  // "Your call is in an hour" arriving three hours late is confusing at best and makes the
  // sender look broken at worst.
  const d = decide(rem(), bk(), "2026-09-20T12:00:00Z");
  assert.equal(d.action, "skip");
  if (d.action === "skip") assert.match(d.reason, /too late/);
});

test("a pre-call reminder is skipped once the call has started", () => {
  const d = decide(rem({ dueAt: "2026-09-20T09:59:00.000Z" }), bk(), "2026-09-20T10:05:00Z");
  assert.equal(d.action, "skip");
});

test("the follow-up is sent AFTER the call, by design", () => {
  const d = decide(
    rem({ kind: "follow_up", dueAt: "2026-09-20T11:00:00.000Z" }),
    bk(),
    "2026-09-20T11:01:00Z",
  );
  assert.deepEqual(d, { action: "send" });
});

test("a booking that no longer exists, or has no email, is skipped", () => {
  assert.equal(decide(rem(), null, "2026-09-20T09:00:30Z").action, "skip");
  assert.equal(decide(rem(), bk({ attendeeEmail: "" }), "2026-09-20T09:00:30Z").action, "skip");
});

test("retries stop at the limit instead of looping forever", () => {
  const d = decide(rem({ attempts: MAX_ATTEMPTS }), bk(), "2026-09-20T09:00:30Z");
  assert.equal(d.action, "skip");
});

test("an already-sent reminder is never reconsidered", () => {
  assert.equal(decide(rem({ status: "sent" }), bk(), "2026-09-20T09:00:30Z").action, "skip");
});

test("subjects name the client", () => {
  assert.match(subjectFor("day_before", "Acme Recruitment"), /Tomorrow.*Acme Recruitment/);
  assert.match(subjectFor("hour_before", "Acme Recruitment"), /In an hour/);
});

// ── sender configuration ────────────────────────────────────────────────────

test("a reminder must not be sent from a cold-outreach domain", () => {
  // Booking mail and campaign mail must not share a fate: one spam complaint on outreach
  // should never stop a confirmed attendee being reminded.
  const saved = { from: process.env.REMINDER_FROM, cold: process.env.COLD_EMAIL_DOMAINS };
  try {
    process.env.COLD_EMAIL_DOMAINS = "acme-recruitment.com, agoutbound-mail.co.uk";

    process.env.REMINDER_FROM = "bookings@agoutbound-mail.co.uk";
    assert.match(fromAddressProblem() ?? "", /cold-outreach domain/);

    process.env.REMINDER_FROM = "bookings@book.agoutbound.co.uk";
    assert.equal(fromAddressProblem(), null, "a separate domain is fine");

    delete process.env.REMINDER_FROM;
    assert.match(fromAddressProblem() ?? "", /not set/);
  } finally {
    process.env.REMINDER_FROM = saved.from;
    process.env.COLD_EMAIL_DOMAINS = saved.cold;
    if (saved.from === undefined) delete process.env.REMINDER_FROM;
    if (saved.cold === undefined) delete process.env.COLD_EMAIL_DOMAINS;
  }
});

test("with no sender configured, sending fails loudly and is not retryable", () => {
  const saved = process.env.RESEND_API_KEY;
  try {
    delete process.env.RESEND_API_KEY;
    assert.equal(senderConfigured(), false);
    return sendEmail({ to: "a@b.com", subject: "s", text: "t" }).then((r) => {
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.match(r.reason, /no sender/);
        // Retrying a missing configuration forever would bury it.
        assert.equal(r.retryable, false);
      }
    });
  } finally {
    if (saved === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = saved;
  }
});
