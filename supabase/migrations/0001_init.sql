-- AG Outbound Booking — initial schema
-- Run against a fresh Supabase project. Idempotent where cheap; not designed to be re-run
-- over live data.
--
-- Two rules this file exists to enforce:
--   1. Supabase publishes every table over REST. RLS is ON for all of them and NO policies
--      are created, so only the service role reaches this data. Secrets and attribution
--      must never be one misconfigured anon key away from the public internet.
--   2. Instants are stored in UTC (timestamptz). Local scheduling rules are stored as a
--      wall-clock time plus an IANA zone. Mixing those two is the documented cause of
--      wrong-hour bookings in every incumbent.

create extension if not exists btree_gist;

-- ─────────────────────────────────────────────────────────────────────────────
-- clients
-- ─────────────────────────────────────────────────────────────────────────────
create table clients (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,          -- 'acme', 'northwind' — matches leadbuild config
  name        text not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- connections — one per connected Google account.
-- 'needs_reconsent' is a first-class state, not an error to swallow: unverified-app
-- tokens and revoked grants are normal operating conditions, and an operator has to be
-- able to see which client has gone dark before a prospect finds out for them.
-- ─────────────────────────────────────────────────────────────────────────────
create type connection_status as enum ('active', 'needs_reconsent', 'revoked', 'disabled');

create table connections (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid not null references clients(id) on delete restrict,
  google_account_id  text not null,          -- the 'sub' claim, stable across email changes
  email              text not null,
  refresh_token_enc  text not null,          -- encrypted application-side; never plaintext
  scopes             text[] not null,
  status             connection_status not null default 'active',
  connected_at       timestamptz not null default now(),
  last_ok_at         timestamptz,            -- last successful API call; staleness signal
  last_error         text,
  unique (client_id, google_account_id)
);

create index connections_status_idx on connections (status) where status <> 'active';

-- ─────────────────────────────────────────────────────────────────────────────
-- event_types
-- ─────────────────────────────────────────────────────────────────────────────
create table event_types (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null references clients(id) on delete restrict,
  connection_id    uuid not null references connections(id) on delete restrict,
  slug             text not null,
  name             text not null,
  description      text,
  duration_min     int  not null check (duration_min between 5 and 480),
  buffer_before    int  not null default 0 check (buffer_before >= 0),
  buffer_after     int  not null default 0 check (buffer_after  >= 0),
  min_notice_min   int  not null default 60 check (min_notice_min >= 0),
  date_range_days  int  not null default 30 check (date_range_days between 1 and 365),
  questions        jsonb not null default '[]'::jsonb,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  unique (client_id, slug)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- availability — recurring weekly rules, in the host's own wall-clock time.
-- start_local/end_local are TIME, not timestamptz, on purpose: "I work 9–5" must survive
-- a daylight-saving change without the hours moving.
-- ─────────────────────────────────────────────────────────────────────────────
create table availability_rules (
  id             uuid primary key default gen_random_uuid(),
  connection_id  uuid not null references connections(id) on delete cascade,
  weekday        int  not null check (weekday between 0 and 6),   -- 0 = Sunday
  start_local    time not null,
  end_local      time not null,
  timezone       text not null,                                    -- IANA, e.g. 'Europe/London'
  check (end_local > start_local)
);

create index availability_rules_conn_idx on availability_rules (connection_id);

-- Date-specific exceptions. kind='block' removes time, kind='open' adds it.
create table availability_overrides (
  id             uuid primary key default gen_random_uuid(),
  connection_id  uuid not null references connections(id) on delete cascade,
  on_date        date not null,
  kind           text not null check (kind in ('block', 'open')),
  start_local    time,
  end_local      time,
  timezone       text not null,
  note           text,
  check (kind = 'block' and start_local is null or start_local is not null),
  check (end_local is null or start_local is null or end_local > start_local)
);

create index availability_overrides_conn_date_idx on availability_overrides (connection_id, on_date);

-- ─────────────────────────────────────────────────────────────────────────────
-- link_tokens — the attribution channel, and the reason this project exists.
-- The raw token is NEVER stored. We keep a SHA-256 of it, so a database leak cannot be
-- turned into working booking links for real leads.
-- ─────────────────────────────────────────────────────────────────────────────
create table link_tokens (
  id             uuid primary key default gen_random_uuid(),
  token_hash     text not null unique,       -- sha256(raw token)
  event_type_id  uuid not null references event_types(id) on delete cascade,
  client_id      uuid not null references clients(id) on delete restrict,

  -- attribution payload, carried invisibly from the cold email to the booking
  lead_email     text not null,              -- the join key back to the master ledger
  lead_first     text,
  lead_last      text,
  lead_company   text,
  campaign_id    text,
  wave           text,
  sequence_step  int,

  expires_at     timestamptz not null,
  used_at        timestamptz,                -- non-null once booked; links are single-use
  created_at     timestamptz not null default now()
);

create index link_tokens_lead_idx    on link_tokens (lead_email);
create index link_tokens_expiry_idx  on link_tokens (expires_at) where used_at is null;

-- ─────────────────────────────────────────────────────────────────────────────
-- bookings
-- The attribution columns are duplicated here rather than joined through link_tokens on
-- purpose: a booking's provenance must survive the token being expired, rotated or purged.
-- ─────────────────────────────────────────────────────────────────────────────
create type booking_status as enum ('confirmed', 'cancelled', 'rescheduled', 'no_show');

create table bookings (
  id               uuid primary key default gen_random_uuid(),
  event_type_id    uuid not null references event_types(id) on delete restrict,
  connection_id    uuid not null references connections(id) on delete restrict,
  client_id        uuid not null references clients(id) on delete restrict,
  link_token_id    uuid references link_tokens(id) on delete set null,

  lead_email       text,
  campaign_id      text,
  wave             text,
  sequence_step    int,

  attendee_name    text not null,
  attendee_email   text not null,
  attendee_tz      text not null,            -- IANA, resolved from the browser, never assumed UTC
  answers          jsonb not null default '{}'::jsonb,

  start_utc        timestamptz not null,
  end_utc          timestamptz not null,
  status           booking_status not null default 'confirmed',

  google_event_id  text,                     -- null until the calendar write succeeds
  google_synced_at timestamptz,

  ledger_synced_at timestamptz,              -- null = reconcile.py should still pick it up

  created_at       timestamptz not null default now(),
  cancelled_at     timestamptz,
  rescheduled_from uuid references bookings(id) on delete set null,

  check (end_utc > start_utc)
);

create index bookings_lead_idx     on bookings (lead_email);
create index bookings_since_idx    on bookings (created_at desc);
create index bookings_unsynced_idx on bookings (ledger_synced_at) where ledger_synced_at is null;
create index bookings_ungoogled_idx on bookings (google_event_id) where google_event_id is null;

-- Double-booking is prevented by the database, not by application logic. Two confirmed
-- bookings on one connection cannot overlap, whatever the API layer believes.
alter table bookings add constraint bookings_no_overlap
  exclude using gist (
    connection_id with =,
    tstzrange(start_utc, end_utc, '[)') with &&
  ) where (status = 'confirmed');

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS: on everywhere, no policies. Service role only.
-- Adding a policy here is a deliberate decision to publish that table. Do not add one
-- casually to make a client-side query work.
-- ─────────────────────────────────────────────────────────────────────────────
alter table clients                enable row level security;
alter table connections            enable row level security;
alter table event_types            enable row level security;
alter table availability_rules     enable row level security;
alter table availability_overrides enable row level security;
alter table link_tokens            enable row level security;
alter table bookings               enable row level security;
