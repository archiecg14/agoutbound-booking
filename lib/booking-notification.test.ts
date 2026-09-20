import test from "node:test";
import assert from "node:assert/strict";
import { composeBookingEmail, notifyHost, type BookingNotification } from "./booking-notification.ts";

const base: BookingNotification = {
  clientName: "AG Outbound",
  eventName: "Intro call",
  attendeeName: "Jane Okafor",
  attendeeEmail: "jane@example.com",
  startUtc: "2026-09-21T08:00:00.000Z",
  endUtc: "2026-09-21T08:30:00.000Z",
  hostTimezone: "Europe/London",
  note: null,
  campaignId: null,
  wave: null,
  source: "public",
};

test("the opening line takes the article the event name needs", () => {
  // This line shipped as "has booked a intro call" because nothing asserted it.
  const { text } = composeBookingEmail(base);
  assert.match(text, /has booked an intro call\./);
});

test("an event name starting on a consonant takes 'a'", () => {
  const { text } = composeBookingEmail({ ...base, eventName: "Discovery call" });
  assert.match(text, /has booked a discovery call\./);
});

test("the subject says who and when, so it reads on a lock screen", () => {
  const { subject } = composeBookingEmail(base);
  assert.match(subject, /New booking: Jane Okafor/);
  assert.match(subject, /Monday 21 September/);
  assert.match(subject, /09:00/, "host's local time, not the stored 08:00Z");
});

test("times are rendered in the HOST's zone and the zone is stated", () => {
  const { text } = composeBookingEmail(base);
  assert.match(text, /09:00–09:30/);
  assert.match(text, /Europe\/London/);
});

test("an unknown host zone falls back to UTC and SAYS so", () => {
  // An unlabelled time in the wrong zone is worse than a labelled one in UTC, because the
  // reader has no way to know it is wrong.
  const { text } = composeBookingEmail({ ...base, hostTimezone: null });
  assert.match(text, /08:00–08:30/);
  assert.match(text, /UTC/);
});

test("a public booking says where it came from without pretending to attribution", () => {
  const { text } = composeBookingEmail(base);
  assert.match(text, /your booking page/);
  assert.ok(!/campaign/i.test(text), "must not print an empty campaign line");
});

test("a campaign booking names the campaign and wave", () => {
  const { text } = composeBookingEmail({
    ...base,
    source: "link",
    campaignId: "3685175",
    wave: "W3",
  });
  assert.match(text, /campaign 3685175/);
  assert.match(text, /wave W3/);
});

test("a link booking with no attribution does not print an empty line", () => {
  const { text } = composeBookingEmail({ ...base, source: "link" });
  assert.ok(!/campaign/i.test(text));
});

test("the attendee's note is included when they left one", () => {
  const { text } = composeBookingEmail({ ...base, note: "Hiring two field engineers" });
  assert.match(text, /They added:/);
  assert.match(text, /Hiring two field engineers/);
});

test("a nameless attendee falls back to their email rather than a blank", () => {
  const { subject } = composeBookingEmail({ ...base, attendeeName: "   " });
  assert.match(subject, /jane@example\.com/);
});

test("no host email means no send, reported rather than thrown", async () => {
  for (const to of [null, "", "not-an-email"]) {
    const r = await notifyHost(to, base);
    assert.equal(r.sent, false);
    assert.match(r.reason ?? "", /host email/);
  }
});

test("an unconfigured sender is reported, never silently treated as sent", async () => {
  const saved = process.env.RESEND_API_KEY;
  try {
    delete process.env.RESEND_API_KEY;
    const r = await notifyHost("archie@example.com", base);
    assert.equal(r.sent, false);
    assert.match(r.reason ?? "", /no sender/);
  } finally {
    if (saved === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = saved;
  }
});
