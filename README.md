# AG Outbound Booking

A booking system for cold-outreach campaigns. A prospect clicks a personalised link, picks a
slot, and the call lands in the client's real Google Calendar — with the lead, campaign, wave
and sequence step that produced it carried through to the ledger. Nobody retypes anything.

Built and run solo. It backs a live outbound operation rather than a demo.

---

## What it does

Two booking paths, deliberately different in how much they trust the visitor.

**Per-lead link** — `/b/<token>`. The token identifies a known lead from a campaign, so the
booking is attributed and confirmed immediately. Single-use: consumed the moment it books.

**Public page** — `/book/<client>/<event>`. Anyone can reach it, so nothing is trusted. The
request is validated, rate-limited, and the slot is only held. A confirmation email goes out,
and the booking is not real until the visitor opens the link in it. Until then there is no
calendar event and no invitation — a stranger must not be able to put a meeting in someone
else's calendar, or make the client's account email an address nobody has verified.

Afterwards, `/m/<token>` lets the attendee reschedule or cancel without an account, and two
scheduled functions sweep for due reminders and reconcile bookings against the live calendar.

---

## Engineering decisions worth a look

**Double-booking is prevented by the database, not the application.**
`supabase/migrations/0001_init.sql` — two confirmed bookings on one calendar cannot overlap,
enforced by a Postgres exclusion constraint using `btree_gist`. Checking availability and then
inserting leaves a window between the check and the write; under concurrency something
eventually lands in it. A constraint closes that window atomically, whatever the API layer
believes.

**Row-level security is on with no policies, so the database denies by default.**
`lib/supabase.ts` — every table has RLS enabled and no policy grants access, which means the
service-role key is the only way in. Adding a policy is therefore a deliberate act of
publishing a table, not a default.

**Refresh tokens are encrypted at rest.**
`lib/crypto.ts` — AES-256-GCM with a versioned envelope (`v1.<iv>.<ciphertext>.<tag>`), so the
scheme can be rotated without guessing what old rows contain. Authenticated encryption, so a
tampered value fails loudly instead of decrypting to something plausible. A refresh token is a
long-lived key to a client's calendar and outlives their password; the database's own at-rest
encryption stops helping the moment someone holds a service key or a backup.

**It fails closed.**
Missing configuration refuses the request rather than skipping the check. An unset operator
password locks everyone out; an unset cron secret rejects every call; a failed rate-limit
query returns 503 rather than treating "we could not count" as "zero". That last one was a
real bug — `count ?? 0` turned a database error into a passing limit check on the one endpoint
a stranger can reach. `lib/availability-failclosed.test.ts` exists so it cannot come back.

---

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind 4 · Supabase (Postgres) ·
Google Calendar via OAuth · Resend for transactional mail · Netlify, with scheduled functions.

`app/` is routing and rendering only — 9 pages and 14 API routes. The rules live in `lib/`
(21 modules), so they are testable without HTTP, a database or a clock: `decideBooking` takes
the rows and `now` as arguments and returns a decision, and the route translates that decision
into a status code.

---

## Running it

```bash
npm install
cp .env.example .env.local   # then fill it in — see SETUP.md
npm run dev
```

`.env.example` documents every variable and what breaks without it. No value in this repo is
a real credential.

## Tests

```bash
npm test
```

154 tests across 15 files, colocated next to the modules they cover, on Node's built-in test
runner. They need no database, no network and no API keys — paid credentials stay unset inside
the harness on purpose, so a gate that only passes on a credentialled machine never reaches
production.

---

## How it was built

Written with Claude Code, one agent session at a time. `CLAUDE.md` and `AGENTS.md` are the
instruction sets those sessions worked from, and they are in the repo on purpose: deciding what
to build, how to verify it and what to refuse is the work. Every claim about live state was
read back from the source before it was believed — `reconcile.py` reads the ledger and the
calendar live, prints its counts, and marks any check it could not perform as SKIPPED rather
than passed, because "it ran" is not evidence.

## Scope

One client system, pre-revenue. Deliberately excluded: workspaces, roles and permissions,
payments, and anything touching email deliverability. `SPEC.md` records what was ruled out and
why, and marks anything unverified as unverified.
