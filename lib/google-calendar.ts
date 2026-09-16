/**
 * Google Calendar access for a connected account.
 *
 * NOT YET RUN AGAINST A REAL GOOGLE RESPONSE. Written from the API reference; the shapes
 * here are unverified until the OAuth spike exists. Treat every field name as a claim.
 *
 * The refresh flow matters more than it looks. An unverified app in "production" gets
 * normal long-lived refresh tokens, but a grant can still be revoked by the user at any
 * time, and the same code path runs for a client who has simply removed access. So a
 * failed refresh is not an exception to bubble — it is a state transition on the
 * connection, which the operator has to be able to see. See SPEC.md §5, decision 6.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FREEBUSY_URL = "https://www.googleapis.com/calendar/v3/freeBusy";
const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export type Connection = {
  id: string;
  refreshToken: string;
};

export class ConnectionNeedsReconsent extends Error {
  // Not a TS parameter property — Node's strip-only TypeScript mode cannot emit those, and
  // the test suite runs these files directly with no build step.
  readonly connectionId: string;

  constructor(connectionId: string, cause?: unknown) {
    super(`connection ${connectionId} needs reconsent`);
    this.name = "ConnectionNeedsReconsent";
    this.connectionId = connectionId;
    this.cause = cause;
  }
}

/** Exchange a refresh token for a short-lived access token. */
export async function accessTokenFor(conn: Connection): Promise<string> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("GOOGLE_CLIENT_ID/SECRET not set");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: conn.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  // 400 invalid_grant is the revoked/expired case, and it is the one that must not be
  // treated as a transient failure — retrying it forever hides a client who has
  // disconnected.
  if (res.status === 400 || res.status === 401) {
    throw new ConnectionNeedsReconsent(conn.id, await res.text());
  }
  if (!res.ok) throw new Error(`token refresh failed: ${res.status} ${await res.text()}`);

  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("token refresh returned no access_token");
  return json.access_token;
}

/** Busy intervals on the account's primary calendar, as UTC ISO strings. */
export async function getFreeBusy(
  conn: Connection,
  fromIso: string,
  toIso: string,
): Promise<{ start: string; end: string }[]> {
  const token = await accessTokenFor(conn);

  const res = await fetch(FREEBUSY_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ timeMin: fromIso, timeMax: toIso, items: [{ id: "primary" }] }),
  });
  if (!res.ok) throw new Error(`freebusy failed: ${res.status} ${await res.text()}`);

  const json = (await res.json()) as {
    calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }>;
  };

  const cal = json.calendars?.primary;
  // A per-calendar `errors` array means Google answered 200 with a partial result. Treating
  // that as "no busy time" would cheerfully double-book someone, so it is an error here.
  if (cal?.errors?.length) {
    throw new Error(`freebusy returned calendar errors: ${JSON.stringify(cal.errors)}`);
  }
  return cal?.busy ?? [];
}

export type CreatedEvent = { id: string; htmlLink?: string };

export async function createEvent(
  conn: Connection,
  event: {
    summary: string;
    description?: string;
    startIso: string;
    endIso: string;
    attendeeEmail: string;
    attendeeName?: string;
    /** Our booking id, so a calendar event can always be traced back to a row. */
    idempotencyKey: string;
  },
): Promise<CreatedEvent> {
  const token = await accessTokenFor(conn);

  const res = await fetch(`${EVENTS_URL}?sendUpdates=all`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      // Not all Google endpoints honour this; the durable guard is the stored
      // google_event_id plus reconcile.py, not this header.
      "X-Goog-Request-Id": event.idempotencyKey,
    },
    body: JSON.stringify({
      summary: event.summary,
      description: event.description,
      start: { dateTime: event.startIso, timeZone: "UTC" },
      end: { dateTime: event.endIso, timeZone: "UTC" },
      attendees: [{ email: event.attendeeEmail, displayName: event.attendeeName }],
      extendedProperties: { private: { bookingId: event.idempotencyKey } },
    }),
  });

  if (!res.ok) throw new Error(`event insert failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as CreatedEvent;
  if (!json.id) throw new Error("event insert returned no id");
  return json;
}
