# Setup

From nothing to a booking you made yourself. Roughly an hour, most of it waiting on consoles.

Every variable listed here was read out of the source rather than remembered — if the code
stops reading one, this file is wrong and should be corrected.

---

## Read this first

**Two keys, and the difference matters.** `SIGNING_KEY` is the HMAC key behind connect
invites, OAuth state, manage tokens and operator sessions — it never leaves the server.
`LINKS_API_KEY` is only the bearer token for `POST /api/links`, and it is the one you hand
to the lead-build tooling. Keeping them separate is why a script that can mint booking links
cannot also forge a manage token for someone else's booking or sign itself an operator
session. Do not set them to the same value, and there is deliberately no fallback from one
to the other — a fallback lets you believe they are separated when they are not.

**Rotating `SIGNING_KEY` has a blast radius.** Every manage link already sitting in a
prospect's calendar invitation stops working, and every operator session is signed out.
Rotate it if it leaks; otherwise leave it alone.

**`TOKEN_ENCRYPTION_KEY` is not recoverable.** Lose it and every connected calendar has to
reconnect, because the stored refresh tokens can no longer be decrypted. Put it somewhere
durable before you connect a real client.

**The Supabase service role key bypasses row-level security.** Every table in this app has
RLS on with no policies, so that key is the only way in — and it is complete read/write
access to every client's contact data. Treat it like a database password, because it is one.

---

## 1. Supabase

1. Create a project at supabase.com.
2. Project settings → API. Copy the **Project URL** into `SUPABASE_URL` and the
   **service_role** key into `SUPABASE_SERVICE_ROLE_KEY`. Not the anon key — the anon key
   respects RLS and will see nothing.
3. SQL editor → run `supabase/migrations/0001_init.sql`, then `0002_reminders.sql`, in that
   order. The second references tables the first creates.
4. Seed one client row, because nothing resolves without it:

   ```sql
   insert into clients (slug, name) values ('mka', 'MKA Recruitment');
   ```

   The slug must match the `client` field in the leadbuild config
   (`~/.claude/skills/leadbuild/clients/mka.json`) — `reconcile.py` and `ledger-sync.py`
   both look the client up by it.

## 2. Google

The full click path is in this conversation; the short version:

1. **A dedicated Cloud project.** The unverified-app cap is 100 new grants for the lifetime
   of the project and cannot be reset, so dev and production get separate projects. Test
   accounts spent against production are gone permanently.
2. Enable the **Google Calendar API** on that project.
3. Google Auth Platform → **Branding** (fill it in first; Audience will not let you publish
   until it is complete) → **Audience** (User type: External) → **Data access** (add
   `calendar.freebusy` and `calendar.events`; both land under sensitive, which is expected
   and triggers no security assessment).
4. **Clients → Create client → Web application.** Authorised redirect URI must match
   `GOOGLE_REDIRECT_URI` exactly — scheme, host, port, path. A mismatch fails with
   `redirect_uri_mismatch` and nothing else.
5. Copy the client ID and secret.

Do not ship on "Testing" publishing status: it issues refresh tokens that expire after seven
days, so every client would have to reconnect weekly.

## 3. Generate the secrets

```bash
node -e "console.log('TOKEN_ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('base64'))"
```

```bash
node -e "for (const k of ['SIGNING_KEY','LINKS_API_KEY','CRON_SECRET']) console.log(k + '=' + require('crypto').randomBytes(32).toString('base64url'))"
```

Three different values. Reusing one across all three defeats the separation.

`OPS_PASSWORD` you choose — 12 characters minimum. Anything shorter, or unset, and the
operator surface refuses every login rather than falling open.

## 4. Fill in `.env.local`

```bash
cp .env.example .env.local
```

Then edit it. `.env.local` is gitignored. Nothing here may carry a `NEXT_PUBLIC_` prefix —
that inlines the value into the browser bundle, which for any of these means publishing it.

## 5. Run it

```bash
npm install && npm run dev
```

Check the pieces in this order, because each one depends on the last:

| Step | What you do | It worked when |
|---|---|---|
| 1 | Open `/ops` | You get the login, and the password signs you in |
| 2 | Connect a calendar via `/api/oauth/start?invite=…` | `/ops` shows the account with a green **active** pill |
| 3 | `POST /api/ops/availability` with a week of rules | No error, and step 5 returns slots |
| 4 | `POST /api/ops/event-types` | The event type appears on `/ops` |
| 5 | `POST /api/links` with one lead | You get a `/b/<token>` URL back |
| 6 | Open the link and book yourself | The call appears in the real calendar |
| 7 | `python3 scripts/reconcile.py <client.json>` | Exit 0 and "Clean" |

The invite for step 2 is generated by `makeInvite(clientId)` in `lib/oauth.ts`, signed with
`SIGNING_KEY`.

Step 7 is the one that actually proves it. Steps 1 to 6 can all appear to work while the
ledger and the calendar quietly disagree.

## 6. Deploying

Set the same variables in the host's environment, and change two of them:

- `APP_BASE_URL` → your real origin. This builds the booking links you send to prospects and
  the manage links inside calendar invitations. Left on localhost, you ship dead links.
- `GOOGLE_REDIRECT_URI` → the deployed callback, added to the OAuth client's authorised
  list as well.

Point a scheduler at `POST /api/cron/reminders` every 15 minutes with
`Authorization: Bearer $CRON_SECRET`. It is safe to run often and safe to run twice — the
unique `(booking_id, kind)` constraint decides the race, not the code.

## Every variable

| Variable | Required | Missing means |
|---|---|---|
| `SUPABASE_URL` | yes | Nothing works |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Nothing works |
| `GOOGLE_CLIENT_ID` | yes | No connecting, no calendar |
| `GOOGLE_CLIENT_SECRET` | yes | No connecting, no calendar |
| `GOOGLE_REDIRECT_URI` | yes | Consent fails with `redirect_uri_mismatch` |
| `TOKEN_ENCRYPTION_KEY` | yes | Connecting throws; unrecoverable if lost later |
| `SIGNING_KEY` | yes | Every signed token fails: connecting, managing, `/ops` |
| `LINKS_API_KEY` | yes | `POST /api/links` refuses all requests |
| `APP_BASE_URL` | yes | Links cannot be built; manage links vanish from invites |
| `OPS_PASSWORD` | yes | `/ops` refuses all logins (fails closed) |
| `CRON_SECRET` | yes | Reminder cron refuses all requests (fails closed) |
| `RESEND_API_KEY` | no | Reminders recorded as `skipped`, never sent |
| `REMINDER_FROM` | no | Same |
| `COLD_EMAIL_DOMAINS` | no | The guard stopping reminders sending from an outreach domain is off |
| `GOOGLE_ACCESS_TOKEN` | no | `reconcile.py` reports check 3 as SKIPPED, not passed |
