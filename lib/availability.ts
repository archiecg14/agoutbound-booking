/**
 * Slot computation. Pure functions, no I/O, no clock access — `now` is always injected so
 * every branch below is testable and nothing depends on when the suite runs.
 *
 * The model, and why it is shaped this way:
 *
 *   - Recurring rules are WALL-CLOCK time plus an IANA zone. "I work 09:00–17:00" has to
 *     stay 09:00 across a daylight-saving change, so the UTC instants are recomputed per
 *     date rather than once. This is the single most common way scheduling tools produce
 *     wrong-hour bookings.
 *   - Busy intervals are UTC instants, because that is what Google freebusy returns and
 *     what a confirmed booking is.
 *   - Output is UTC instants. Rendering into the attendee's zone is the caller's job, and
 *     the attendee's zone is never assumed — see SPEC.md §5.
 *
 * Buffers guard against ADJACENT MEETINGS, not against the edge of working hours. A slot
 * may start exactly at 09:00 with a 15-minute buffer; it may not start 10 minutes after a
 * call ends.
 */

import { DateTime } from "luxon";

export type AvailabilityRule = {
  /** 0 = Sunday … 6 = Saturday, matching the weekday check constraint in 0001_init.sql */
  weekday: number;
  /** "09:00" — wall clock in `timezone` */
  startLocal: string;
  endLocal: string;
  /** IANA zone, e.g. "Europe/London" */
  timezone: string;
};

export type AvailabilityOverride = {
  /** "2026-12-25" */
  onDate: string;
  kind: "block" | "open";
  /** null on a whole-day block */
  startLocal?: string | null;
  endLocal?: string | null;
  timezone: string;
};

/** A half-open interval [start, end) of UTC ISO instants. */
export type Interval = { start: string; end: string };

export type EventTypeConfig = {
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  /** Nothing bookable sooner than this from `now`. */
  minNoticeMin: number;
  /** Nothing bookable further out than this from `now`. */
  dateRangeDays: number;
  /** Candidate starts step by this, aligned to the start of each open block. */
  slotIntervalMin: number;
};

export type ComputeSlotsInput = {
  rules: AvailabilityRule[];
  overrides: AvailabilityOverride[];
  /** Google freebusy plus confirmed bookings. UTC. */
  busy: Interval[];
  eventType: EventTypeConfig;
  /** Requested window, UTC ISO. */
  from: string;
  to: string;
  /** Injected. Never call Date.now() in this module. */
  now: string;
};

type Span = { start: number; end: number };

const MIN = 60_000;

// ── interval algebra ────────────────────────────────────────────────────────

