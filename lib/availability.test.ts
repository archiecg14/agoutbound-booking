/**
 * Run: npm test
 *
 * Expected UTC instants are written out by hand rather than computed with luxon. Computing
 * them with the same library the code uses would make the assertions tautological — the
 * test would agree with a wrong implementation.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { computeSlots, type ComputeSlotsInput } from "./availability.ts";

const LONDON = "Europe/London";

/** Mon–Fri 09:00–17:00 London. Schema weekday: 0 = Sunday. */
const weekdays9to5 = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  startLocal: "09:00",
  endLocal: "17:00",
  timezone: LONDON,
}));

function input(over: Partial<ComputeSlotsInput> = {}): ComputeSlotsInput {
  return {
    rules: weekdays9to5,
    overrides: [],
    busy: [],
    eventType: {
      durationMin: 30,
      bufferBeforeMin: 0,
      bufferAfterMin: 0,
      minNoticeMin: 0,
      dateRangeDays: 365,
      slotIntervalMin: 30,
    },
    from: "2026-01-05T00:00:00Z",
    to: "2026-01-06T00:00:00Z",
    now: "2026-01-01T00:00:00Z",
    ...over,
  };
}

test("a winter working day yields 9-5 London, which is 09:00Z in GMT", () => {
  const slots = computeSlots(input());
  assert.equal(slots.length, 16); // 8 hours / 30 min
  assert.equal(slots[0].start, "2026-01-05T09:00:00.000Z");
  assert.equal(slots[0].end, "2026-01-05T09:30:00.000Z");
  assert.equal(slots[slots.length - 1].start, "2026-01-05T16:30:00.000Z");
});

test("DST: the same rule in summer still starts at 09:00 LOCAL, so 08:00Z", () => {
  const slots = computeSlots(
    input({
      from: "2026-07-06T00:00:00Z",
      to: "2026-07-07T00:00:00Z",
      now: "2026-07-01T00:00:00Z",
    }),
  );
  assert.equal(slots.length, 16);
  assert.equal(slots[0].start, "2026-07-06T08:00:00.000Z");
  assert.equal(slots[slots.length - 1].start, "2026-07-06T15:30:00.000Z");
});

test("DST: the transition week produces correct instants on both sides", () => {
  // Fri 27 Mar (GMT) and Mon 30 Mar (BST) straddle the 29 March London transition.
  const before = computeSlots(
    input({ from: "2026-03-27T00:00:00Z", to: "2026-03-28T00:00:00Z", now: "2026-03-01T00:00:00Z" }),
  );
  const after = computeSlots(
    input({ from: "2026-03-30T00:00:00Z", to: "2026-03-31T00:00:00Z", now: "2026-03-01T00:00:00Z" }),
  );
  assert.equal(before[0].start, "2026-03-27T09:00:00.000Z", "GMT side");
  assert.equal(after[0].start, "2026-03-30T08:00:00.000Z", "BST side");
});

test("min notice pushes the floor forward from now, not from the window start", () => {
  const slots = computeSlots(
    input({ now: "2026-01-05T09:05:00Z", eventType: { ...input().eventType, minNoticeMin: 120 } }),
  );
  // Floor is 11:05Z; the first aligned slot that fits is 11:30.
  assert.equal(slots[0].start, "2026-01-05T11:30:00.000Z");
});

test("date range caps how far out slots are offered", () => {
  const slots = computeSlots(
    input({
      from: "2026-01-05T00:00:00Z",
      to: "2026-01-30T00:00:00Z",
      now: "2026-01-05T00:00:00Z",
      eventType: { ...input().eventType, dateRangeDays: 2 },
    }),
  );
  const last = slots[slots.length - 1].start;
  assert.ok(last < "2026-01-07T00:00:00.000Z", `last slot ${last} should be inside 2 days`);
});

test("a busy interval removes exactly the slots it overlaps", () => {
  const slots = computeSlots(
    input({ busy: [{ start: "2026-01-05T10:00:00Z", end: "2026-01-05T11:00:00Z" }] }),
  );
  const starts = slots.map((s) => s.start);
  assert.ok(!starts.includes("2026-01-05T10:00:00.000Z"));
  assert.ok(!starts.includes("2026-01-05T10:30:00.000Z"));
  assert.ok(starts.includes("2026-01-05T09:30:00.000Z"), "the slot ending at 10:00 survives");
  assert.ok(starts.includes("2026-01-05T11:00:00.000Z"), "the slot starting at 11:00 survives");
});

