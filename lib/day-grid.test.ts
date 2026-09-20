import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveActiveDay, type DayGroup } from "./day-grid.ts";

const days = (...keys: string[]): DayGroup<string>[] => keys.map((k) => [k, [k + "-slot"]]);

test("no selection yet shows the first day", () => {
  assert.equal(resolveActiveDay(days("2026-09-21", "2026-09-22"), null), 0);
});

test("a selection that still exists is honoured", () => {
  assert.equal(resolveActiveDay(days("2026-09-21", "2026-09-22", "2026-09-23"), "2026-09-23"), 2);
});

test("the bug: a selection that vanished falls back rather than off the end", () => {
  // Tokyo viewer picked a 6th day that only exists in their zone; they switch to UTC and
  // the list rebuilds with 5. An index would have returned 5 and rendered an empty grid.
  const afterRebuild = days("2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25");
  assert.equal(resolveActiveDay(afterRebuild, "2026-09-26"), 0);
});

test("a rebuild that re-orders days follows the day, not the position", () => {
  // Honolulu viewer: the same slots regroup so an earlier local date appears at the front.
  assert.equal(resolveActiveDay(days("2026-09-20", "2026-09-21", "2026-09-22"), "2026-09-22"), 2);
});

test("an empty grid does not throw and does not claim a selection", () => {
  assert.equal(resolveActiveDay([], "2026-09-21"), 0);
  assert.equal(resolveActiveDay([], null), 0);
});

test("the result is always a valid index when there are days", () => {
  const d = days("a", "b", "c");
  for (const key of [null, "a", "b", "c", "nope", ""]) {
    const i = resolveActiveDay(d, key);
    assert.ok(i >= 0 && i < d.length, `${key} gave ${i}`);
  }
});
