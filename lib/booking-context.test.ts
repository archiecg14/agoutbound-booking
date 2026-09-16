import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RANGE_DAYS,
  MAX_RANGE_DAYS,
  resolveRange,
} from "./booking-context.ts";

const NOW = "2026-01-05T12:00:00.000Z";
const days = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86_400_000;

test("no range given defaults to a sensible window starting now", () => {
  const r = resolveRange(null, null, NOW);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.from, NOW);
  assert.equal(days(r.from, r.to), DEFAULT_RANGE_DAYS);
});

test("a range in the past is floored at now", () => {
  const r = resolveRange("2025-01-01T00:00:00Z", "2026-01-20T00:00:00Z", NOW);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.from, NOW, "never offers times that have already passed");
});

test("an over-long range is clamped rather than refused", () => {
  const r = resolveRange(NOW, "2030-01-01T00:00:00Z", NOW);
  assert.equal(r.ok, true);
  // Public endpoint, one Google round trip per call — an unbounded window is free work
  // for anyone who asks, so it is capped rather than served.
  if (r.ok) assert.equal(days(r.from, r.to), MAX_RANGE_DAYS);
});

test("a range inside the cap is preserved exactly", () => {
  const r = resolveRange("2026-01-06T00:00:00Z", "2026-01-13T00:00:00Z", NOW);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.from, "2026-01-06T00:00:00.000Z");
    assert.equal(r.to, "2026-01-13T00:00:00.000Z");
  }
});

test("nonsense ranges are refused", () => {
  const cases: [string | null, string | null][] = [
    ["not-a-date", null],
    [null, "not-a-date"],
    ["2026-01-20T00:00:00Z", "2026-01-10T00:00:00Z"], // to before from
    ["2026-01-10T00:00:00Z", "2026-01-10T00:00:00Z"], // zero width
  ];
  for (const [from, to] of cases) {
    assert.equal(resolveRange(from, to, NOW).ok, false, `${from} → ${to}`);
  }
});

test("an entirely past window collapses to nothing rather than inverting", () => {
  const r = resolveRange("2025-01-01T00:00:00Z", "2025-06-01T00:00:00Z", NOW);
  assert.equal(r.ok, false, "a window that ends before now has no slots to offer");
});

test("an unparseable now is refused rather than silently treated as epoch", () => {
  assert.equal(resolveRange(null, null, "whenever").ok, false);
});
