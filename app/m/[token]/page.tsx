import "../../b/booking.css";
import { serviceClient } from "@/lib/supabase";
import {
  CalendarUnavailable,
  DEFAULT_RANGE_DAYS,
  availabilityFor,
  loadBookingById,
} from "@/lib/booking-context";
import { canManage, readManageToken } from "@/lib/manage";
import { DeadLink } from "../../b/[token]/ui";
import { ManageFlow } from "./ui";

/**
 * Where an attendee lands from the link in their calendar invite. Alternative times are
 * loaded here rather than on demand, so the reschedule option is a single tap away — the
 * whole point is to make moving a call easier than silently not turning up.
 */

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="shell">
      {children}
      <footer className="chrome">Scheduling by AG Outbound</footer>
    </main>
  );
}

export default async function Page(props: PageProps<"/m/[token]">) {
  const { token } = await props.params;
  const claims = readManageToken(token);
  const now = new Date().toISOString();

  if (!claims) {
    return (
      <Shell>
        <DeadLink
          title="This link is not valid"
          body="It may have expired. Reply to the original email and we'll sort it out."
        />
      </Shell>
    );
  }

  const db = serviceClient();
  const booking = await loadBookingById(db, claims.bookingId);
  const allowed = canManage(booking && { status: booking.status, startUtc: booking.startUtc }, now);

  if (!allowed.ok || !booking) {
    const body =
      allowed.ok === false && allowed.reason === "already_cancelled"
        ? "This booking has already been cancelled."
        : "This booking can no longer be changed. Reply to the original email if you need to.";
    return (
      <Shell>
        <DeadLink title="Nothing to change" body={body} />
      </Shell>
    );
  }

  // Alternatives, with this booking's own slot excluded so its buffers do not hide the
  // times either side of it.
  let slots: { start: string; end: string }[] = [];
  try {
    slots = await availabilityFor(
      db,
      booking,
      now,
      new Date(Date.parse(now) + DEFAULT_RANGE_DAYS * 86_400_000).toISOString(),
      now,
      { start: booking.startUtc, end: booking.endUtc },
    );
  } catch (err) {
    // A calendar we cannot read must not block a cancellation — that is the action most
    // likely to be urgent. The page renders with no alternatives instead.
    if (!(err instanceof CalendarUnavailable)) throw err;
    console.error("[m] calendar unavailable, rendering cancel-only", booking.id);
  }

  return (
    <Shell>
      <header className="identity">
        <div className="identity__client">{booking.clientName}</div>
        <div className="identity__event">
          {booking.eventName} · {booking.eventType.durationMin} minutes
        </div>
        <hr className="identity__rule" />
      </header>
      <ManageFlow
        token={token}
        clientName={booking.clientName}
        start={booking.startUtc}
        end={booking.endUtc}
        tz={booking.attendeeTz || "UTC"}
        slots={slots.slice(0, 24)}
      />
    </Shell>
  );
}
