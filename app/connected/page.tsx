import "../b/booking.css";

/**
 * Where Google sends a client's staff member after they connect or decline. Not a booking
 * page: the audience here is the person whose calendar it is, so it says what happened and
 * what to do next, and nothing about leads or campaigns.
 */

const STATES = {
  ok: {
    title: "Calendar connected",
    body: "Bookings will now appear in your calendar automatically. You can close this tab.",
    good: true,
  },
  denied: {
    title: "Nothing was connected",
    body: "Access was declined, so no calendar has been linked. Open the invite again if that was a mistake.",
    good: false,
  },
  failed: {
    title: "That didn't work",
    body: "The connection could not be completed. Please open the invite link again — if it keeps failing, get in touch and we'll send a fresh one.",
    good: false,
  },
} as const;

export default async function Page(props: PageProps<"/connected">) {
  const params = await props.searchParams;
  const raw = Array.isArray(params.status) ? params.status[0] : params.status;
  // Anything unrecognised is treated as a failure rather than rendered — the status comes
  // in on a query string, so it is caller-controlled text.
  const state = STATES[(raw as keyof typeof STATES) in STATES ? (raw as keyof typeof STATES) : "failed"];

  return (
    <main className="shell">
      <div className={`state${state.good ? " state--good" : ""}`}>
        <div className="state__title">{state.title}</div>
        <p className="state__body">{state.body}</p>
      </div>
      <footer className="chrome">Scheduling by AG Outbound</footer>
    </main>
  );
}
