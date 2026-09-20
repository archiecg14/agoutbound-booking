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
import { decryptSecret, isEncrypted } from "./crypto.ts";
import { hashToken, isWellFormedToken } from "./tokens.ts";
import type { BookingRefusal } from "./booking-checks.ts";
import { ConnectionNeedsReconsent, getFreeBusy } from "./google-calendar.ts";

/** Fallback granularity when an event type does not specify one. */
export const DEFAULT_SLOT_INTERVAL_MIN = 15;

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
    slotIntervalMin: number;
    active: boolean;
  };
  connection: { id: string; refreshToken: string; email: string; status: string };
  /** The client the prospect was actually emailed by — the dominant name on the page. */
  client: { id: string; name: string; fallbackUrl: string | null };
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
      "id, client_id, connection_id, name, description, duration_min, buffer_before, buffer_after, min_notice_min, date_range_days, slot_interval_min, active",
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
    .select("id, name, active, fallback_url")
    .eq("id", t.client_id)
    .maybeSingle();

  // A paused client must not keep taking bookings after their campaigns stop.
  if (!client || !client.active) return { ok: false, reason: "event_inactive" };

  return {
    ok: true,
    context: {
      client: { id: client.id, name: client.name, fallbackUrl: client.fallback_url ?? null },
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
        slotIntervalMin: et.slot_interval_min ?? DEFAULT_SLOT_INTERVAL_MIN,
        active: et.active,
      },
      connection: {
        id: conn.id,
        // Decrypted once, here, so nothing downstream has to remember to. A row written
        // before lib/crypto.ts existed is plaintext; it is used as-is and shouted about
        // rather than failing a live booking, and reconnecting the account fixes it.
        refreshToken: isEncrypted(conn.refresh_token_enc)
          ? decryptSecret(conn.refresh_token_enc)
          : (console.warn(`[context] connection ${conn.id} holds an unencrypted refresh token`),
            conn.refresh_token_enc),
        email: conn.email,
        status: conn.status,
      },
    },
  };
}

/**
 * Resolve a public booking page by slugs. No token involved.
 *
 * is_public is checked here rather than at the route, so every caller gets the same answer.
 * An event type built for per-lead outreach must never become bookable by a stranger just
 * because someone guessed its slug.
 */
export async function loadPublicContext(
  db: SupabaseClient,
  clientSlug: string,
  eventSlug: string,
): Promise<
  | { ok: true; context: Omit<BookingContext, "token"> }
  | { ok: false; reason: "not_found" | "not_public" }
> {
  const { data: client } = await db
    .from("clients")
    .select("id, name, active, fallback_url")
    .eq("slug", clientSlug)
    .maybeSingle();
  if (!client || !client.active) return { ok: false, reason: "not_found" };

  const { data: et } = await db
    .from("event_types")
    .select(
      "id, client_id, connection_id, name, description, duration_min, buffer_before, buffer_after, min_notice_min, date_range_days, slot_interval_min, active, is_public",
    )
    .eq("client_id", client.id)
    .eq("slug", eventSlug)
    .maybeSingle();

  if (!et || !et.active) return { ok: false, reason: "not_found" };
  // Opt in, never opt out. Same answer to "no such page" and "not public": a stranger
  // probing slugs learns nothing either way.
  if (!et.is_public) return { ok: false, reason: "not_public" };

  const { data: conn } = await db
    .from("connections")
    .select("id, refresh_token_enc, email, status")
    .eq("id", et.connection_id)
    .maybeSingle();
  if (!conn || conn.status !== "active") return { ok: false, reason: "not_found" };

  return {
    ok: true,
    context: {
      client: { id: client.id, name: client.name, fallbackUrl: client.fallback_url ?? null },
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
        slotIntervalMin: et.slot_interval_min ?? DEFAULT_SLOT_INTERVAL_MIN,
        active: et.active,
      },
      connection: {
        id: conn.id,
        refreshToken: isEncrypted(conn.refresh_token_enc)
          ? decryptSecret(conn.refresh_token_enc)
          : conn.refresh_token_enc,
        email: conn.email,
        status: conn.status,
      },
    },
  };
}

export type ManagedBooking = {
  id: string;
  clientId: string;
  eventTypeId: string;
  status: string;
  startUtc: string;
  endUtc: string;
  googleEventId: string | null;
  attendeeEmail: string;
  attendeeTz: string;
  clientName: string;
  eventName: string;
  eventType: {
    durationMin: number;
    bufferBeforeMin: number;
    bufferAfterMin: number;
    minNoticeMin: number;
    dateRangeDays: number;
    slotIntervalMin: number;
  };
  connection: { id: string; refreshToken: string };
};

