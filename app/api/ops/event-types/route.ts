/**
 * POST /api/ops/event-types — create or update an event type.
 *
 * Guarded by the operator session. Nothing can be booked until an event type exists, so
 * this is the one mutation that turns a connected calendar into a working booking link.
 */

import { cookies } from "next/headers";
import { serviceClient } from "@/lib/supabase";
import { OPS_COOKIE, isOperator } from "@/lib/operator-auth";

const SLUG = /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/;

export async function POST(request: Request) {
  const jar = await cookies();
  if (!isOperator(jar.get(OPS_COOKIE)?.value)) {
    return Response.json({ error: "unauthorised" }, { status: 401 });
  }

  let b: Record<string, unknown>;
  try {
    b = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  const clientId = typeof b.clientId === "string" ? b.clientId : null;
  const connectionId = typeof b.connectionId === "string" ? b.connectionId : null;
  const slug = typeof b.slug === "string" ? b.slug.trim().toLowerCase() : "";
  const name = typeof b.name === "string" ? b.name.trim() : "";
  const durationMin = Number(b.durationMin);

  if (!clientId || !connectionId) return Response.json({ error: "client_and_connection_required" }, { status: 400 });
  // The slug is part of a URL people paste around; loose input here becomes a broken link
  // nobody can debug later.
  if (!SLUG.test(slug)) return Response.json({ error: "invalid_slug" }, { status: 400 });
  if (!name) return Response.json({ error: "name_required" }, { status: 400 });
  if (!Number.isInteger(durationMin) || durationMin < 5 || durationMin > 480) {
    return Response.json({ error: "invalid_duration" }, { status: 400 });
  }

  const row = {
    client_id: clientId,
    connection_id: connectionId,
    slug,
    name,
    description: typeof b.description === "string" ? b.description.trim() || null : null,
    duration_min: durationMin,
    buffer_before: Number.isInteger(Number(b.bufferBefore)) ? Number(b.bufferBefore) : 0,
    buffer_after: Number.isInteger(Number(b.bufferAfter)) ? Number(b.bufferAfter) : 0,
    min_notice_min: Number.isInteger(Number(b.minNoticeMin)) ? Number(b.minNoticeMin) : 60,
    date_range_days: Number.isInteger(Number(b.dateRangeDays)) ? Number(b.dateRangeDays) : 30,
    // Spacing between offered start times. A long call offering a start every quarter hour
    // gives the prospect a wall of near-identical options, which is harder to choose from.
    slot_interval_min:
      Number.isInteger(Number(b.slotIntervalMin)) &&
      Number(b.slotIntervalMin) >= 5 &&
      Number(b.slotIntervalMin) <= 120
        ? Number(b.slotIntervalMin)
        : 15,
    active: b.active !== false,
  };

  // Upsert on (client_id, slug), matching the unique constraint, so editing an event type
  // does not silently create a second one competing for the same URL.
  const { data, error } = await serviceClient()
    .from("event_types")
    .upsert(row, { onConflict: "client_id,slug" })
    .select("id, slug, name")
    .single();

  if (error) {
    console.error("[ops] event type upsert failed", error);
    return Response.json({ error: "write_failed" }, { status: 500 });
  }
  return Response.json({ ok: true, eventType: data });
}
