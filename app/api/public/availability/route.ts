/**
 * GET /api/public/availability?client=&event=&from=&to=
 *
 * The tokenless read. Same slot engine as every other path — one implementation means the
 * public page cannot offer a time the write path would refuse.
 */

import { serviceClient } from "@/lib/supabase";
import {
  CalendarUnavailable,
  availabilityFor,
  loadPublicContext,
  resolveRange,
} from "@/lib/booking-context";

/**
 * A short cache in front of the Google call.
 *
 * This endpoint is unauthenticated and each miss costs a freeBusy request against the
 * project's quota, so a loop against it could exhaust that quota and take the real booking
 * page down with a 503 — a denial of service needing no credentials at all.
 *
 * Honest about what this is: per-process and lost on restart, so it bounds cost rather than
 * enforcing a limit. Thirty seconds is short enough to stay useful, and the write path never
 * trusts it — /api/public/bookings always recomputes availability before inserting.
 */
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { at: number; body: unknown }>();

function cacheGet(key: string): unknown | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.body;
}

function cacheSet(key: string, body: unknown) {
  // Bounded, so a flood of distinct ranges cannot grow it without limit.
  if (cache.size > 500) cache.clear();
  cache.set(key, { at: Date.now(), body });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const client = url.searchParams.get("client");
  const event = url.searchParams.get("event");
  const now = new Date().toISOString();

  if (!client || !event) {
    return Response.json({ error: "This booking page is not available." }, { status: 404 });
  }

  const range = resolveRange(url.searchParams.get("from"), url.searchParams.get("to"), now);
  if (!range.ok) {
    return Response.json({ error: "That date range could not be understood." }, { status: 400 });
  }

  const key = `${client}|${event}|${range.from}|${range.to}`;
  const cached = cacheGet(key);
  if (cached) return Response.json(cached);

  const db = serviceClient();
  const loaded = await loadPublicContext(db, client, event);
  if (!loaded.ok) {
    return Response.json({ error: "This booking page is not available." }, { status: 404 });
  }

  let slots;
  try {
    slots = await availabilityFor(db, loaded.context, range.from, range.to, now);
  } catch (err) {
    if (err instanceof CalendarUnavailable) {
      return Response.json({ error: "This calendar is temporarily unavailable." }, { status: 503 });
    }
    console.error("[public/availability] failed", err);
    return Response.json({ error: "Something went wrong." }, { status: 500 });
  }

  const payload = {
    client: { name: loaded.context.client.name },
    event: {
      name: loaded.context.eventType.name,
      description: loaded.context.eventType.description,
      durationMin: loaded.context.eventType.durationMin,
    },
    slots,
  };

  cacheSet(key, payload);
  return Response.json(payload);
}
