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

  return Response.json({
    client: { name: loaded.context.client.name },
    event: {
      name: loaded.context.eventType.name,
      description: loaded.context.eventType.description,
      durationMin: loaded.context.eventType.durationMin,
    },
    slots,
  });
}
