import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import "./ops.css";
import "../b/booking.css";
import { serviceClient } from "@/lib/supabase";
import { OPS_COOKIE, isOperator } from "@/lib/operator-auth";

/**
 * The operator dashboard. Read-only by design for now: the things worth seeing daily are
 * which calendars have gone dark and what is actually booked, and both are questions the
 * database already answers.
 *
 * The connections panel is the reason this page exists. `needs_reconsent` was made a
 * first-class state in the schema precisely so a client whose grant lapsed is visible here
 * rather than discovered when a prospect cannot book.
 */

export const dynamic = "force-dynamic";

function Pill({ status }: { status: string }) {
  const cls =
    status === "active" ? "pill pill--ok" : status === "needs_reconsent" ? "pill pill--warn" : "pill pill--bad";
  return <span className={cls}>{status.replace(/_/g, " ")}</span>;
}

function when(iso: string | null) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/London",
  }).format(new Date(iso));
}

function Panel({
  title,
  count,
  head,
  rows,
  empty,
}: {
  title: string;
  count?: number;
  head: string[];
  rows: React.ReactNode[];
  empty: string;
}) {
  return (
    <section className="panel">
      <div className="panel__head">
        <span className="panel__title">{title}</span>
        {count !== undefined ? <span className="panel__count">{count}</span> : null}
      </div>
      {rows.length === 0 ? (
        <p className="empty">{empty}</p>
      ) : (
        <div className="tablewrap">
          <table className="ops-table">
            <thead>
              <tr>
                {head.map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>{rows}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default async function OpsPage() {
  const jar = await cookies();
  if (!isOperator(jar.get(OPS_COOKIE)?.value)) redirect("/ops/login");

  const db = serviceClient();
  const now = new Date().toISOString();

  const [clients, connections, eventTypes, bookings] = await Promise.all([
    db.from("clients").select("id, slug, name, active").order("name"),
    db.from("connections").select("id, client_id, email, status, last_ok_at, last_error"),
    db.from("event_types").select("id, client_id, slug, name, duration_min, active").order("name"),
    db
      .from("bookings")
      .select("id, client_id, attendee_email, start_utc, status, google_event_id")
      .gte("start_utc", now)
      .order("start_utc")
      .limit(50),
  ]);

  const clientName = new Map((clients.data ?? []).map((c) => [c.id, c.name as string]));

  return (
    <main className="ops">
      <h1>Booking operations</h1>
      <p className="ops__sub">Live from the database. Nothing here is cached.</p>

      <Panel
        title="Calendars"
        count={connections.data?.length ?? 0}
        head={["Client", "Account", "Status", "Last OK", "Last error"]}
        empty="No calendars connected yet. Send a client a connect invite to begin."
        rows={(connections.data ?? []).map((c) => (
          <tr key={c.id}>
            <td>{clientName.get(c.client_id) ?? c.client_id}</td>
            <td>{c.email}</td>
            <td>
              <Pill status={c.status} />
            </td>
            <td>{when(c.last_ok_at)}</td>
            <td style={{ color: "var(--mute-2)", whiteSpace: "normal" }}>
              {c.last_error ? String(c.last_error).slice(0, 80) : "—"}
            </td>
          </tr>
        ))}
      />

      <Panel
        title="Upcoming bookings"
        count={bookings.data?.length ?? 0}
        head={["When", "Client", "Attendee", "Status", "Calendar"]}
        empty="No upcoming bookings."
        rows={(bookings.data ?? []).map((b) => (
          <tr key={b.id}>
            <td>{when(b.start_utc)}</td>
            <td>{clientName.get(b.client_id) ?? b.client_id}</td>
            <td>{b.attendee_email}</td>
            <td>{b.status}</td>
            <td>
              {/* An unsynced booking is one the client cannot see in their own calendar. */}
              {b.google_event_id ? "synced" : <span className="pill pill--warn">unsynced</span>}
            </td>
          </tr>
        ))}
      />

      <Panel
        title="Event types"
        count={eventTypes.data?.length ?? 0}
        head={["Client", "Name", "Slug", "Minutes", "Active"]}
        empty="No event types yet. Nothing can be booked until one exists."
        rows={(eventTypes.data ?? []).map((e) => (
          <tr key={e.id}>
            <td>{clientName.get(e.client_id) ?? e.client_id}</td>
            <td>{e.name}</td>
            <td style={{ color: "var(--mute-2)" }}>{e.slug}</td>
            <td>{e.duration_min}</td>
            <td>{e.active ? "yes" : <span className="pill pill--bad">no</span>}</td>
          </tr>
        ))}
      />

      <Panel
        title="Clients"
        count={clients.data?.length ?? 0}
        head={["Name", "Slug", "Active"]}
        empty="No clients seeded."
        rows={(clients.data ?? []).map((c) => (
          <tr key={c.id}>
            <td>{c.name}</td>
            <td style={{ color: "var(--mute-2)" }}>{c.slug}</td>
            <td>{c.active ? "yes" : <span className="pill pill--bad">no</span>}</td>
          </tr>
        ))}
      />

      <footer className="chrome">
        Times in Europe/London. Booking data is client data — treat this page accordingly.
      </footer>
    </main>
  );
}
