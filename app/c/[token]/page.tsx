import "../../b/booking.css";
import { serviceClient } from "@/lib/supabase";
import { decryptSecret, isEncrypted } from "@/lib/crypto";
import { finaliseBooking } from "@/lib/booking-finalise";
import {
  canConfirm,
  confirmRefusalMessage,
  hashConfirmToken,
  isWellFormedConfirmToken,
  type ConfirmRefusal,
} from "@/lib/confirm";

/**
 * Where a public booking actually becomes a booking.
 *
 * Opening this link is the proof that was missing at submit time: the address answered. Only
 * now does anything reach the client's calendar.
 *
 * It confirms on GET rather than behind a button. A mail scanner in the recipient's own
 * mailbox may follow the link and confirm on their behalf — which is a real trade-off, and
 * an acceptable one, because a scanner reading THEIR mailbox still demonstrates the exact
 * thing being tested: that the address is real and is theirs. The alternative costs a click
 * on the highest-intent page in the funnel to defend against nothing worse.
 */

export const dynamic = "force-dynamic";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="shell">
      {children}
      <footer className="chrome">Scheduling by AG Outbound</footer>
    </main>
  );
}

function Refused({ reason }: { reason: ConfirmRefusal }) {
  const { title, body } = confirmRefusalMessage(reason);
  return (
    <Shell>
      <div className="state">
        <div className="state__title">{title}</div>
        <p className="state__body">{body}</p>
      </div>
    </Shell>
  );
}

function fmt(iso: string, tz: string, opts: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...opts }).format(new Date(iso));
}

export default async function Page(props: PageProps<"/c/[token]">) {
  const { token } = await props.params;
  const now = new Date().toISOString();

  // Shape first, so scanners and truncated links never reach the database.
  if (!isWellFormedConfirmToken(token)) return <Refused reason="invalid_token" />;

  const db = serviceClient();

  // Looked up by hash — the token itself is never stored, so a leaked database yields no
  // working links.
  const { data: b } = await db
    .from("bookings")
    .select(
      "id, client_id, event_type_id, connection_id, status, start_utc, end_utc, attendee_name, attendee_email, attendee_tz, answers, confirm_expires_at",
    )
    .eq("confirm_token_hash", hashConfirmToken(token))
    .maybeSingle();

  const allowed = canConfirm(
    b && { status: b.status as string, confirmExpiresAt: b.confirm_expires_at as string | null },
    now,
  );
  if (!allowed.ok) return <Refused reason={allowed.reason} />;
  if (!b) return <Refused reason="not_found" />;

  const tz = (b.attendee_tz as string) || "UTC";

  if (!allowed.already) {
    // Conditional on the row still being pending, so two clicks in the same second cannot
    // both go on to create a calendar event. Whoever loses simply sees the success page.
    const { data: claimed, error } = await db
      .from("bookings")
      .update({ status: "confirmed", confirmed_at: now })
      .eq("id", b.id)
      .eq("status", "pending")
      .select("id, start_utc, end_utc")
      .maybeSingle();

    if (error) {
      // The overlap constraint rejecting the update means a confirmed booking took this
      // slot while the hold sat in an inbox. That is the constraint doing its job.
      console.error("[c] confirm failed", b.id, error);
      return <Refused reason="slot_gone" />;
    }

    if (claimed) {
      const [{ data: conn }, { data: client }, { data: et }] = await Promise.all([
        db.from("connections").select("id, refresh_token_enc, email").eq("id", b.connection_id).maybeSingle(),
        db.from("clients").select("name").eq("id", b.client_id).maybeSingle(),
        db.from("event_types").select("name").eq("id", b.event_type_id).maybeSingle(),
      ]);

      if (conn) {
        const answers = (b.answers ?? {}) as { note?: string };
        await finaliseBooking(db, {
          booking: { id: b.id as string, startUtc: claimed.start_utc, endUtc: claimed.end_utc },
          connection: {
            id: conn.id as string,
            refreshToken: isEncrypted(conn.refresh_token_enc)
              ? decryptSecret(conn.refresh_token_enc)
              : (conn.refresh_token_enc as string),
            email: conn.email as string,
          },
          client: { name: (client?.name as string) ?? "" },
          eventType: { name: (et?.name as string) ?? "Call" },
          attendee: { name: b.attendee_name as string, email: b.attendee_email as string },
          note: answers.note ?? null,
          source: "public",
          now,
        });
      } else {
        // The booking is real and committed; only the calendar write is missing. Say
        // nothing alarming to the attendee and leave it for reconcile.py.
        console.error("[c] confirmed but connection missing, left unsynced", b.id);
      }
    }
  }

  return (
    <Shell>
      <div className="state state--good">
        <div className="state__title">
          {allowed.already ? "You’re already booked in" : "You’re booked in"}
        </div>
        <p className="state__body">
          {fmt(b.start_utc as string, tz, { weekday: "long", day: "numeric", month: "long" })} at{" "}
          {fmt(b.start_utc as string, tz, { hour: "2-digit", minute: "2-digit", hour12: false })}{" "}
          ({tz.replace(/_/g, " ")}).
          <br />
          A calendar invitation is on its way to {b.attendee_email as string}.
        </p>
      </div>
    </Shell>
  );
}