/** Load one booking and everything needed to move or cancel it. */
export async function loadBookingById(
  db: SupabaseClient,
  bookingId: string,
): Promise<ManagedBooking | null> {
  const { data: b } = await db
    .from("bookings")
    .select(
      "id, client_id, event_type_id, connection_id, status, start_utc, end_utc, google_event_id, attendee_email, attendee_tz",
    )
    .eq("id", bookingId)
    .maybeSingle();
  if (!b) return null;

  const [{ data: conn }, { data: client }, { data: et }] = await Promise.all([
    db.from("connections").select("id, refresh_token_enc, status").eq("id", b.connection_id).maybeSingle(),
    db.from("clients").select("name").eq("id", b.client_id).maybeSingle(),
    db.from("event_types").select("name, duration_min, buffer_before, buffer_after, min_notice_min, date_range_days, slot_interval_min").eq("id", b.event_type_id).maybeSingle(),
  ]);
  if (!conn) return null;

  return {
    id: b.id,
    clientId: b.client_id,
    eventTypeId: b.event_type_id,
    status: b.status,
    startUtc: b.start_utc,
    endUtc: b.end_utc,
    googleEventId: b.google_event_id,
    attendeeEmail: b.attendee_email,
    attendeeTz: b.attendee_tz,
    clientName: client?.name ?? "",
    eventName: et?.name ?? "",
    eventType: {
      durationMin: et?.duration_min ?? 30,
      bufferBeforeMin: et?.buffer_before ?? 0,
      bufferAfterMin: et?.buffer_after ?? 0,
      minNoticeMin: et?.min_notice_min ?? 0,
      dateRangeDays: et?.date_range_days ?? 30,
      slotIntervalMin: et?.slot_interval_min ?? DEFAULT_SLOT_INTERVAL_MIN,
    },
    connection: {
      id: conn.id,
      refreshToken: isEncrypted(conn.refresh_token_enc)
        ? decryptSecret(conn.refresh_token_enc)
        : conn.refresh_token_enc,
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
 * Slots for a window. Busy time is Google's freebusy, our own confirmed bookings, and any
 * public hold still waiting on its confirmation email. All three are needed: a booking made
 * seconds ago may not be on the calendar yet, and a hold is not on the calendar at all.
 */
/** The minimum availabilityFor needs. BookingContext satisfies it structurally, and so
 *  does a booking being rescheduled — which has no link token to load a context from. */
export type AvailabilityInput = {
  connection: { id: string; refreshToken: string };
  eventType: {
    durationMin: number;
    bufferBeforeMin: number;
    bufferAfterMin: number;
    minNoticeMin: number;
    dateRangeDays: number;
    slotIntervalMin?: number;
  };
};

export async function availabilityFor(
  db: SupabaseClient,
  ctx: AvailabilityInput,
  fromIso: string,
  toIso: string,
  now: string,
  /**
   * A booking being rescheduled must not be blocked by its own existing slot. Both our row
   * and the Google event occupy that window, so without this an attendee moving a call by
   * fifteen minutes can be refused by the buffer around the meeting they are moving.
   */
  excludeInterval?: Interval,
): Promise<Interval[]> {
  const [
    { data: rules, error: rulesErr },
    { data: overrides, error: overridesErr },
    { data: existing, error: existingErr },
  ] = await Promise.all([
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
      .select("start_utc, end_utc, status, confirm_expires_at")
      .eq("connection_id", ctx.connection.id)
      // Unconfirmed public holds count as busy too, or two people picking the same time in
      // the same minute would both be sent a confirmation link and one of them would be
      // turned away after committing to it. Expiry is applied below rather than in the
      // query, so it is filtered by one clock — this function's `now` — and can be tested.
      .in("status", ["confirmed", "pending"])
      // Overlap, not containment. The original (start >= from AND end <= to) missed any
      // booking straddling the window edge, so a booking running 09:45-10:15 was invisible
      // to a window starting at 10:00 and its slot was offered again.
      .lt("start_utc", toIso)
      .gt("end_utc", fromIso),
  ]);

  // All three fail CLOSED, exactly as the Google call below does. Each of them used to
  // discard its error, and an empty result is a lie in a different direction for each:
  //
  //   existing  — no busy time, so slots the client is already booked for are offered
  //   overrides — no blocks, so a day the client deliberately closed becomes bookable
  //   rules     — no working hours, so the page says "No times available" as though that
  //               were true, and a prospect from a live campaign leaves
  //
  // The first was fixed on its own and left the other two asymmetric, which is how the
  // overrides case survived. There is no version of this function where guessing is better
  // than refusing, so none of the three guesses now.
  const queryErr = existingErr ?? overridesErr ?? rulesErr;
  if (queryErr) {
    console.error("[availability] could not read availability; refusing to guess", queryErr);
    throw new CalendarUnavailable(false);
  }

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

  // A hold blocks its slot until it expires, then stops mattering — no sweeper, nothing to
  // clean up, and no cron job whose silent failure would freeze a calendar behind holds
  // nobody can see. An expired row simply stops being counted here.
  const nowMs = Date.parse(now);
  const blocking = (existing ?? []).filter((b) => {
    if (b.status !== "pending") return true;
    const exp = Date.parse((b.confirm_expires_at as string | null) ?? "");
    return !Number.isNaN(exp) && exp > nowMs;
  });

  let busy: Interval[] = [
    ...googleBusy,
    ...blocking.map((b) => ({ start: b.start_utc as string, end: b.end_utc as string })),
  ];

  if (excludeInterval) {
    // Matched on the exact window, since freebusy returns no event ids to match on. Two
    // genuinely distinct meetings occupying the identical window is indistinguishable here,
    // but that is already a double-booking and is reconcile.py's problem, not this one's.
    const ex = { s: Date.parse(excludeInterval.start), e: Date.parse(excludeInterval.end) };
    busy = busy.filter((b) => !(Date.parse(b.start) === ex.s && Date.parse(b.end) === ex.e));
  }

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
      slotIntervalMin: ctx.eventType.slotIntervalMin ?? DEFAULT_SLOT_INTERVAL_MIN,
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
