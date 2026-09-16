/**
 * GET /api/availability?token=…&from=…&to=… — the read path the booking page calls.
 *
 * Public by necessity: a prospect's browser calls it holding only their link. It therefore
 * returns the minimum that renders a booking page and nothing more. In particular the
 * campaign id, wave and sequence step are NOT returned — that is internal attribution, and
 * a prospect has no reason to be handed the machinery that tracks them.
 *
 * Reads request data, so Next serves it dynamically; no cache directive is needed.
 */

import { serviceClient } from "@/lib/supabase";
import { publicRefusal } from "@/lib/booking-checks";
import {
  CalendarUnavailable,
  availabilityFor,
  loadBookingContext,
  resolveRange,
} from "@/lib/booking-context";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const now = new Date().toISOString();

  const range = resolveRange(url.searchParams.get("from"), url.searchParams.get("to"), now);
  if (!range.ok) {
    return Response.json({ error: "That date range could not be understood." }, { status: 400 });
  }

  const db = serviceClient();

  let loaded;
  try {
    loaded = await loadBookingContext(db, token);
  } catch (err) {
    console.error("[availability] context load failed", err);
    return Response.json({ error: "Something went wrong." }, { status: 500 });
  }

  if (!loaded.ok) {
    const { status, message } = publicRefusal(loaded.reason);
    console.warn(`[availability] refused: ${loaded.reason}`);
    return Response.json({ error: message, code: loaded.reason }, { status });
  }

  const { context } = loaded;

  // A spent or expired link renders the same terminal state as a missing one, so the page
  // never has to guess which of the three it is looking at.
  if (context.token.usedAt !== null || Date.parse(context.token.expiresAt) <= Date.parse(now)) {
    const reason = context.token.usedAt !== null ? "token_used" : "token_expired";
    const { status, message } = publicRefusal(reason);
    return Response.json({ error: message, code: reason }, { status });
  }

  let slots;
  try {
    slots = await availabilityFor(db, context, range.from, range.to, now);
  } catch (err) {
    if (err instanceof CalendarUnavailable) {
      console.error("[availability] calendar unavailable", context.connection.id, err.needsReconsent);
      return Response.json({ error: "This calendar is temporarily unavailable." }, { status: 503 });
    }
    console.error("[availability] failed", err);
    return Response.json({ error: "Something went wrong." }, { status: 500 });
  }

  return Response.json({
    event: {
      name: context.eventType.name,
      description: context.eventType.description,
      durationMin: context.eventType.durationMin,
    },
    host: { email: context.connection.email },
    // Echoed so the confirm step can be pre-filled. The prospect already knows all of this
    // about themselves; nothing here is new information to them.
    lead: {
      first: context.token.leadFirst,
      last: context.token.leadLast,
      company: context.token.leadCompany,
      email: context.token.leadEmail,
    },
    range: { from: range.from, to: range.to },
    slots,
  });
}
