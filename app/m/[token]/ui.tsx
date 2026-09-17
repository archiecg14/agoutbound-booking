"use client";

import { useState } from "react";
import type { Slot } from "../../b/[token]/ui";

function fmt(iso: string, tz: string, opts: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...opts }).format(new Date(iso));
}

export function ManageFlow({
  token,
  clientName,
  start,
  end,
  tz,
  slots,
}: {
  token: string;
  clientName: string;
  start: string;
  end: string;
  tz: string;
  slots: Slot[];
}) {
  const [phase, setPhase] = useState<"view" | "pick" | "cancelled" | "moved">("view");
  const [current, setCurrent] = useState({ start, end });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const when = (s: string, e: string) =>
    `${fmt(s, tz, { weekday: "long", day: "numeric", month: "long" })}, ${fmt(s, tz, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })}–${fmt(e, tz, { hour: "2-digit", minute: "2-digit", hour12: false })}`;

  async function act(path: string, payload: object) {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, ...payload }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; start?: string; end?: string };
      if (!res.ok) {
        setNotice(body.error ?? "That did not work.");
        return null;
      }
      return body;
    } catch {
      setNotice("We could not reach the server. Please try again.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  if (phase === "cancelled") {
    return (
      <div className="state">
        <div className="state__title">Booking cancelled</div>
        <p className="state__body">
          The call has been removed from the calendar. Reply to the original email if you
          want to arrange another time.
        </p>
      </div>
    );
  }

  if (phase === "moved") {
    return (
      <div className="state state--good">
        <div className="state__title">Booking moved</div>
        <p className="state__body">
          Now {when(current.start, current.end)} ({tz.replace(/_/g, " ")}). The calendar
          invitation has been updated.
        </p>
      </div>
    );
  }

  if (phase === "pick") {
    return (
      <div>
        {notice ? <div className="notice">{notice}</div> : null}
        <p className="tz">Pick a new time. Times shown in {tz.replace(/_/g, " ")}.</p>
        <div className="times" role="group" aria-label="Choose a new time">
          {slots.map((s) => (
            <button
              key={s.start}
              className="time"
              disabled={busy}
              onClick={async () => {
                const body = await act("/api/manage/reschedule", { start: s.start });
                if (body?.start && body?.end) {
                  setCurrent({ start: body.start, end: body.end });
                  setPhase("moved");
                }
              }}
            >
              <time dateTime={s.start}>
                {fmt(s.start, tz, { weekday: "short", day: "numeric" })}{" "}
                {fmt(s.start, tz, { hour: "2-digit", minute: "2-digit", hour12: false })}
              </time>
            </button>
          ))}
        </div>
        {slots.length === 0 ? (
          <p className="tz">No other times are free at the moment.</p>
        ) : null}
        <button className="btn btn--quiet" onClick={() => setPhase("view")} disabled={busy}>
          Keep my existing time
        </button>
      </div>
    );
  }

  return (
    <div>
      {notice ? <div className="notice">{notice}</div> : null}
      <div className="chosen">
        <div className="chosen__when">{when(current.start, current.end)}</div>
        <div className="chosen__who">
          with {clientName} · {tz.replace(/_/g, " ")}
        </div>
      </div>

      <button className="btn" onClick={() => setPhase("pick")} disabled={busy}>
        Reschedule
      </button>
      <button
        className="btn btn--quiet"
        disabled={busy}
        onClick={async () => {
          // No confirm dialog: the action is reversible by booking again, and an extra
          // modal on a phone is friction at the exact moment someone is trying to be
          // considerate enough to tell you they cannot make it.
          const body = await act("/api/manage/cancel", {});
          if (body) setPhase("cancelled");
        }}
      >
        {busy ? "Working…" : "Cancel this booking"}
      </button>
    </div>
  );
}
