/**
 * Transactional email, behind one interface.
 *
 * MUST NOT share a sending domain with the cold-email campaigns. Booking reminders and
 * outreach have opposite reputation profiles: outreach is cold volume to strangers,
 * reminders are expected mail to people who already said yes. Sharing a domain means one
 * spam complaint on outreach can stop a confirmed attendee being reminded, and a reminder
 * bounce can dent campaign reputation. REMINDER_FROM is validated against the configured
 * cold-email domains for exactly that reason.
 */

export type SendResult =
  | { ok: true; id: string }
  | { ok: false; reason: string; retryable: boolean };

export function senderConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.REMINDER_FROM);
}

/** Domains used for cold outreach. A reminder must never be sent from one of these. */
function coldDomains(): string[] {
  return (process.env.COLD_EMAIL_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

export function fromAddressProblem(): string | null {
  const from = process.env.REMINDER_FROM;
  if (!from) return "REMINDER_FROM is not set";
  const domain = from.split("@").pop()?.replace(/>$/, "").trim().toLowerCase() ?? "";
  if (!domain) return "REMINDER_FROM has no domain";
  if (coldDomains().includes(domain)) {
    return `REMINDER_FROM uses ${domain}, which is a cold-outreach domain — use a separate one`;
  }
  return null;
}

export async function sendEmail(args: {
  to: string;
  subject: string;
  text: string;
}): Promise<SendResult> {
  // Never silently succeed with nothing sent. An unconfigured sender is a real state the
  // caller records as 'skipped', not as 'sent'.
  if (!senderConfigured()) return { ok: false, reason: "no sender configured", retryable: false };

  const problem = fromAddressProblem();
  if (problem) return { ok: false, reason: problem, retryable: false };

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.REMINDER_FROM,
        to: [args.to],
        subject: args.subject,
        text: args.text,
      }),
    });

    if (res.ok) {
      const body = (await res.json()) as { id?: string };
      return { ok: true, id: body.id ?? "unknown" };
    }
    // 4xx is our fault and will fail identically on retry; 5xx and 429 are worth retrying.
    const retryable = res.status >= 500 || res.status === 429;
    return { ok: false, reason: `${res.status} ${await res.text()}`.slice(0, 300), retryable };
  } catch (err) {
    return { ok: false, reason: String(err).slice(0, 300), retryable: true };
  }
}
