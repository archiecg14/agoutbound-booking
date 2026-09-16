/**
 * Validation and normalisation for link minting. Pure — no I/O, no clock beyond what is
 * passed in.
 *
 * One consequence of hash-only token storage shapes this whole endpoint: because the raw
 * token is never stored, a previously minted link CANNOT be re-read. So "mint links for
 * this wave" can never return an existing link — it can only mint a new one. That makes
 * re-running a build ambiguous (a lead would hold two live links from two waves), so the
 * endpoint supersedes prior unused links for the same lead and event type by default.
 * Attribution stays unambiguous: the newest link is the only live one.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A wave is tens to low hundreds of leads. The cap is a guard against a runaway caller. */
export const MAX_LEADS_PER_REQUEST = 500;
export const DEFAULT_EXPIRY_DAYS = 60;
const MAX_EXPIRY_DAYS = 365;

export type LeadInput = {
  email: string;
  first?: string | null;
  last?: string | null;
  company?: string | null;
  campaignId?: string | null;
  wave?: string | null;
  sequenceStep?: number | null;
};

export type MintRequest = {
  eventTypeId: string;
  expiresInDays: number;
  supersede: boolean;
  leads: LeadInput[];
};

export type MintRequestError =
  | "invalid_body"
  | "missing_event_type"
  | "no_leads"
  | "too_many_leads"
  | "invalid_lead"
  | "invalid_expiry";

export type MintParseResult =
  | { ok: true; value: MintRequest }
  | { ok: false; reason: MintRequestError; detail?: string };

function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t.length === 0 || t.length > max) return null;
  return t;
}

function optStr(v: unknown, max: number): string | null {
  if (v === undefined || v === null) return null;
  return str(v, max);
}

export function parseMintRequest(body: unknown): MintParseResult {
  if (typeof body !== "object" || body === null) return { ok: false, reason: "invalid_body" };
  const b = body as Record<string, unknown>;

  const eventTypeId = str(b.eventTypeId, 64);
  if (!eventTypeId) return { ok: false, reason: "missing_event_type" };

  let expiresInDays = DEFAULT_EXPIRY_DAYS;
  if (b.expiresInDays !== undefined) {
    const n = b.expiresInDays;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_EXPIRY_DAYS) {
      return { ok: false, reason: "invalid_expiry" };
    }
    expiresInDays = n;
  }

  const supersede = b.supersede === undefined ? true : b.supersede === true;

  if (!Array.isArray(b.leads)) return { ok: false, reason: "invalid_body" };
  if (b.leads.length === 0) return { ok: false, reason: "no_leads" };
  if (b.leads.length > MAX_LEADS_PER_REQUEST) return { ok: false, reason: "too_many_leads" };

  const leads: LeadInput[] = [];
  const seen = new Set<string>();

  for (const raw of b.leads) {
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, reason: "invalid_lead", detail: "not an object" };
    }
    const l = raw as Record<string, unknown>;

    const email = str(l.email, 320)?.toLowerCase();
    if (!email || !EMAIL.test(email)) {
      return { ok: false, reason: "invalid_lead", detail: "bad email" };
    }
    // A duplicate inside one request is a caller bug, and silently minting two links for
    // one lead would produce exactly the ambiguity supersede exists to prevent.
    if (seen.has(email)) {
      return { ok: false, reason: "invalid_lead", detail: `duplicate email: ${email}` };
    }
    seen.add(email);

    let sequenceStep: number | null = null;
    if (l.sequenceStep !== undefined && l.sequenceStep !== null) {
      if (typeof l.sequenceStep !== "number" || !Number.isInteger(l.sequenceStep) || l.sequenceStep < 1) {
        return { ok: false, reason: "invalid_lead", detail: "bad sequenceStep" };
      }
      sequenceStep = l.sequenceStep;
    }

    leads.push({
      email,
      first: optStr(l.first, 100),
      last: optStr(l.last, 100),
      company: optStr(l.company, 200),
      campaignId: optStr(l.campaignId, 64),
      wave: optStr(l.wave, 32),
      sequenceStep,
    });
  }

  return { ok: true, value: { eventTypeId, expiresInDays, supersede, leads } };
}

export function expiryFrom(now: string, days: number): string {
  return new Date(Date.parse(now) + days * 86_400_000).toISOString();
}

/**
 * Build the public URL for a token. Kept here so the shape is asserted by tests rather than
 * assembled inline in the route.
 */
export function bookingUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/b/${token}`;
}
