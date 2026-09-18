/**
 * POST /api/manage/cancel — an attendee cancels their own booking.
 *
 * Order matters and is the mirror of the booking path. The row is marked cancelled FIRST,
 * then the calendar event is removed. If the calendar call fails, the booking is still
 * cancelled and reconcile.py sees an event that should not exist — recoverable. The other
 * order would delete the meeting from the client's calendar while our record still claimed
 * the call was happening, which is the version nobody notices until the client sits waiting.
 */

import { serviceClient } from "@/lib/supabase";
import { loadBookingById } from "@/lib/booking-context";
import { canManage, manageRefusalMessage, readManageToken } from "@/lib/manage";
import { deleteEvent } from "@/lib/google-calendar";

export async function POST(request: Request) {
  let body: { token?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "This link is not valid." }, { status: 400 });
  }

  const claims = readManageToken(body.token ?? null);
  if (!claims) {
    return Response.json({ error: "This link is not valid." }, { status: 404 });
  }

  const db = serviceClient();
  const booking = await loadBookingById(db, claims.bookingId);
  const now = new Date().toISOString();

  const allowed = canManage(booking && { status: booking.status, startUtc: booking.startUtc }, now);
  if (!allowed.ok) {
    const { status, message } = manageRefusalMessage(allowed.reason);
    return Response.json({ error: message, code: allowed.reason }, { status });
  }

  // .select() so a zero-row update is visible: a bare PATCH returns 204 with error === null
  // whether it changed a row or not, so without this the endpoint cannot tell "I cancelled
  // it" from "nothing happened" — and a genuine failure would report success.
  const { data: cancelled, error } = await db
    .from("bookings")
    .update({ status: "cancelled", cancelled_at: now })
    .eq("id", booking!.id)
    .eq("status", "confirmed")
    .select("id")
    .maybeSingle();

  if (!error && !cancelled) {
    const { status, message } = manageRefusalMessage("already_cancelled");
    return Response.json({ error: message, code: "already_cancelled" }, { status });
  }

  if (error) {
    console.error("[manage] cancel update failed", error);
    return Response.json({ error: "Something went wrong." }, { status: 500 });
  }

  if (booking!.googleEventId) {
    try {
      await deleteEvent(booking!.connection, booking!.googleEventId);
      await db.from("bookings").update({ google_event_id: null }).eq("id", booking!.id);
    } catch (err) {
      // Deliberately not fatal — the cancellation stands, and reconcile.py reports the
      // orphaned event rather than this endpoint failing a user action it already completed.
      console.error("[manage] calendar delete failed after cancel", booking!.id, err);
    }
  }

  return Response.json({ ok: true, status: "cancelled" });
}
