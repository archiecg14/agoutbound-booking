import "../booking.css";
import { serviceClient } from "@/lib/supabase";
import {
  CalendarUnavailable,
  DEFAULT_RANGE_DAYS,
  availabilityFor,
  loadBookingContext,
} from "@/lib/booking-context";
import { BookingFlow, DeadLink, Identity } from "./ui";

/**
 * The booking page. Server-rendered so the first paint already carries real times — a
 * client-side fetch would show an empty skeleton to someone who arrived from an email and
 * has no patience for one.
 *
 * Every failure resolves to a calm terminal state. There is no path here that shows a
 * prospect a stack trace or an empty page.
 */

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="shell">
      {children}
      <footer className="chrome">Scheduling by AG Outbound</footer>
    </main>
  );
}

export default async function Page(props: PageProps<"/b/[token]">) {
  const { token } = await props.params;
  const now = new Date().toISOString();

  let loaded;
  try {
    loaded = await loadBookingContext(serviceClient(), token);
  } catch (err) {
    console.error("[b] context load failed", err);
    return (
      <Shell>
        <DeadLink
          title="Something went wrong"
          body="We couldn't load this booking page. Please try again in a moment."
        />
      </Shell>
    );
  }

  // Missing, expired and spent links all render the same thing. The prospect does not need
  // to know which, and telling them would let anyone probe for valid links.
  if (!loaded.ok) {
    return (
      <Shell>
        <DeadLink
          title="This link is no longer valid"
          body="It may have expired or already been used. Reply to the email and we'll send a fresh one."
        />
      </Shell>
    );
  }

  const { context } = loaded;

  if (context.token.usedAt !== null || Date.parse(context.token.expiresAt) <= Date.parse(now)) {
    return (
      <Shell>
        <Identity client={context.client} event={context.eventType} />
        <DeadLink
          title="This link has already been used"
          body="If you need to change the booking, reply to the email and we'll sort it out."
        />
      </Shell>
    );
  }

  const to = new Date(Date.parse(now) + DEFAULT_RANGE_DAYS * 86_400_000).toISOString();

  let slots;
  try {
    slots = await availabilityFor(serviceClient(), context, now, to, now);
  } catch (err) {
    if (err instanceof CalendarUnavailable) {
      return (
        <Shell>
          <Identity client={context.client} event={context.eventType} />
          <DeadLink
            title="Calendar temporarily unavailable"
            body="We can't read availability right now. Please try again shortly."
          />
        </Shell>
      );
    }
    throw err;
  }

  return (
    <Shell>
      <Identity client={context.client} event={context.eventType} />
      <BookingFlow
        token={token}
        data={{
          client: { name: context.client.name },
          event: {
            name: context.eventType.name,
            description: context.eventType.description,
            durationMin: context.eventType.durationMin,
          },
          lead: {
            first: context.token.leadFirst,
            last: context.token.leadLast,
            company: context.token.leadCompany,
            email: context.token.leadEmail,
          },
          slots,
        }}
      />
    </Shell>
  );
}