function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Merge overlapping and touching spans into a normalised, sorted set. */
function union(spans: Span[]): Span[] {
  const sorted = [...spans].filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) {
      last.end = Math.max(last.end, s.end);
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

/** base minus cuts. Both are normalised first; result stays sorted and disjoint. */
function subtract(base: Span[], cuts: Span[]): Span[] {
  const cutSet = union(cuts);
  let out = union(base);
  for (const cut of cutSet) {
    const next: Span[] = [];
    for (const s of out) {
      if (!overlaps(s, cut)) {
        next.push(s);
        continue;
      }
      if (s.start < cut.start) next.push({ start: s.start, end: cut.start });
      if (cut.end < s.end) next.push({ start: cut.end, end: s.end });
    }
    out = next;
  }
  return out;
}

// ── wall clock → instants ───────────────────────────────────────────────────

/**
 * Resolve a local date + wall-clock time in `zone` to a UTC millisecond instant.
 *
 * Returns null for a time that cannot exist — luxon reports invalid for a malformed zone or
 * time. On a spring-forward gap luxon shifts the instant forward (01:30 becomes 02:30 at the
 * London transition) rather than failing; we accept that deliberately. Shifting an hour is a
 * visible, reasonable outcome; silently dropping a working day is not.
 */
function instantOf(dateISO: string, timeLocal: string, zone: string): number | null {
  const dt = DateTime.fromISO(`${dateISO}T${timeLocal}`, { zone });
  return dt.isValid ? dt.toMillis() : null;
}

/** Local dates in `zone` covering the window, padded a day each side for offset edges. */
function localDatesSpanning(window: Span, zone: string): string[] {
  const first = DateTime.fromMillis(window.start, { zone }).minus({ days: 1 }).startOf("day");
  const last = DateTime.fromMillis(window.end, { zone }).plus({ days: 1 }).startOf("day");
  if (!first.isValid || !last.isValid) return [];

  const dates: string[] = [];
  for (let d = first; d <= last; d = d.plus({ days: 1 })) {
    dates.push(d.toISODate()!);
  }
  return dates;
}

// ── the computation ─────────────────────────────────────────────────────────

export function computeSlots(input: ComputeSlotsInput): Interval[] {
  const { rules, overrides, busy, eventType: et } = input;

  if (et.durationMin <= 0 || et.slotIntervalMin <= 0) return [];

  const now = DateTime.fromISO(input.now, { zone: "utc" });
  const from = DateTime.fromISO(input.from, { zone: "utc" });
  const to = DateTime.fromISO(input.to, { zone: "utc" });
  if (!now.isValid || !from.isValid || !to.isValid) return [];

  // The bookable window is the requested window intersected with the notice floor and the
  // date-range ceiling. Both are measured from `now`, not from `from`.
  const window: Span = {
    start: Math.max(from.toMillis(), now.toMillis() + et.minNoticeMin * MIN),
    end: Math.min(to.toMillis(), now.plus({ days: et.dateRangeDays }).toMillis()),
  };
  if (window.end <= window.start) return [];

  // 1. Open time from recurring rules, recomputed per local date so DST is handled.
  const open: Span[] = [];
  for (const rule of rules) {
    for (const date of localDatesSpanning(window, rule.timezone)) {
      const day = DateTime.fromISO(date, { zone: rule.timezone });
      if (!day.isValid) continue;
      // luxon: Monday = 1 … Sunday = 7. Our schema: Sunday = 0 … Saturday = 6.
      if (day.weekday % 7 !== rule.weekday) continue;

      const start = instantOf(date, rule.startLocal, rule.timezone);
      const end = instantOf(date, rule.endLocal, rule.timezone);
      if (start === null || end === null || end <= start) continue;
      open.push({ start, end });
    }
  }

  // 2. Overrides. 'open' adds time (a one-off Saturday); 'block' removes it.
  const blocks: Span[] = [];
  for (const o of overrides) {
    const whole = !o.startLocal || !o.endLocal;

    if (whole) {
      // A whole-day block covers that calendar day in its own zone — which is 23, 24 or 25
      // hours long depending on the transition, so it is computed, not assumed to be 24.
      const day = DateTime.fromISO(o.onDate, { zone: o.timezone });
      if (!day.isValid) continue;
      const start = day.startOf("day").toMillis();
      const end = day.plus({ days: 1 }).startOf("day").toMillis();
      if (o.kind === "block") blocks.push({ start, end });
      continue; // a whole-day 'open' is meaningless without hours; ignore rather than guess
    }

    const start = instantOf(o.onDate, o.startLocal!, o.timezone);
    const end = instantOf(o.onDate, o.endLocal!, o.timezone);
    if (start === null || end === null || end <= start) continue;
    (o.kind === "open" ? open : blocks).push({ start, end });
  }

  // Deliberately NOT clipped to the window. Slot starts are anchored to the start of the
  // working block, so a 09:00–17:00 day always offers 09:00, 09:30, 10:00 … Clipping first
  // would re-anchor the grid to whatever the notice floor happens to be and offer times like
  // 11:05, which reads as broken. The window is applied per-candidate in the walk instead.
  const bookable = subtract(union(open), blocks);
  if (bookable.length === 0) return [];

  // 3. Busy spans, from freebusy and confirmed bookings.
  const busySpans: Span[] = busy
    .map((b) => ({
      start: DateTime.fromISO(b.start, { zone: "utc" }).toMillis(),
      end: DateTime.fromISO(b.end, { zone: "utc" }).toMillis(),
    }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start);

  // 4. Walk each open block, emitting slots that fit whole and whose buffered extent is clear.
  const duration = et.durationMin * MIN;
  const step = et.slotIntervalMin * MIN;
  const before = et.bufferBeforeMin * MIN;
  const after = et.bufferAfterMin * MIN;

  const slots: Interval[] = [];
  for (const block of bookable) {
    for (let s = block.start; s + duration <= block.end; s += step) {
      // The window is applied here, per candidate, so the grid stays anchored to the block.
      if (s < window.start || s + duration > window.end) continue;
      const guarded: Span = { start: s - before, end: s + duration + after };
      if (busySpans.some((b) => overlaps(guarded, b))) continue;
      slots.push({
        start: new Date(s).toISOString(),
        end: new Date(s + duration).toISOString(),
      });
    }
  }

  // Two rules can legitimately produce the same instant; the caller must never see it twice.
  const seen = new Set<string>();
  return slots
    .filter((s) => (seen.has(s.start) ? false : (seen.add(s.start), true)))
    .sort((a, b) => a.start.localeCompare(b.start));
}
