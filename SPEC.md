# AG Outbound Booking — build spec

Status: DRAFT for build. Written 16 Sep 2026. Research-backed; every constraint below
came from a source read this session, not from memory. Items marked UNVERIFIED have not
been confirmed and must not be designed around as facts.

---

## 1. Outcome

Every call booked out of a cold-email campaign lands in the client's real calendar **and**
in the AG Outbound master ledger, carrying the lead, campaign, wave and sequence step that
produced it — with nobody retyping anything.

**Done means:** a prospect books from a per-lead link, and within seconds the matching
ledger row moves to `booked` with the calendar event id stamped on it. Proven by
`reconcile.py`, which reads the ledger and the calendar **live** and prints matched /
unmatched counts, exiting non-zero on any mismatch. Not "it ran" — the counts.

## 2. Non-goals

Workspaces, member roles and permissions. Stripe or any payment. A settings UI beyond what
one operator needs. Replacing the cal.com instance on the AG Outbound website. Anything
touching deliverability — separate track, deliberately out of scope.

## 3. Hard constraints (from research, do not re-litigate in build)

1. **The unverified-app cap is 100 new user grants for the lifetime of the Google Cloud
   project, and cannot be reset.** Dev and production get **separate Cloud projects** from
   day one. Burning the cap on test accounts permanently poisons that project.
2. **Never ship on OAuth "Testing" status.** External + Testing issues refresh tokens that
   expire in 7 days, which breaks background availability polling weekly and forces every
   client to reconsent. Ship on **production, unverified**.
3. **Per-user OAuth only. No domain-wide delegation.** Google recommends against it, it
   needs each client's super admin, it grants the service account access to the whole
   domain including super-admins, and it does not work for consumer Gmail accounts.
4. **Primary calendar, decided.** Events go on the client's primary calendar, so the
   `calendar.app.created` scope is not sufficient. Sensitive scopes, no security
   assessment, no fee — Calendar scopes are sensitive, never restricted.
5. **Only client staff ever connect a calendar.** Prospects booking do NOT consent to
   anything. This is what keeps the 100-grant cap comfortable.
6. **Attribution must not ride in visible URL parameters.** Both incumbents lose data this
   way: capped values, visible to the prospect, and destroyed by any navigation hop.
7. **Mobile-first is a requirement, not a preference.** Cold email is opened on a phone,
   and embed height is the incumbent's own admitted top cause of invitee confusion.
8. **Confirmation-email deliverability is a first-class design concern**, not an
   afterthought. A spam-filtered confirmation is a no-show.

## 4. Architecture

- **App:** Next.js on Vercel. Chosen for unlimited deploys under active development; the
  Netlify free plan caps production deploys at roughly 20/month across all sites.
- **Data:** Supabase Postgres. Gives a REST layer over the tables on day one, which is most
  of "usable as an API" solved by the data-layer choice.
- **Calendar:** Google Calendar API, per-user OAuth, one stored refresh token per connected
  account.
- **Ledger:** the existing per-client master CSV, written only through
  `leadbuild/scripts/schemas.py`. Never write the ledger directly from the app.

## 5. Data model

**The schema lives in `supabase/migrations/0001_init.sql` and that file is authoritative.**
Do not restate columns here — two copies drift and the prose always loses.

Tables: `clients`, `connections`, `event_types`, `availability_rules`,
`availability_overrides`, `link_tokens`, `bookings`.

Six decisions the SQL encodes, which are the parts worth arguing about:

1. **RLS on every table, zero policies.** Supabase publishes every table over REST, so the
   default must be that only the service role reaches it. Adding a policy is a deliberate
   decision to publish that table, never a quick fix to make a client-side query work.
2. **Instants in UTC (`timestamptz`); scheduling rules as wall-clock `time` + IANA zone.**
   "I work 9–5" must survive a daylight-saving change without the hours moving. Mixing the
   two is the documented cause of wrong-hour bookings in both incumbents.
3. **The raw link token is never stored** — only `sha256(token)`. A database leak must not
   be convertible into working booking links for real leads.
