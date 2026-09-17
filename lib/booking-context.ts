/**
 * The shared read path: token → event type → connection → availability.
 *
 * Both /api/availability and /api/bookings need exactly this. It lives in one module on
 * purpose: if the page computed slots one way and the write path another, the two would
 * eventually disagree and a prospect would be refused a time they were just offered. There
 * is one implementation, so that class of bug cannot exist.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { computeSlots, type Interval } from "./availability.ts";
import { hashToken, isWellFormedToken } from "./tokens.ts";
import type { BookingRefusal } from "./booking-checks.ts";
import { ConnectionNeedsReconsent, getFreeBusy } from "./google-calendar.ts";

/** Slot granularity. Not per-event-type yet; see SPEC.md §11. */
export const SLOT_INTERVAL_MIN = 15;

/** Bounds the work a public, unauthenticated request can cause. */
export const MAX_RANGE_DAYS = 62;
export const DEFAULT_RANGE_DAYS = 14;

export type BookingContext = {
  token: {
    id: string;
    eventTypeId: string;
    clientId: string;
    leadEmail: string;
    leadFirst: string | null;
    leadLast: string | null;
    leadCompany: string | null;
    campaignId: string | null;
    wave: string | null;
    sequenceStep: number | null;
    expiresAt: string;
    usedAt: string | null;
  };
  eventType: {
    id: string;
    clientId: string;
    connectionId: string;
    name: string;
    description: string | null;
    durationMin: number;
    bufferBeforeMin: number;
    bufferAfterMin: number;
    minNoticeMin: number;
    dateRangeDays: number;
    active: boolean;
  };
  connection: { id: string; refreshToken: string; email: string; status: string };
  /** The client the prospect was actually emailed by — the dominant name on the page. */
  client: { id: string; name: string };
};

export type ContextResult =
  | { ok: true; context: BookingContext }
  | { ok: false; reason: BookingRefusal };

export async function loadBookingContext(
  db: SupabaseClient,
  rawToken: unknown,
): Promise<ContextResult> {
  if (!isWellFormedToken(rawToken)) return { ok: false, reason: "token_malformed" };

  const { data: t, error } = await db
    .from("link_tokens")
    .select(
      "id, event_type_id, client_id, lead_email, lead_first, lead_last, lead_company, campaign_id, wave, sequence_step, expires_at, used_at",
    )
    .eq("token_hash", hashToken(rawToken))
    .maybeSingle();

  if (error) throw error;
  if (!t) return { ok: false, reason: "token_not_found" };

  const { data: et } = await db
    .from("event_types")
    .select(
      "id, client_id, connection_id, name, description, duration_min, buffer_before, buffer_after, min_notice_min, date_range_days, active",
    )
    .eq("id", t.event_type_id)
    .maybeSingle();

  if (!et) return { ok: false, reason: "event_mismatch" };
  if (et.client_id !== t.client_id) return { ok: false, reason: "event_mismatch" };
  if (!et.active) return { ok: false, reason: "event_inactive" };

  const { data: conn } = await db
    .from("connections")
    .select("id, refresh_token_enc, email, status")
    .eq("id", et.connection_id)
    .maybeSingle();

  if (!conn || conn.status !== "active") return { ok: false, reason: "event_inactive" };

  const { data: client } = await db
    .from("clients")
    .select("id, name, active")
    .eq("id", t.client_id)
    .maybeSingle();

  // A paused client must not keep taking bookings after their campaigns stop.
  if (!client || !client.active) return { ok: false, reason: "event_inactive" };

  return {
    ok: true,
    context: {
      client: { id: client.id, name: client.name },
      token: {
        id: t.id,
        eventTypeId: t.event_type_id,
        clientId: t.client_id,
        leadEmail: t.lead_email,
        leadFirst: t.lead_first,
        leadLast: t.lead_last,
        leadCompany: t.lead_company,
        campaignId: t.campaign_id,
        wave: t.wave,
        sequenceStep: t.sequence_step,
        expiresAt: t.expires_at,
        usedAt: t.used_at,
      },
      eventType: {
        id: et.id,
        clientId: et.client_id,
        connectionId: et.connection_id,
        name: et.name,
        description: et.description,
        durationMin: et.duration_min,
        bufferBeforeMin: et.buffer_before,
        bufferAfterMin: et.buffer_after,
        minNoticeMin: et.min_notice_min,
        dateRangeDays: et.date_range_days,
        active: et.active,
      },
      connection: {
        id: conn.id,
        refreshToken: conn.refresh_token_enc,
        email: conn.email,
        status: conn.status,
      },
    },
  };
}

