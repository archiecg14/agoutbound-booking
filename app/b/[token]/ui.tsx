"use client";

import { useMemo, useState } from "react";

export type Slot = { start: string; end: string };

export type BookingData = {
  client: { name: string };
  event: { name: string; description: string | null; durationMin: number };
  lead: { first: string | null; last: string | null; company: string | null; email: string };
  slots: Slot[];
};

type Phase = "pick" | "confirm" | "done";

/**
 * The prospect's own timezone, read from the browser. Never defaulted to UTC — the
 * incumbents do exactly that when they cannot resolve a zone, and it is the documented
 * cause of people booking calls at 2am.
 */
function detectZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function dayKey(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

function fmt(iso: string, tz: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...opts }).format(new Date(iso));
}

export function BookingFlow({ token, data }: { token: string; data: BookingData }) {
  const [zone, setZone] = useState(detectZone);
  const [phase, setPhase] = useState<Phase>("pick");
  const [chosen, setChosen] = useState<Slot | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Group into days in the PROSPECT's zone, not the host's. Their Tuesday may be the host's
  // Monday, and the day strip has to read correctly for the person looking at it.
  const days = useMemo(() => {
    const map = new Map<string, Slot[]>();
    for (const s of data.slots) {
      const k = dayKey(s.start, zone);
      const list = map.get(k);
      if (list) list.push(s);
      else map.set(k, [s]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [data.slots, zone]);

  const [activeDay, setActiveDay] = useState(0);
  const times = days[activeDay]?.[1] ?? [];

  const leadName = [data.lead.first, data.lead.last].filter(Boolean).join(" ").trim();

  async function confirm() {
    if (!chosen) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          start: chosen.start,
          attendeeName: leadName || data.lead.email,
          attendeeEmail: data.lead.email,
          attendeeTz: zone,
          note: note.trim() || null,
        }),
      });

      if (res.status === 201) {
        setPhase("done");
        return;
      }

      // A lost slot returns the prospect to the picker with the reason inline. Replacing the
      // page with an error would lose someone who was one tap from booking.
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setNotice(body.error ?? "That did not work. Please try another time.");
      setPhase("pick");
      setChosen(null);
    } catch {
      setNotice("We could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (phase === "done" && chosen) {
    return <Booked start={chosen.start} zone={zone} email={data.lead.email} />;
  }

  if (phase === "confirm" && chosen) {
    return (
      <div>
        <div className="chosen">
          <div className="chosen__when">
            {fmt(chosen.start, zone, { weekday: "long", day: "numeric", month: "long" })}
            {", "}
            {fmt(chosen.start, zone, { hour: "2-digit", minute: "2-digit", hour12: false })}
            {"–"}
            {fmt(chosen.end, zone, { hour: "2-digit", minute: "2-digit", hour12: false })}
          </div>
          <div className="chosen__who">
            Booking as {leadName || data.lead.email}
            {data.lead.company ? ` · ${data.lead.company}` : ""}
            <br />
            {data.lead.email}
          </div>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="note">
            Anything useful to know before the call? (optional)
          </label>
          <textarea
            id="note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={2000}
            rows={3}
            placeholder="Roles you're hiring for, timescales, anything relevant."
          />
        </div>

        <button className="btn" onClick={confirm} disabled={busy}>
          {busy ? "Confirming…" : "Confirm booking"}
        </button>
        <button className="btn btn--quiet" onClick={() => setPhase("pick")} disabled={busy}>
          Pick another time
        </button>
      </div>
    );
  }

  if (days.length === 0) {
    return (
      <div className="state">
        <div className="state__title">No times available</div>
        <p className="state__body">
          There&rsquo;s nothing free in the next couple of weeks. Reply to the email and
          we&rsquo;ll find a time directly.
        </p>
      </div>
    );
  }

  return (
    <div>
      {notice ? <div className="notice">{notice}</div> : null}

      <div className="days" role="group" aria-label="Choose a day">
        {days.map(([key, slots], i) => (
          <button
            key={key}
            className="day"
            aria-pressed={i === activeDay}
            onClick={() => setActiveDay(i)}
          >
            <span className="day__dow">
              {fmt(slots[0].start, zone, { weekday: "short" })}
            </span>
            <span className="day__num">{fmt(slots[0].start, zone, { day: "numeric" })}</span>
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
              setPhase("confirm");
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
    </div>
  );
}

/** The terminal success state. Exported so it can be rendered on its own — otherwise the
 *  only way to see it is to complete a real booking, which is exactly the screen you least
 *  want to be looking at for the first time in production. */
export function Booked({ start, zone, email }: { start: string; zone: string; email: string }) {
  return (
    <div className="state state--good">
      <div className="state__title">You&rsquo;re booked in</div>
      <p className="state__body">
        {fmt(start, zone, { weekday: "long", day: "numeric", month: "long" })} at{" "}
        {fmt(start, zone, { hour: "2-digit", minute: "2-digit", hour12: false })}{" "}
        ({zone.replace(/_/g, " ")}).
        <br />
        A calendar invitation is on its way to {email}.
      </p>
    </div>
  );
}

export function Identity({
  client,
  event,
}: {
  client: { name: string };
  event: { name: string; durationMin: number };
}) {
  return (
    <header className="identity">
      <div className="identity__client">{client.name}</div>
      <div className="identity__event">
        {event.name} · {event.durationMin} minutes
      </div>
      <hr className="identity__rule" />
    </header>
  );
}

export function DeadLink({ title, body }: { title: string; body: string }) {
  return (
    <div className="state">
      <div className="state__title">{title}</div>
      <p className="state__body">{body}</p>
    </div>
  );
}
