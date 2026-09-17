/**
 * GET /api/oauth/callback — completes the consent flow and stores the connection.
 *
 * The refresh token is encrypted before it touches the database. It is a long-lived key to
 * a client's calendar: it outlives password changes, and the database's own at-rest
 * encryption protects nothing once somebody holds a service key or a backup dump.
 */

import { cookies } from "next/headers";
import { serviceClient } from "@/lib/supabase";
import { encryptSecret } from "@/lib/crypto";
import { OAUTH_NONCE_COOKIE, SCOPES, TOKEN_URL, subjectFromIdToken, verifyPayload } from "@/lib/oauth";

function done(status: "ok" | "denied" | "failed", base: string) {
  return Response.redirect(new URL(`/connected?status=${status}`, base), 302);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const origin = url.origin;

  const jar = await cookies();
  const cookieNonce = jar.get(OAUTH_NONCE_COOKIE)?.value ?? null;
  // One-shot: clear it whatever happens, so a state value can never be replayed.
  jar.delete({ name: OAUTH_NONCE_COOKIE, path: "/api/oauth" });

  // The user pressed cancel on Google's screen. Not an error, just a decision.
  if (url.searchParams.get("error")) return done("denied", origin);

  const state = verifyPayload<{ k: string; clientId: string; nonce: string }>(
    url.searchParams.get("state"),
  );
  const code = url.searchParams.get("code");

  // Signature, purpose and cookie must all agree. Any one of them missing means this
  // callback did not originate from a flow we started.
  if (!state || state.k !== "state" || !code || !cookieNonce || state.nonce !== cookieNonce) {
    console.warn("[oauth] callback rejected: state or nonce mismatch");
    return done("failed", origin);
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    console.error("[oauth] google credentials are not configured");
    return done("failed", origin);
  }

  let tokens: { refresh_token?: string; access_token?: string; id_token?: string; scope?: string };
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    if (!res.ok) {
      console.error("[oauth] token exchange failed", res.status, await res.text());
      return done("failed", origin);
    }
    tokens = await res.json();
  } catch (err) {
    console.error("[oauth] token exchange threw", err);
    return done("failed", origin);
  }

  // No refresh token means no unattended access, and the connection would die within the
  // hour. Better to fail the connect now than to store something that looks like it works.
  if (!tokens.refresh_token || !tokens.access_token) {
    console.error("[oauth] no refresh_token in response — was prompt=consent sent?");
    return done("failed", origin);
  }

  // Google may grant fewer scopes than were asked for. Storing a connection that cannot
  // read freebusy would surface later as mysterious 403s during a booking.
  const granted = (tokens.scope ?? "").split(" ");
  const missing = SCOPES.filter((s) => s !== "openid" && !granted.includes(s));
  if (missing.length) {
    console.error("[oauth] missing required scopes", missing);
    return done("failed", origin);
  }

  // The primary calendar's id IS the account's email address, so this avoids asking for a
  // userinfo scope purely to learn who connected.
  let email: string | null = null;
  try {
    const res = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (res.ok) email = ((await res.json()) as { id?: string }).id ?? null;
  } catch {
    // Non-fatal: the connection still works without a display email.
  }

  const googleAccountId = subjectFromIdToken(tokens.id_token) ?? email;
  if (!googleAccountId) {
    console.error("[oauth] could not determine the google account id");
    return done("failed", origin);
  }

  try {
    const { error } = await serviceClient()
      .from("connections")
      .upsert(
        {
          client_id: state.clientId,
          google_account_id: googleAccountId,
          email: email ?? googleAccountId,
          refresh_token_enc: encryptSecret(tokens.refresh_token),
          scopes: granted,
          status: "active",
          connected_at: new Date().toISOString(),
          last_error: null,
        },
        // Reconnecting the same account replaces the old grant rather than creating a
        // second row that quietly competes with it.
        { onConflict: "client_id,google_account_id" },
      );

    if (error) {
      console.error("[oauth] storing connection failed", error);
      return done("failed", origin);
    }
  } catch (err) {
    console.error("[oauth] storing connection threw", err);
    return done("failed", origin);
  }

  return done("ok", origin);
}
