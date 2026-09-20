"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Slot } from "../../../b/[token]/ui";
import { Booked } from "../../../b/[token]/ui";

/**
 * The public flow. Same two steps as the per-lead page, with one difference that matters:
 * there is no lead record, so the visitor types their own name and email.
 *
 * Kept to three fields. Every extra one costs bookings, and nothing else here is worth
 * knowing before a first call that a human cannot simply ask during it.
 */

function detectZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function fmt(iso: string, tz: string, opts: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...opts }).format(new Date(iso));
}

function dayKey(iso: string, tz: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

export function PublicBookingFlow({
  clientSlug,
  eventSlug,
  slots,
  fallbackUrl,
}: {
  clientSlug: string;
  eventSlug: string;
  slots: Slot[];
  /** Where to send someone none of the offered days suit. Null renders nothing. */
  fallbackUrl?: string | null;
}) {
  const [zone, setZone] = useState(detectZone);
  const [chosen, setChosen] = useState<Slot | null>(null);
  // Which ending we reached matters: 201 means booked, 202 means a link is in their inbox
  // and nothing is booked yet. Showing the wrong one produces either a no-show or a
  // duplicate booking.
  const [done, setDone] = useState<{ slot: Slot; confirmed: boolean } | null>(null);
  const [form, setForm] = useState({ name: "", email: "", note: "", company: "" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Keyed, not indexed. `days` is rebuilt whenever the zone changes, and a positional
  // index survives that rebuild pointing at a different day — or past the end, which
  // renders an empty grid with no day selected and nothing to explain it. A key either
  // still exists in the new list or it does not, and "does not" falls back to the first
  // day rather than to nothing.
  const [activeDayKey, setActiveDayKey] = useState<string | null>(null);
  // Sighted users see the slot grid swap for a form. Everyone else gets told.
  const [announcement, setAnnouncement] = useState("");
  const formHeadingRef = useRef<HTMLHeadingElement>(null);

  const days = useMemo(() => {
    const map = new Map<string, Slot[]>();
    for (const s of slots) {
      const k = dayKey(s.start, zone);
      const list = map.get(k);
      if (list) list.push(s);
      else map.set(k, [s]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [slots, zone]);

  const activeDay = Math.max(
    0,
    days.findIndex(([k]) => k === activeDayKey),
  );
  const times = days[activeDay]?.[1] ?? [];

  // Picking a time replaces the whole grid with a form. Without moving focus, a keyboard
  // or screen-reader user is left where the grid used to be with no idea anything changed,
  // and has to go hunting for the form they just asked for. Focus is a DOM side effect of
  // the render, so it belongs in an effect; the wording that goes with it is set by the
  // handler that caused it.
  useEffect(() => {
    if (chosen) formHeadingRef.current?.focus();
  }, [chosen]);

  /** A failure the user has to act on: shown, and said out loud. */
  function fail(message: string) {
    setNotice(message);
    setAnnouncement(message);
  }

  function describeDay(day: [string, Slot[]]) {
    const count = day[1].length;
    return `${count} ${count === 1 ? "time" : "times"} available on ${fmt(day[1][0].start, zone, {
      weekday: "long",
      day: "numeric",
      month: "long",
    })}.`;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!chosen) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(
        `/api/public/bookings?client=${encodeURIComponent(clientSlug)}&event=${encodeURIComponent(eventSlug)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            start: chosen.start,
            name: form.name,
            email: form.email,
            timezone: zone,
            note: form.note || null,
            company: form.company, // honeypot; a human never fills this
          }),
        },
      );
      // 201 = booked outright. 202 = accepted, with a confirmation link sent and nothing
      // booked yet. Saying "you're booked in" for a 202 would be a lie the calendar then
      // contradicts, so the two are never collapsed into one message.
      if (res.status === 201 || res.status === 202) {
        setDone({ slot: chosen, confirmed: res.status === 201 });
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      fail(body.error ?? "That did not work. Please try again.");
      // A lost slot sends them back to the picker rather than replacing the page. A failed
      // confirmation email does not — the time is fine, the address is what needs fixing.
      if (res.status === 409) setChosen(null);
    } catch {
      fail("We could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return done.confirmed ? (
      <Booked start={done.slot.start} zone={zone} email={form.email} />
    ) : (
      <CheckYourEmail start={done.slot.start} zone={zone} email={form.email} />
    );
  }

  if (chosen) {
    return (
      <form onSubmit={submit}>
        <p className="sr-only" role="status" aria-live="polite">
          {announcement}
        </p>

        {/* tabIndex -1 makes this focusable programmatically but keeps it out of the tab
            order. Focusing the heading rather than the first input means the step is
            announced before the field, so nobody is typing into an unexplained box. */}
        <h2 className="sr-only" tabIndex={-1} ref={formHeadingRef}>
          Confirm your booking
        </h2>

        <div className="chosen">
          <div className="chosen__when">
            {fmt(chosen.start, zone, { weekday: "long", day: "numeric", month: "long" })}
            {", "}
            {fmt(chosen.start, zone, { hour: "2-digit", minute: "2-digit", hour12: false })}
            {"–"}
            {fmt(chosen.end, zone, { hour: "2-digit", minute: "2-digit", hour12: false })}
          </div>
          <div className="chosen__who">{zone.replace(/_/g, " ")}</div>
        </div>

        {notice ? <div className="notice" role="alert">{notice}</div> : null}

        <div className="field">
          <label className="field__label" htmlFor="name">Your name</label>
          <input
            id="name"
            className="pubinput"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
            autoComplete="name"
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="email">Your email</label>
          <input
            id="email"
            className="pubinput"
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            required
            autoComplete="email"
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="note">
            What would you like to cover? (optional)
          </label>
          <textarea
            id="note"
            value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
            rows={3}
            maxLength={2000}
          />
        </div>

        {/* Honeypot. Hidden from people, irresistible to bots. aria-hidden and tabIndex keep
            it away from screen readers and keyboard users alike. */}
        <div aria-hidden="true" style={{ position: "absolute", left: "-9999px" }}>
          <label htmlFor="company">Company</label>
          <input
            id="company"
            tabIndex={-1}
            autoComplete="off"
            value={form.company}
            onChange={(e) => setForm({ ...form, company: e.target.value })}
          />
        </div>

        <button className="btn" type="submit" disabled={busy}>
          {busy ? "Booking…" : "Book this time"}
        </button>
        <button
          className="btn btn--quiet"
          type="button"
          onClick={() => setChosen(null)}
          disabled={busy}
        >
          Pick another time
        </button>
      </form>
    );
  }

  if (days.length === 0) {
    return (
      <div className="state">
        <div className="state__title">No times available</div>
        <p className="state__body">
          There&rsquo;s nothing free at the moment. Try again in a day or two.
        </p>
      </div>
    );
  }

  return (
    <div>
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      <h2 className="sr-only">Choose a time</h2>

      {notice ? <div className="notice" role="alert">{notice}</div> : null}

      <div className="days" role="group" aria-label="Choose a day">
        {days.map(([key, daySlots], i) => (
          <button
            key={key}
            className="day"
            aria-pressed={i === activeDay}
            /* The visible label is two spans, "Mon" and "21", which a screen reader runs
               together as "Mon21". The full date is spelled out here instead. */
            aria-label={fmt(daySlots[0].start, zone, {
              weekday: "long",
              day: "numeric",
              month: "long",
            })}
            onClick={() => {
              setActiveDayKey(key);
              setAnnouncement(describeDay([key, daySlots]));
            }}
          >
            <span className="day__dow">{fmt(daySlots[0].start, zone, { weekday: "short" })}</span>
            <span className="day__num">{fmt(daySlots[0].start, zone, { day: "numeric" })}</span>
          </button>
        ))}
      </div>

      <div className="times" role="group" aria-label="Choose a time">
        {times.map((s) => (
          <button
            key={s.start}
            className="time"
            onClick={() => {
              setChosen(s);
              setAnnouncement("Time selected. Enter your details to finish booking.");
            }}
          >
            <time dateTime={s.start}>
              {fmt(s.start, zone, { hour: "2-digit", minute: "2-digit", hour12: false })}
            </time>
          </button>
        ))}
      </div>

      <p className="tz">
        Times shown in {zone.replace(/_/g, " ")}.{" "}
        <button onClick={() => setZone(zone === "UTC" ? detectZone() : "UTC")}>
          {zone === "UTC" ? "Use my timezone" : "Show in UTC"}
        </button>
      </p>

      {/*
        The window is deliberately short, so someone away for all of it sees no workable
        time and has no move but to close the tab. target="_top" because this page is
        usually inside a modal iframe on the client's own site: without it the site would
        load inside its own popup.
      */}
      {fallbackUrl ? (
        <p className="tz">
          None of these work?{" "}
          <a href={fallbackUrl} target="_top" rel="noopener">
            Send a message instead
          </a>
        </p>
      ) : null}
    </div>
  );
}

/**
 * The honest end of the public flow.
 *
 * It deliberately does NOT say "you're booked in". Nothing is booked until the link in the
 * email is opened, and a page that claims otherwise produces people who never confirm and
 * then arrive for a call that does not exist.
 */
function CheckYourEmail({ start, zone, email }: { start: string; zone: string; email: string }) {
  return (
    <div className="state state--good">
      <div className="state__title">Check your email</div>
      <p className="state__body">
        We&rsquo;ve sent a confirmation link to {email}. Open it and{" "}
        {fmt(start, zone, { weekday: "long", day: "numeric", month: "long" })} at{" "}
        {fmt(start, zone, { hour: "2-digit", minute: "2-digit", hour12: false })} is yours.
        <br />
        We&rsquo;ll hold the time for 15 minutes.
      </p>
    </div>
  );
}
