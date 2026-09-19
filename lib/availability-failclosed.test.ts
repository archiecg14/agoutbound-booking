import test from "node:test";
import assert from "node:assert/strict";
import { availabilityFor, CalendarUnavailable } from "./booking-context.ts";

/**
 * Guards the fail-closed rule for the three queries availability is built from.
 *
 * Each of them once discarded its error, and an empty result lies in a different direction:
 * no bookings means offering slots already taken, no overrides means offering a day the
 * client closed, no rules means claiming there is no availability at all. A review found
 * the overrides case still open after the bookings case had been fixed, which is exactly
 * the kind of asymmetry a test is for.
 */

const ctx = {
  connection: { id: "conn-1", refreshToken: "rt" },
  eventType: {
    durationMin: 15, bufferBeforeMin: 0, bufferAfterMin: 15,
    minNoticeMin: 60, dateRangeDays: 7, slotIntervalMin: 15,
  },
};

/** A supabase-shaped stub where exactly one table's query fails. */
function dbWhere(failing: string | null) {
  const result = (table: string) =>
    Promise.resolve(
      table === failing
        ? { data: null, error: { message: `${table} exploded` } }
        : { data: [], error: null },
    );

  return {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "lt", "gt", "order", "limit"]) {
        chain[m] = () => chain;
      }
      chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        result(table).then(res, rej);
      return chain;
    },
  } as never;
}

const WINDOW = ["2026-09-21T00:00:00.000Z", "2026-09-28T00:00:00.000Z", "2026-09-21T00:00:00.000Z"] as const;

/**
 * Run availabilityFor and report WHICH guard rejected it.
 *
 * This matters more than it looks. The Google call that follows the database reads throws
 * CalendarUnavailable too, so "it threw CalendarUnavailable" proves nothing on its own - a
 * first version of this test passed with the guard removed. The database guard is the only
 * one that logs this line, so the log is what separates the two.
 */
async function rejectedBy(db: never): Promise<"database" | "calendar" | "nothing"> {
  const real = console.error;
  let sawDatabaseGuard = false;
  console.error = (...args: unknown[]) => {
    if (String(args[0]).includes("refusing to guess")) sawDatabaseGuard = true;
  };
  try {
    await availabilityFor(db, ctx, ...WINDOW);
    return "nothing";
  } catch {
    return sawDatabaseGuard ? "database" : "calendar";
  } finally {
    console.error = real;
  }
}

for (const table of ["bookings", "availability_overrides", "availability_rules"]) {
  test(`a failing ${table} query refuses rather than guessing`, async () => {
    assert.equal(
      await rejectedBy(dbWhere(table)),
      "database",
      `${table} failing must be caught by the database guard, before any answer is built`,
    );
  });
}

test("known-good: a healthy database gets PAST the guard", async () => {
  // The negative half of the proof. Without it, the three tests above would pass even with
  // the guard deleted, because the calendar call rejects too. This asserts the guard does
  // not fire when nothing is wrong, so "database" above means the guard and only the guard.
  assert.equal(
    await rejectedBy(dbWhere(null)),
    "calendar",
    "with every query healthy, the rejection must come from the calendar, not the guard",
  );
});
