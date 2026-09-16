import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_EXPIRY_DAYS,
  MAX_LEADS_PER_REQUEST,
  bookingUrl,
  expiryFrom,
  parseMintRequest,
} from "./link-requests.ts";
import { checkBearer } from "./api-auth.ts";

const lead = { email: "jane@example.com", campaignId: "3685175", wave: "W3", sequenceStep: 1 };
const body = (over: Record<string, unknown> = {}) => ({
  eventTypeId: "et-1",
  leads: [lead],
  ...over,
});

// ── mint request parsing ────────────────────────────────────────────────────

test("a valid request parses and defaults sensibly", () => {
  const r = parseMintRequest(body());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.expiresInDays, DEFAULT_EXPIRY_DAYS);
  assert.equal(r.value.supersede, true, "superseding is the default, not opt-in");
  assert.equal(r.value.leads[0].wave, "W3");
  assert.equal(r.value.leads[0].sequenceStep, 1);
});

test("emails are lowercased and trimmed", () => {
  const r = parseMintRequest(body({ leads: [{ email: "  JANE@Example.COM " }] }));
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.leads[0].email, "jane@example.com");
});

test("a duplicate email in one request is rejected", () => {
  const r = parseMintRequest(body({ leads: [lead, { email: "JANE@example.com" }] }));
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "invalid_lead");
    assert.match(r.detail ?? "", /duplicate/);
  }
});

test("structural problems are each named", () => {
  const cases: [unknown, string][] = [
    [null, "invalid_body"],
    ["nope", "invalid_body"],
    [body({ eventTypeId: "" }), "missing_event_type"],
    [{ eventTypeId: "et-1" }, "invalid_body"],
    [body({ leads: [] }), "no_leads"],
    [body({ leads: Array.from({ length: MAX_LEADS_PER_REQUEST + 1 }, (_, i) => ({ email: `l${i}@e.com` })) }), "too_many_leads"],
    [body({ leads: [{ email: "not-an-email" }] }), "invalid_lead"],
    [body({ leads: [{ email: "a@b.com", sequenceStep: 0 }] }), "invalid_lead"],
    [body({ leads: [{ email: "a@b.com", sequenceStep: 1.5 }] }), "invalid_lead"],
    [body({ expiresInDays: 0 }), "invalid_expiry"],
    [body({ expiresInDays: 400 }), "invalid_expiry"],
    [body({ expiresInDays: 30.5 }), "invalid_expiry"],
  ];
  for (const [input, reason] of cases) {
    const r = parseMintRequest(input);
    assert.equal(r.ok, false, JSON.stringify(input).slice(0, 60));
    if (!r.ok) assert.equal(r.reason, reason, JSON.stringify(input).slice(0, 60));
  }
});

test("a full wave is accepted", () => {
  const leads = Array.from({ length: MAX_LEADS_PER_REQUEST }, (_, i) => ({ email: `lead${i}@example.com` }));
  assert.equal(parseMintRequest(body({ leads })).ok, true);
});

test("supersede can be turned off explicitly", () => {
  const r = parseMintRequest(body({ supersede: false }));
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.supersede, false);
});

// ── helpers ─────────────────────────────────────────────────────────────────

test("expiry is computed from the supplied now, not the clock", () => {
  assert.equal(expiryFrom("2026-01-05T00:00:00.000Z", 60), "2026-03-06T00:00:00.000Z");
});

test("booking urls survive a trailing slash on the base", () => {
  assert.equal(bookingUrl("https://book.example.com/", "abc"), "https://book.example.com/b/abc");
  assert.equal(bookingUrl("https://book.example.com", "abc"), "https://book.example.com/b/abc");
});

// ── auth ────────────────────────────────────────────────────────────────────

test("an unset key fails closed rather than allowing everything", () => {
  const r = checkBearer("Bearer anything", undefined);
  assert.deepEqual(r, { ok: false, reason: "unconfigured" });
});

test("the right key is accepted, a wrong one is not", () => {
  assert.deepEqual(checkBearer("Bearer s3cret", "s3cret"), { ok: true });
  assert.deepEqual(checkBearer("Bearer s3creT", "s3cret"), { ok: false, reason: "invalid" });
  assert.deepEqual(checkBearer("Bearer short", "s3cret"), { ok: false, reason: "invalid" });
});

test("a malformed or absent header is rejected", () => {
  for (const h of [null, "", "s3cret", "Basic s3cret", "Bearer"]) {
    const r = checkBearer(h, "s3cret");
    assert.equal(r.ok, false, String(h));
  }
});
