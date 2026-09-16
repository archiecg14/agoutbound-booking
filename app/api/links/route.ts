/**
 * POST /api/links — mint per-lead booking links for a wave.
 *
 * Internal and authenticated. Called by the lead-build / sequence tooling before a campaign
 * sends, so each lead gets a link that carries its own attribution invisibly.
 *
 * The raw tokens are returned EXACTLY ONCE. Only their hashes are stored, so there is no
 * endpoint that can hand them back later. A caller that loses the response must mint again.
 *
 * By default, minting supersedes any earlier unused link for the same lead and event type
 * by expiring it. Without that, re-running a build leaves a lead holding two live links
 * from two different waves, and the booking that eventually arrives cannot be attributed to
 * either with confidence.
 */

import { checkBearer } from "@/lib/api-auth";
import { mintToken } from "@/lib/tokens";
import { serviceClient } from "@/lib/supabase";
import {
  bookingUrl,
  expiryFrom,
  parseMintRequest,
  type MintRequestError,
} from "@/lib/link-requests";

function badRequest(reason: MintRequestError, detail?: string) {
  return Response.json({ error: reason, detail }, { status: 400 });
}

export async function POST(request: Request) {
  const auth = checkBearer(request.headers.get("authorization"), process.env.LINKS_API_KEY);
  if (!auth.ok) {
    if (auth.reason === "unconfigured") {
      console.error("[links] LINKS_API_KEY is not set — refusing all requests");
      return Response.json({ error: "server_misconfigured" }, { status: 503 });
    }
    // One response for missing and invalid alike; no hint about which.
    return Response.json({ error: "unauthorised" }, { status: 401 });
  }

  const baseUrl = process.env.APP_BASE_URL;
  if (!baseUrl) {
    console.error("[links] APP_BASE_URL is not set");
    return Response.json({ error: "server_misconfigured" }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("invalid_body");
  }

  const parsed = parseMintRequest(body);
  if (!parsed.ok) return badRequest(parsed.reason, parsed.detail);
  const { eventTypeId, expiresInDays, supersede, leads } = parsed.value;

  const db = serviceClient();
  const now = new Date().toISOString();

  // The event type has to exist and be live, and it determines the client every minted row
  // is stamped with — the caller does not get to assert which client a lead belongs to.
  const { data: eventType, error: etErr } = await db
    .from("event_types")
    .select("id, client_id, active")
    .eq("id", eventTypeId)
    .maybeSingle();

  if (etErr) {
    console.error("[links] event type lookup failed", etErr);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
  if (!eventType) return badRequest("missing_event_type", "no such event type");
  if (!eventType.active) return badRequest("missing_event_type", "event type is inactive");

  const emails = leads.map((l) => l.email);

  if (supersede) {
    // Expire rather than mark used: these links were never used, and used_at is the record
    // of a booking having happened. Conflating the two would corrupt the funnel counts.
    const { error: supErr } = await db
      .from("link_tokens")
      .update({ expires_at: now })
      .eq("event_type_id", eventType.id)
      .in("lead_email", emails)
      .is("used_at", null)
      .gt("expires_at", now);

    if (supErr) {
      console.error("[links] supersede failed", supErr);
      return Response.json({ error: "server_error" }, { status: 500 });
    }
  }

  const expiresAt = expiryFrom(now, expiresInDays);

  // Mint first, insert once. A per-lead insert would leave a partially minted wave behind
  // on failure, and the caller has no way to tell which half succeeded.
  const minted = leads.map((lead) => ({ lead, ...mintToken() }));

  const { error: insertErr } = await db.from("link_tokens").insert(
    minted.map(({ lead, tokenHash }) => ({
      token_hash: tokenHash,
      event_type_id: eventType.id,
      client_id: eventType.client_id,
      lead_email: lead.email,
      lead_first: lead.first,
      lead_last: lead.last,
      lead_company: lead.company,
      campaign_id: lead.campaignId,
      wave: lead.wave,
      sequence_step: lead.sequenceStep,
      expires_at: expiresAt,
    })),
  );

  if (insertErr) {
    console.error("[links] insert failed", insertErr);
    return Response.json({ error: "server_error" }, { status: 500 });
  }

  return Response.json(
    {
      minted: minted.length,
      expiresAt,
      superseded: supersede,
      // Raw tokens appear here and nowhere else, ever.
      links: minted.map(({ lead, token }) => ({
        email: lead.email,
        url: bookingUrl(baseUrl, token),
      })),
    },
    { status: 201 },
  );
}