export class CalendarUnavailable extends Error {
  // Declared and assigned rather than a TS parameter property: Node runs these files with
  // strip-only type removal, which cannot emit the implicit assignment a parameter property
  // needs. Keeping to strippable syntax is what lets `node --test` run the suite with no
  // build step and no extra tooling.
  readonly needsReconsent: boolean;

  constructor(needsReconsent: boolean) {
    super("calendar unavailable");
    this.name = "CalendarUnavailable";
    this.needsReconsent = needsReconsent;
  }
}

/**
 * Slots for a window. Busy time is Google's freebusy plus our own confirmed bookings —
 * both are needed, because a booking made seconds ago may not be on the calendar yet.
 */
export async function availabilityFor(
  db: SupabaseClient,
  ctx: BookingContext,
  fromIso: string,
  toIso: string,
  now: string,
): Promise<Interval[]> {
  const [{ data: rules }, { data: overrides }, { data: existing }] = await Promise.all([
    db
      .from("availability_rules")
      .select("weekday, start_local, end_local, timezone")
      .eq("connection_id", ctx.connection.id),
    db
      .from("availability_overrides")
      .select("on_date, kind, start_local, end_local, timezone")
      .eq("connection_id", ctx.connection.id),
    db
      .from("bookings")
      .select("start_utc, end_utc")
      .eq("connection_id", ctx.connection.id)
      .eq("status", "confirmed")
      .gte("start_utc", fromIso)
      .lte("end_utc", toIso),
  ]);

  let googleBusy: Interval[] = [];
  try {
    googleBusy = await getFreeBusy(
      { id: ctx.connection.id, refreshToken: ctx.connection.refreshToken },
      fromIso,
      toIso,
    );
  } catch (err) {
    if (err instanceof ConnectionNeedsReconsent) {
      await db
        .from("connections")
        .update({ status: "needs_reconsent", last_error: String(err.cause ?? err) })
        .eq("id", ctx.connection.id);
      throw new CalendarUnavailable(true);
    }
    // Never fall back to "no busy time". That would cheerfully double-book the client.
    throw new CalendarUnavailable(false);
  }

  const busy: Interval[] = [
    ...googleBusy,
    ...(existing ?? []).map((b) => ({ start: b.start_utc as string, end: b.end_utc as string })),
  ];

  return computeSlots({
    rules: (rules ?? []).map((r) => ({
      weekday: r.weekday as number,
      startLocal: r.start_local as string,
      endLocal: r.end_local as string,
      timezone: r.timezone as string,
    })),
    overrides: (overrides ?? []).map((o) => ({
      onDate: o.on_date as string,
      kind: o.kind as "block" | "open",
      startLocal: o.start_local as string | null,
      endLocal: o.end_local as string | null,
      timezone: o.timezone as string,
    })),
    busy,
    eventType: {
      durationMin: ctx.eventType.durationMin,
      bufferBeforeMin: ctx.eventType.bufferBeforeMin,
      bufferAfterMin: ctx.eventType.bufferAfterMin,
      minNoticeMin: ctx.eventType.minNoticeMin,
      dateRangeDays: ctx.eventType.dateRangeDays,
      slotIntervalMin: SLOT_INTERVAL_MIN,
    },
    from: fromIso,
    to: toIso,
    now,
  });
}

export type RangeResult =
  | { ok: true; from: string; to: string }
  | { ok: false; reason: "invalid_range" };

/**
 * Parse and clamp a requested window. Pure, so the clamping rules are testable without a
 * request object. The cap matters: this endpoint is public and each call costs a Google
 * round trip, so an unbounded range is free work for anyone who asks.
 */
export function resolveRange(fromRaw: string | null, toRaw: string | null, now: string): RangeResult {
  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) return { ok: false, reason: "invalid_range" };

  const from = fromRaw ? Date.parse(fromRaw) : nowMs;
  if (Number.isNaN(from)) return { ok: false, reason: "invalid_range" };

  const to = toRaw ? Date.parse(toRaw) : from + DEFAULT_RANGE_DAYS * 86_400_000;
  if (Number.isNaN(to)) return { ok: false, reason: "invalid_range" };
  if (to <= from) return { ok: false, reason: "invalid_range" };

  // Never look into the past: `now` is the floor regardless of what was asked for.
  const start = Math.max(from, nowMs);
  const end = Math.min(to, start + MAX_RANGE_DAYS * 86_400_000);
  if (end <= start) return { ok: false, reason: "invalid_range" };

  return { ok: true, from: new Date(start).toISOString(), to: new Date(end).toISOString() };
}
