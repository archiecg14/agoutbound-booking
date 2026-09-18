"use client";

import { useState } from "react";

/**
 * The two writes an operator actually needs. Plain forms rather than an editing grid: with
 * two clients and a handful of event types, a grid would be more code than the thing it
 * edits, and every field here is one somebody sets once and rarely touches again.
 */

type Option = { id: string; label: string };

function Result({ state }: { state: { ok: boolean; text: string } | null }) {
  if (!state) return null;
  return <div className={state.ok ? "tz" : "notice"}>{state.text}</div>;
}

async function post(url: string, body: object) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, json };
}

export function EventTypeForm({ clients, connections }: { clients: Option[]; connections: Option[] }) {
  const [f, setF] = useState({
    clientId: clients[0]?.id ?? "",
    connectionId: connections[0]?.id ?? "",
    slug: "intro-call",
    name: "Intro call",
    // Fifteen, matching the live intro call. With the fifteen-minute buffer below it
    // still reserves half an hour, so the ask of a stranger is smaller than the cost.
    durationMin: 15,
    slotIntervalMin: 15,
    bufferBefore: 0,
    bufferAfter: 15,
    minNoticeMin: 120,
    // One week. Far enough ahead to be convenient, close enough that the calendar it was
    // computed from is still roughly true when the call arrives.
    dateRangeDays: 7,
    isPublic: false,
  });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  if (!clients.length || !connections.length) {
    return <p className="empty">Seed a client and connect a calendar first.</p>;
  }

  return (
    <form
      className="opsform"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const { ok, json } = await post("/api/ops/event-types", f);
        setResult({ ok, text: ok ? `Saved “${f.name}”.` : `Failed: ${json.error ?? "unknown"}` });
        setBusy(false);
        if (ok) window.location.reload();
      }}
    >
      <label>
        Client
        <select value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })}>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>{c.label}</option>
          ))}
        </select>
      </label>
      <label>
        Calendar
        <select value={f.connectionId} onChange={(e) => setF({ ...f, connectionId: e.target.value })}>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>{c.label}</option>
          ))}
        </select>
      </label>
      <label>
        Name
        <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      </label>
      <label>
        Slug
        <input
          value={f.slug}
          onChange={(e) => setF({ ...f, slug: e.target.value })}
          pattern="[a-z0-9][a-z0-9-]*[a-z0-9]"
          title="lowercase letters, numbers and hyphens"
        />
      </label>
      {(
        [
          ["durationMin", "Minutes"],
          ["slotIntervalMin", "Slot every"],
          ["bufferBefore", "Buffer before"],
          ["bufferAfter", "Buffer after"],
          ["minNoticeMin", "Min notice"],
          ["dateRangeDays", "Days ahead"],
        ] as const
      ).map(([key, label]) => (
        <label key={key}>
          {label}
          <input
            type="number"
            value={f[key]}
            onChange={(e) => setF({ ...f, [key]: Number(e.target.value) })}
          />
        </label>
      ))}
      <label className="opsform__dayname" style={{ gridColumn: "1 / -1" }}>
        <input
          type="checkbox"
          checked={f.isPublic}
          onChange={(e) => setF({ ...f, isPublic: e.target.checked })}
        />
        Public — anyone with the URL can book this, no link required
      </label>
      <p className="ops__sub" style={{ gridColumn: "1 / -1" }}>
        Leave unticked for outreach event types. A public page is reachable at
        /book/&lt;client&gt;/&lt;slug&gt; and is indexable.
      </p>
      <button className="btn" disabled={busy}>{busy ? "Saving…" : "Save event type"}</button>
      <Result state={result} />
    </form>
  );
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function AvailabilityForm({ connections }: { connections: Option[] }) {
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? "");
  const [timezone, setTimezone] = useState("Europe/London");
  // Weekdays on by default; a booking calendar that offers Sunday by accident is worse
  // than one that offers nothing.
  const [days, setDays] = useState(() =>
    DAYS.map((_, i) => ({ on: i >= 1 && i <= 5, start: "09:00", end: "17:00" })),
  );
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  if (!connections.length) return <p className="empty">Connect a calendar first.</p>;

  return (
    <form
      className="opsform"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const rules = days
          .flatMap((d, weekday) =>
            d.on ? [{ weekday, startLocal: d.start, endLocal: d.end, timezone }] : [],
          );
        const { ok, json } = await post("/api/ops/availability", { connectionId, rules });
        setResult({
          ok,
          // Replace, not merge — say how many rules now exist so it is obvious the whole
          // week was overwritten.
          text: ok ? `Saved — ${rules.length} rule(s) now define the week.` : `Failed: ${json.error ?? "unknown"}`,
        });
        setBusy(false);
      }}
    >
      <label>
        Calendar
        <select value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>{c.label}</option>
          ))}
        </select>
      </label>
      <label>
        Timezone
        <input value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="Europe/London" />
      </label>
      <div className="opsform__days">
        {days.map((d, i) => (
          <div key={DAYS[i]} className="opsform__day">
            <label className="opsform__dayname">
              <input
                type="checkbox"
                checked={d.on}
                onChange={(e) => setDays(days.map((x, j) => (i === j ? { ...x, on: e.target.checked } : x)))}
              />
              {DAYS[i]}
            </label>
            <input
              type="time"
              value={d.start}
              disabled={!d.on}
              onChange={(e) => setDays(days.map((x, j) => (i === j ? { ...x, start: e.target.value } : x)))}
            />
            <input
              type="time"
              value={d.end}
              disabled={!d.on}
              onChange={(e) => setDays(days.map((x, j) => (i === j ? { ...x, end: e.target.value } : x)))}
            />
          </div>
        ))}
      </div>
      <p className="ops__sub">This replaces the whole week for the selected calendar.</p>
      <button className="btn" disabled={busy}>{busy ? "Saving…" : "Save availability"}</button>
      <Result state={result} />
    </form>
  );
}
