import test from "node:test";
import assert from "node:assert/strict";
import {
  decideBooking,
  publicRefusal,
  validateRequestShape,
  type EventTypeRow,
  type LinkTokenRow,
} from "./booking-checks.ts";
import { hashToken, isWellFormedToken, mintToken } from "./tokens.ts";

const NOW = "2026-01-05T08:00:00.000Z";
const SLOT = { start: "2026-01-05T09:00:00.000Z", end: "2026-01-05T09:30:00.000Z" };

const token = (over: Partial<LinkTokenRow> = {}): LinkTokenRow => ({
  id: "tok-1",
  eventTypeId: "et-1",
  clientId: "cl-1",
  leadEmail: "lead@example.com",
  expiresAt: "2026-02-01T00:00:00.000Z",
  usedAt: null,
  ...over,
});

const eventType = (over: Partial<EventTypeRow> = {}): EventTypeRow => ({
  id: "et-1",
  clientId: "cl-1",
  connectionId: "cn-1",
  durationMin: 30,
  active: true,
  ...over,
});

const request = {
  start: SLOT.start,
  attendeeName: "Jane Doe",
  attendeeEmail: "jane@example.com",
  attendeeTz: "Europe/London",
  note: null,
};

type DecideArgs = Parameters<typeof decideBooking>[0];

function decide(over: Partial<DecideArgs> = {}) {
  const base: DecideArgs = {
    token: token(),
    eventType: eventType(),
    request,
    offeredSlots: [SLOT],
    now: NOW,
  };
  return decideBooking({ ...base, ...over });
}

// ── shape validation ────────────────────────────────────────────────────────

test("a well-formed request is accepted and normalised", () => {
  const r = validateRequestShape({
    start: "2026-01-05T09:00:00Z",
    attendeeName: "  Jane Doe  ",
    attendeeEmail: "JANE@Example.COM",
    attendeeTz: "Europe/London",
  });
  assert.ok(r);
  assert.equal(r.attendeeName, "Jane Doe", "trimmed");
  assert.equal(r.attendeeEmail, "jane@example.com", "lowercased");
  assert.equal(r.start, "2026-01-05T09:00:00.000Z", "normalised to ISO");
});

test("the optional note is trimmed, and blank means absent", () => {
  const withNote = validateRequestShape({ ...request, note: "  hiring 3 field engineers  " });
  assert.equal(withNote?.note, "hiring 3 field engineers");

  for (const blank of ["", "   ", null, undefined]) {
    const r = validateRequestShape({ ...request, note: blank });
    assert.equal(r?.note, null, `blank note ${JSON.stringify(blank)} should be null, not ""`);
  }
});

test("an oversized or non-string note is rejected outright", () => {
  // It ends up in a calendar invite and a database row; unbounded is not an option.
  assert.equal(validateRequestShape({ ...request, note: "x".repeat(2001) }), null);
  assert.equal(validateRequestShape({ ...request, note: 42 }), null);
});

test("malformed requests are rejected", () => {
  const bad: unknown[] = [
    null,
    "not an object",
    { ...request, start: "not-a-date" },
    { ...request, attendeeEmail: "no-at-sign" },
    { ...request, attendeeName: "   " },
    { ...request, attendeeTz: "Mars/Olympus" },
    { ...request, attendeeTz: undefined },
  ];
  for (const b of bad) assert.equal(validateRequestShape(b), null, JSON.stringify(b));
});

// ── tokens ──────────────────────────────────────────────────────────────────

test("minted tokens are well formed and hash stably", () => {
  const { token: t, tokenHash } = mintToken();
  assert.ok(isWellFormedToken(t), t);
  assert.equal(hashToken(t), tokenHash);
  assert.equal(hashToken(t).length, 64);
  assert.notEqual(mintToken().token, mintToken().token);
});

test("junk is rejected before any database round trip", () => {
  for (const t of ["", "short", "  ", null, 42, "x".repeat(44), "has spaces in it!!"]) {
    assert.equal(isWellFormedToken(t), false, String(t));
  }
});

// ── the decision ────────────────────────────────────────────────────────────

test("a valid booking is allowed and carries the server's own slot times", () => {
  const d = decide();
  assert.equal(d.ok, true);
  if (d.ok) {
    assert.equal(d.start, SLOT.start);
    assert.equal(d.end, SLOT.end, "end comes from the offered slot, never from the client");
  }
});

test("an expired link is refused", () => {
  const d = decide({ token: token({ expiresAt: "2026-01-01T00:00:00.000Z" }) });
  assert.deepEqual(d, { ok: false, reason: "token_expired" });
});

test("a spent link is refused", () => {
  const d = decide({ token: token({ usedAt: "2026-01-04T00:00:00.000Z" }) });
  assert.deepEqual(d, { ok: false, reason: "token_used" });
});

test("a missing link is refused", () => {
  assert.deepEqual(decide({ token: null }), { ok: false, reason: "token_not_found" });
});

test("a token pointing at a different event type is refused", () => {
  const d = decide({ eventType: eventType({ id: "et-OTHER" }) });
  assert.deepEqual(d, { ok: false, reason: "event_mismatch" });
});

test("a token crossing client boundaries is refused", () => {
  // The important one: MKA's link must never book into Supply Drive's calendar.
  const d = decide({ eventType: eventType({ clientId: "cl-OTHER" }) });
  assert.deepEqual(d, { ok: false, reason: "event_mismatch" });
});

test("an inactive event type is refused", () => {
  const d = decide({ eventType: eventType({ active: false }) });
  assert.deepEqual(d, { ok: false, reason: "event_inactive" });
});

test("a time the server never offered is refused", () => {
  const d = decide({ request: { ...request, start: "2026-01-05T03:00:00.000Z" } });
  assert.deepEqual(d, { ok: false, reason: "slot_not_offered" });
});

test("an empty slot list refuses everything", () => {
  assert.deepEqual(decide({ offeredSlots: [] }), { ok: false, reason: "slot_not_offered" });
});

// ── what the caller is told ─────────────────────────────────────────────────

test("token refusals are indistinguishable to the caller", () => {
  const messages = (["token_not_found", "token_expired", "token_used", "token_malformed"] as const).map(
    (r) => publicRefusal(r).message,
  );
  assert.equal(new Set(messages).size, 1, "probing must not enumerate valid tokens");
  assert.equal(publicRefusal("token_used").status, 404);
});

test("a taken slot is a 409, not a 404", () => {
  assert.equal(publicRefusal("slot_not_offered").status, 409);
});