test("buffers guard against adjacent meetings", () => {
  const slots = computeSlots(
    input({
      busy: [{ start: "2026-01-05T10:00:00Z", end: "2026-01-05T11:00:00Z" }],
      eventType: { ...input().eventType, bufferBeforeMin: 15, bufferAfterMin: 15 },
    }),
  );
  const starts = slots.map((s) => s.start);
  assert.ok(!starts.includes("2026-01-05T09:30:00.000Z"), "ends at 10:00, inside the after-buffer");
  assert.ok(!starts.includes("2026-01-05T11:00:00.000Z"), "starts at 11:00, inside the before-buffer");
  assert.ok(starts.includes("2026-01-05T11:30:00.000Z"), "clear of the buffer");
});

test("buffers do NOT push the first slot away from the start of working hours", () => {
  const slots = computeSlots(
    input({ eventType: { ...input().eventType, bufferBeforeMin: 30, bufferAfterMin: 30 } }),
  );
  assert.equal(slots[0].start, "2026-01-05T09:00:00.000Z");
});

test("a whole-day override blocks the day", () => {
  const slots = computeSlots(
    input({ overrides: [{ onDate: "2026-01-05", kind: "block", timezone: LONDON }] }),
  );
  assert.equal(slots.length, 0);
});

test("a partial override blocks only those hours", () => {
  const slots = computeSlots(
    input({
      overrides: [
        { onDate: "2026-01-05", kind: "block", startLocal: "12:00", endLocal: "14:00", timezone: LONDON },
      ],
    }),
  );
  const starts = slots.map((s) => s.start);
  assert.ok(!starts.includes("2026-01-05T12:00:00.000Z"));
  assert.ok(!starts.includes("2026-01-05T13:30:00.000Z"));
  assert.ok(starts.includes("2026-01-05T14:00:00.000Z"));
  assert.equal(slots.length, 12);
});

test("an 'open' override adds a one-off Saturday that no rule covers", () => {
  const slots = computeSlots(
    input({
      from: "2026-01-10T00:00:00Z", // Saturday
      to: "2026-01-11T00:00:00Z",
      overrides: [
        { onDate: "2026-01-10", kind: "open", startLocal: "10:00", endLocal: "12:00", timezone: LONDON },
      ],
    }),
  );
  assert.equal(slots.length, 4);
  assert.equal(slots[0].start, "2026-01-10T10:00:00.000Z");
});

test("no rules means no slots", () => {
  assert.deepEqual(computeSlots(input({ rules: [] })), []);
});

test("a slot never straddles the end of the working day", () => {
  const slots = computeSlots(
    input({ eventType: { ...input().eventType, durationMin: 45, slotIntervalMin: 45 } }),
  );
  const last = slots[slots.length - 1];
  assert.ok(last.end <= "2026-01-05T17:00:00.000Z", `${last.end} overruns 17:00 GMT`);
});

test("overlapping rules do not produce duplicate slots", () => {
  const slots = computeSlots(
    input({
      rules: [
        { weekday: 1, startLocal: "09:00", endLocal: "13:00", timezone: LONDON },
        { weekday: 1, startLocal: "11:00", endLocal: "17:00", timezone: LONDON },
      ],
    }),
  );
  assert.equal(new Set(slots.map((s) => s.start)).size, slots.length);
  assert.equal(slots.length, 16, "the union is still 09:00-17:00");
});

test("a rule in a different zone resolves to that zone's instants", () => {
  const slots = computeSlots(
    input({
      rules: [{ weekday: 1, startLocal: "09:00", endLocal: "10:00", timezone: "America/New_York" }],
    }),
  );
  assert.equal(slots[0].start, "2026-01-05T14:00:00.000Z", "09:00 EST is 14:00Z");
});

test("an invalid window returns nothing rather than throwing", () => {
  assert.deepEqual(computeSlots(input({ from: "2026-01-06T00:00:00Z", to: "2026-01-05T00:00:00Z" })), []);
  assert.deepEqual(computeSlots(input({ now: "not-a-date" })), []);
});
