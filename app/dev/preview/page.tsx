import { notFound } from "next/navigation";
import "../../b/booking.css";
import { Booked, BookingFlow, DeadLink, Identity } from "../../b/[token]/ui";

/**
 * Visual harness for the booking states. Development only — it renders fixture data with no
 * database, so every state can be seen and screenshotted before anything is connected.
 *
 * It calls notFound() in production. This page must never be reachable on a deployed site:
 * it is not secret, but it is a fake booking page, and a fake booking page on a real domain
 * is exactly the thing that makes a genuine one look untrustworthy.
 */

const client = { name: "Acme Recruitment" };
const event = { name: "Intro call", description: null, durationMin: 30 };
const lead = {
  first: "Jane",
  last: "Okafor",
  company: "Northgate Data Services",
  email: "jane.okafor@example.com",
};

/** Weekday 09:00–16:30 slots across the next few days, in fixed UTC so shots are stable. */
function fixtureSlots() {
  const out: { start: string; end: string }[] = [];
  const base = Date.UTC(2026, 8, 21, 9, 0, 0); // Mon 21 Sep 2026, 09:00Z
  for (let day = 0; day < 5; day++) {
    for (let i = 0; i < 12; i++) {
      const start = base + day * 86_400_000 + i * 45 * 60_000;
      out.push({ start: new Date(start).toISOString(), end: new Date(start + 1_800_000).toISOString() });
    }
  }
  return out;
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section style={{ borderTop: "1px dashed var(--line)", paddingTop: "var(--s-5)", marginTop: "var(--s-7)" }}>
      <p style={{ color: "var(--blue-lite)", fontSize: "var(--t-micro)", letterSpacing: "0.08em", textTransform: "uppercase", margin: "0 0 var(--s-4)" }}>
        {label}
      </p>
      {children}
    </section>
  );
}

export default function PreviewPage() {
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <main className="shell">
      <Section label="1 — Pick a time (valid link)">
        <Identity client={client} event={event} />
        <BookingFlow token={"x".repeat(43)} data={{ client, event, lead, slots: fixtureSlots() }} />
      </Section>

      <Section label="2 — No availability in range">
        <Identity client={client} event={event} />
        <BookingFlow token={"x".repeat(43)} data={{ client, event, lead, slots: [] }} />
      </Section>

      <Section label="3 — Booked (the terminal success state)">
        <Identity client={client} event={event} />
        <Booked start="2026-09-21T09:00:00.000Z" zone="Europe/London" email={lead.email} />
      </Section>

      <Section label="4 — Dead link (expired, spent or unknown)">
        <DeadLink
          title="This link is no longer valid"
          body="It may have expired or already been used. Reply to the email and we'll send a fresh one."
        />
      </Section>

      <Section label="5 — Calendar unavailable">
        <Identity client={client} event={event} />
        <DeadLink
          title="Calendar temporarily unavailable"
          body="We can't read availability right now. Please try again shortly."
        />
      </Section>

      <footer className="chrome">Scheduling by AG Outbound</footer>
    </main>
  );
}
