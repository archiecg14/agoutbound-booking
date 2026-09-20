import { notFound } from "next/navigation";
import "../../../b/booking.css";
import { serviceClient } from "@/lib/supabase";
import {
  CalendarUnavailable,
  DEFAULT_RANGE_DAYS,
  availabilityFor,
  loadPublicContext,
} from "@/lib/booking-context";
import { DeadLink, Identity } from "../../../b/[token]/ui";
import { PublicBookingFlow } from "./ui";

/**
 * The public booking page: /book/<client>/<event>. No token, no lead record — anyone with
 * the URL can book, which is the point.
 *
 * Indexable, unlike the per-lead pages. This one is meant to be found.
 */

export const dynamic = "force-dynamic";

export async function generateMetadata(props: PageProps<"/book/[client]/[event]">) {
  const { client, event } = await props.params;
  const loaded = await loadPublicContext(serviceClient(), client, event);
  if (!loaded.ok) return { title: "Book a call" };
  return {
    title: `Book a ${loaded.context.eventType.name.toLowerCase()} — ${loaded.context.client.name}`,
    description: loaded.context.eventType.description ?? "Pick a time that suits you.",
    // The root layout sets noindex for every page, which is right for per-lead links sent
    // to one person. This page is meant to be found, so it opts back in explicitly.
    robots: { index: true, follow: true },
  };
}

export default async function Page(props: PageProps<"/book/[client]/[event]">) {
  const { client, event } = await props.params;
  // Inside a modal on the client's own site the surrounding page already says whose
  // calendar this is, so the identity block and the footer are repetition taking up the
  // vertical space the times need - which on a phone is most of the screen.
  const embedded = (await props.searchParams).embed === "1";
  const now = new Date().toISOString();
  const db = serviceClient();

  const loaded = await loadPublicContext(db, client, event);
  // A page that is not public and a page that does not exist give the same answer, so
  // slug-guessing reveals nothing about which private event types exist.
  if (!loaded.ok) notFound();

  let slots: { start: string; end: string }[] = [];
  let calendarDown = false;
  try {
    slots = await availabilityFor(
      db,
      loaded.context,
      now,
      new Date(Date.parse(now) + DEFAULT_RANGE_DAYS * 86_400_000).toISOString(),
      now,
    );
  } catch (err) {
    if (!(err instanceof CalendarUnavailable)) throw err;
    calendarDown = true;
  }

  return (
    <main className={embedded ? "shell shell--embed" : "shell"}>
      {embedded ? null : <Identity client={loaded.context.client} event={loaded.context.eventType} />}
      {!embedded && loaded.context.eventType.description ? (
        <p className="tz" style={{ marginTop: 0 }}>{loaded.context.eventType.description}</p>
      ) : null}

      {calendarDown ? (
        <DeadLink
          title="Calendar temporarily unavailable"
          body="We can't read availability right now. Please try again shortly."
        />
      ) : (
        <PublicBookingFlow
          clientSlug={client}
          eventSlug={event}
          slots={slots}
          fallbackUrl={loaded.context.client.fallbackUrl}
        />
      )}

      {embedded ? null : <footer className="chrome">Scheduling by AG Outbound</footer>}
    </main>
  );
}
