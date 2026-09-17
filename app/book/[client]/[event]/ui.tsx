"use client";

import { useMemo, useState } from "react";
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
}: {
  clientSlug: string;
  eventSlug: string;
  slots: Slot[];
}) {
  const [zone, setZone] = useState(detectZone);
  const [chosen, setChosen] = useState<Slot | null>(null);
  const [done, setDone] = useState<Slot | null>(null);
  const [form, setForm] = useState({ name: "", email: "", note: "", company: "" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeDay, setActiveDay] = useState(0);

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

  const times = days[activeDay]?.[1] ?? [];

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
      if (res.status === 201) {
        setDone(chosen);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setNotice(body.error ?? "That did not work. Please try again.");
      // A lost slot sends them back to the picker rather than replacing the page.
      if (res.status === 409) setChosen(null);
    } catch {
      setNotice("We could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) return <Booked start={done.start} zone={zone} email={form.email} />;

  if (chosen) {
    return (
      <form onSubmit={submit}>
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

        {notice ? <div className="notice">{notice}</div> : null}

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
          {busy ? "Confirming…" : "Confirm booking"}
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
      {notice ? <div className="notice">{notice}</div> : null}

      <div className="days" role="group" aria-label="Choose a day">
        {days.map(([key, daySlots], i) => (
          <button key={key} className="day" aria-pressed={i === activeDay} onClick={() => setActiveDay(i)}>
            <span className="day__dow">{fmt(daySlots[0].start, zone, { weekday: "short" })}</span>
            <span className="day__num">{fmt(daySlots[0].start, zone, { day: "numeric" })}</span>
          </button>
        ))}
      </div>

      <div className="times" role="group" aria-label="Choose a time">
        {times.map((s) => (
          <button key={s.start} className="time" onClick={() => setChosen(s)}>
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
    </div>
  );
}
