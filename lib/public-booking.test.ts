import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_FUTURE_PER_EMAIL,
  MAX_PER_IP_PER_HOUR,
  checkLimits,
  publicRefusalMessage,
  truncateIp,
  validatePublicRequest,
} from "./public-booking.ts";

const good = {
  start: "2026-09-21T09:00:00Z",
  name: "Jane Okafor",
  email: "Jane@Example.COM ",
  timezone: "Europe/London",
};

test("a valid submission is accepted and normalised", () => {
  const r = validatePublicRequest({ ...good, note: "  hiring two engineers  " });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.email, "jane@example.com");
  assert.equal(r.value.note, "hiring two engineers");
  assert.equal(r.value.start, "2026-09-21T09:00:00.000Z");
});

test("the honeypot rejects silently, with no hint as to why", () => {
  // A bot told why it failed is a bot that tries again differently.
  const r = validatePublicRequest({ ...good, company: "Acme Ltd" });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "rejected");
    assert.equal(
      publicRefusalMessage("rejected").message,
      publicRefusalMessage("invalid_request").message,
      "must be indistinguishable from an ordinary validation failure",
    );
  }
});

test("an empty honeypot is fine", () => {
  assert.equal(validatePublicRequest({ ...good, company: "   " }).ok, true);
});

test("bad submissions are refused", () => {
  const bad: unknown[] = [
    null,
    "nope",
    { ...good, email: "not-an-email" },
    { ...good, name: "J" },
    { ...good, name: "   " },
    { ...good, timezone: "Mars/Olympus" },
    { ...good, start: "whenever" },
    { ...good, note: "x".repeat(2001) },
  ];
  for (const b of bad) assert.equal(validatePublicRequest(b).ok, false, JSON.stringify(b).slice(0, 50));
});

test("one future booking per person per event type", () => {
  // Without this, one visitor can hold every slot in the week.
  assert.deepEqual(checkLimits({ futureBookingsForEmail: 0, bookingsFromIpLastHour: 0 }), { ok: true });
  const r = checkLimits({ futureBookingsForEmail: MAX_FUTURE_PER_EMAIL, bookingsFromIpLastHour: 0 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "already_booked");
});

test("an address is capped per hour", () => {
  const r = checkLimits({ futureBookingsForEmail: 0, bookingsFromIpLastHour: MAX_PER_IP_PER_HOUR });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "rate_limited");
  assert.equal(publicRefusalMessage("rate_limited").status, 429);
});

test("IPs are truncated before storage", () => {
  // The host portion adds nothing to rate limiting and everything to what a leak exposes.
  assert.equal(truncateIp("203.0.113.42"), "203.0.113.0/24");
  assert.equal(truncateIp("2001:db8:85a3:8d3:1319:8a2e:370:7348"), "2001:db8:85a3:8d3::/64");
  assert.equal(truncateIp(null), null);
  assert.equal(truncateIp("garbage"), null);
  // The header-parsing assertion that used to live here encoded the BUG: it asserted the
  // left-most x-forwarded-for entry was used, which is the value a caller supplies. Header
  // handling now lives in client-ip.ts and is tested there, right-most first.
});

test("an already-booked visitor gets a useful message, not a generic error", () => {
  const m = publicRefusalMessage("already_booked");
  assert.equal(m.status, 409);
  assert.match(m.message, /already have a call booked/);
});

test("a non-public event type is indistinguishable from one that does not exist", () => {
  assert.deepEqual(publicRefusalMessage("not_public"), publicRefusalMessage("event_inactive"));
  assert.equal(publicRefusalMessage("not_public").status, 404);
});
