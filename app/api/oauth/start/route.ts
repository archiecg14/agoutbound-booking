/**
 * GET /api/oauth/start?invite=…&hint=…
 *
 * Begins the consent flow for one client. The invite is required: without it this endpoint
 * is open, and anyone who finds the URL could attach their own calendar to one of your
 * clients and start receiving their bookings.
 */

import { cookies } from "next/headers";
import {
  OAUTH_NONCE_COOKIE,
  consentUrl,
  newNonce,
  signPayload,
  verifyPayload,
} from "@/lib/oauth";

export async function GET(request: Request) {
  const url = new URL(request.url);

  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!googleClientId || !redirectUri) {
    console.error("[oauth] GOOGLE_CLIENT_ID or GOOGLE_REDIRECT_URI is not set");
    return Response.json({ error: "server_misconfigured" }, { status: 503 });
  }

  const invite = verifyPayload<{ k: string; clientId: string }>(url.searchParams.get("invite"));
  if (!invite || invite.k !== "invite") {
    // Expired and forged invites are the same answer. There is nothing useful to tell
    // someone holding a link they were not given.
    return Response.json({ error: "invalid_or_expired_invite" }, { status: 403 });
  }

  // The nonce lives in an httpOnly cookie AND inside the signed state. The callback
  // requires both to agree, so a forged redirect cannot complete a connection even if the
  // attacker can make the victim's browser follow it.
  const nonce = newNonce();
  const state = signPayload({
    k: "state",
    clientId: invite.clientId,
    nonce,
    exp: Date.now() + 15 * 60_000,
  });

  const jar = await cookies();
  jar.set(OAUTH_NONCE_COOKIE, nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax", // must survive the redirect back from Google
    path: "/api/oauth",
    maxAge: 15 * 60,
  });

  return Response.redirect(
    consentUrl({
      clientId: googleClientId,
      redirectUri,
      state,
      loginHint: url.searchParams.get("hint") ?? undefined,
    }),
    302,
  );
}
