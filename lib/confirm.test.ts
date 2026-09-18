import test from "node:test";
import assert from "node:assert/strict";
import {
  HOLD_MINUTES,
  confirmationRequired,
  canConfirm,
  composeConfirmEmail,
  confirmUrl,
  hashConfirmToken,
  holdExpiresAt,
  isWellFormedConfirmToken,
  mintConfirmToken,
} from "./confirm.ts";

const NOW = "2026-09-25T09:00:00.000Z";
const live = { status: "pending", confirmExpiresAt: "2026-09-25T09:10:00.000Z" };

test("a live hold confirms", () => {
  const r = canConfirm(live, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.already, false);
});

test("an expired hold does not", () => {
  const r = canConfirm({ status: "pending", confirmExpiresAt: "2026-09-25T08:59:59.000Z" }, NOW);
  assert.deepEqual(r, { ok: false, reason: "expired" });
});

test("clicking the link twice reads as success, not as a broken link", () => {
  // Someone who books, clicks again and is told "invalid link" will assume they have no
  // call and book a second time — which the per-email limit then refuses. Two failures
  // from one success.
  const r = canConfirm({ status: "confirmed", confirmExpiresAt: null }, NOW);
  assert.deepEqual(r, { ok: true, already: true });
});

test("a cancelled booking cannot be revived by its old confirmation link", () => {
  assert.deepEqual(canConfirm({ status: "cancelled", confirmExpiresAt: null }, NOW), {
    ok: false,
    reason: "cancelled",
  });
  assert.deepEqual(canConfirm({ status: "rescheduled", confirmExpiresAt: null }, NOW), {
    ok: false,
    reason: "cancelled",
  });
});

test("a pending row with no expiry is refused, not treated as eternal", () => {
  // Otherwise any row that reached 'pending' by some other route could be confirmed at any
  // point in the future.
  assert.deepEqual(canConfirm({ status: "pending", confirmExpiresAt: null }, NOW), {
    ok: false,
    reason: "expired",
  });
  assert.deepEqual(canConfirm({ status: "pending", confirmExpiresAt: "nonsense" }, NOW), {
    ok: false,
    reason: "expired",
  });
});

test("a missing row is not found", () => {
  assert.deepEqual(canConfirm(null, NOW), { ok: false, reason: "not_found" });
});

test("expiry is exactly the hold window, and the boundary is inclusive", () => {
  assert.equal(holdExpiresAt(NOW), "2026-09-25T09:15:00.000Z");
  const exact = { status: "pending", confirmExpiresAt: holdExpiresAt(NOW) };
  assert.equal(canConfirm(exact, "2026-09-25T09:15:00.000Z").ok, true, "the last instant still works");
  assert.equal(canConfirm(exact, "2026-09-25T09:15:00.001Z").ok, false);
  assert.equal(HOLD_MINUTES, 15);
});

test("the token is stored only as a hash", () => {
  const { token, tokenHash } = mintConfirmToken();
  assert.equal(isWellFormedConfirmToken(token), true);
  assert.equal(tokenHash, hashConfirmToken(token));
  assert.notEqual(tokenHash, token);
  assert.match(tokenHash, /^[0-9a-f]{64}$/);
  assert.notEqual(mintConfirmToken().token, token, "tokens must not repeat");
});

test("the confirm URL survives a base with a trailing slash", () => {
  assert.equal(confirmUrl("https://book.example.com/", "abc"), "https://book.example.com/c/abc");
  assert.equal(confirmUrl("https://book.example.com", "abc"), "https://book.example.com/c/abc");
});

test("the email carries nothing the booker typed", () => {
  // This mail may reach someone who did nothing, because the address is unverified — that
  // is the entire reason this step exists. Anything they typed, reflected back out through
  // the client's own sending domain, would recreate the hole being closed.
  const { subject, text } = composeConfirmEmail({
    clientName: "AG Outbound",
    eventName: "Intro call",
    startUtc: "2026-09-25T09:00:00Z",
    endUtc: "2026-09-25T09:30:00Z",
    attendeeTz: "Europe/London",
    url: "https://book.example.com/c/tok",
  });

  for (const attacker of ["Jane Okafor", "CLICK http://evil.example", "<script>"]) {
    assert.ok(!subject.includes(attacker) && !text.includes(attacker), attacker);
  }
  assert.match(text, /Friday 25 September, 10:00–10:30 \(Europe\/London\)/, "BST, not UTC");
  assert.match(text, /https:\/\/book\.example\.com\/c\/tok/);
  assert.match(text, /held for 15 minutes/);
  assert.match(text, /Nothing is booked/);
});

test("times render in the booker's zone, not the server's", () => {
  const { text } = composeConfirmEmail({
    clientName: "AG Outbound",
    eventName: "Intro call",
    startUtc: "2026-09-25T09:00:00Z",
    endUtc: "2026-09-25T09:30:00Z",
    attendeeTz: "America/New_York",
    url: "u",
  });
  assert.match(text, /05:00–05:30 \(America\/New York\)/);
});

test("confirmation defaults to ON, and only the exact string \"false\" turns it off", () => {
  // A missing or mistyped variable must give the careful behaviour. The opposite default
  // would start accepting unverified bookings and look identical to everything working.
  const original = process.env.REQUIRE_EMAIL_CONFIRMATION;
  try {
    delete process.env.REQUIRE_EMAIL_CONFIRMATION;
    assert.equal(confirmationRequired(), true, "unset must mean on");

    for (const v of ["", "0", "no", "FALSE", "off", "true"]) {
      process.env.REQUIRE_EMAIL_CONFIRMATION = v;
      assert.equal(confirmationRequired(), true, `${JSON.stringify(v)} must not switch it off`);
    }

    process.env.REQUIRE_EMAIL_CONFIRMATION = "false";
    assert.equal(confirmationRequired(), false);
  } finally {
    if (original === undefined) delete process.env.REQUIRE_EMAIL_CONFIRMATION;
    else process.env.REQUIRE_EMAIL_CONFIRMATION = original;
  }
});