4. **Attribution columns are duplicated onto `bookings`** rather than joined through
   `link_tokens`. A booking's provenance has to survive its token being expired or purged.
5. **Double-booking is prevented by a Postgres exclusion constraint**, not by application
   logic — two confirmed bookings on one connection cannot overlap, whatever the API layer
   believes.
6. **`connection_status` includes `needs_reconsent`.** Revoked and expired grants are
   normal operating conditions; the operator must see which client has gone dark before a
   prospect does.

`attendee_tz` is captured from the browser and stored explicitly. Never default a missing
timezone to UTC — that is precisely how the incumbents produce 2am bookings.

## 6. Attribution design

`POST /links` mints a signed opaque token per lead and returns a URL. The token resolves
server-side to the lead payload; the prospect sees an unguessable string and nothing else.
This is deliberately the one thing neither incumbent offers: an invisible, arbitrary,
tamper-evident payload that survives navigation and arrives intact in the webhook.

Tokens are single-purpose and expiring. A tampered or expired token renders a plain "this
link has expired" page, never a stack trace and never a generic booking page.

## 7. API contract

```
POST /api/links          → { url, token }        mint a per-lead booking link
GET  /api/availability   ?event_type&from&to     → slots, computed against live freebusy
POST /api/bookings       → creates booking + calendar event, returns booking
GET  /api/bookings       ?since=                 → poll for new/changed bookings
POST /api/webhooks/test  → echo, for wiring the ledger writer
```

Emitted events: `booking.created`, `booking.cancelled`, `booking.rescheduled`,
`booking.no_show`. Each carries the full attribution payload at the top level, not nested
in a metadata blob that may or may not survive.

## 8. Ledger integration

The ledger schema is fixed and enforced. Live files and `schemas.py` agree on 16 columns
(verified 16 Sep 2026). Valid states are a closed set:
`loaded, warm, warm-pool, reserve, parked-gateway, suppressed`.

Required change, to be made in `schemas.py` and nowhere else:
- add `booked` and `no-show` to `LEDGER_STATES`
- add columns `booking_uid`, `booked_at`
- the merge guard — which refuses any write that drops an email or lowers the suppressed
  count — must remain intact, and `smoke-test.sh` must still pass afterwards

Adding columns only adds empty cells to existing rows, so the guard should pass. **Prove
that with the smoke suite; do not assert it.**

## 9. Build order

1. Google OAuth spike in a **throwaway dev Cloud project** — consent, then read freebusy on
   a second account. Kills or confirms the model before any UI exists.
2. Repo, Supabase project, schema above, production Cloud project created but untouched.
3. Core API: availability, bookings, polling.
4. Link minting and token verification.
5. Calendar write-back, google_event_id stored on the booking.
6. `schemas.py` change + ledger writer + `reconcile.py`.
7. Booking page, mobile-first, built against a phone viewport from the first commit.
8. Deploy, then an agent swarm against the API contract, then a human pass on the booking
   page — the swarm does not experience the page the way a person does.

## 10. Verification gate

The build is not done when bookings work. It is done when `reconcile.py` reads the ledger
and the calendar live and proves every booking has a ledger row and every `booked` ledger
row has a real calendar event, printed as counts and exiting non-zero on mismatch. Same
shape as `leadbuild/scripts/verify-list.py`, which is the model to copy.

Before trusting it, prove the script itself against a known-good and a known-bad case.

## 11. Open / UNVERIFIED

- Whether `calendar.freebusy` alone is classed sensitive or non-sensitive. Moot in
  practice — writing events needs a sensitive scope regardless.
- Whether a client admin marking the app "Trusted" lifts the 100-grant project cap. No
  documentation says it does. **Do not assume it.**
- Whether domain-wide delegation sidesteps verification. Not applicable, we are not using it.
- Verification turnaround: Google's own pages quote 3–5 and 10 business days. Budget the
  longer one.
- Booking-page conversion statistics in circulation trace to vendor marketing with no
  underlying study. Direction is sound; percentages are not citable.
