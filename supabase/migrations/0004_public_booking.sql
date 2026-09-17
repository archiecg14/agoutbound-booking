-- Public booking.
--
-- Two additions, and the first is the important one.

-- An event type is NOT publicly bookable just because it exists. Every event type built so
-- far is reached through a per-lead link, and quietly exposing those on a public URL would
-- turn a client's private outreach calendar into an open one. Opt in, never opt out.
alter table event_types
  add column is_public boolean not null default false;

comment on column event_types.is_public is
  'Bookable at /book/<client>/<event> with no link token. Default false, deliberately.';

-- A public page has no token gate, so the only thing standing between a stranger and your
-- whole calendar is this. Recorded per booking so the limiter reads real history rather
-- than trusting memory that dies with the process.
alter table bookings
  add column source text not null default 'link'
    check (source in ('link', 'public')),
  add column created_ip text;

comment on column bookings.created_ip is
  'Truncated client IP, for rate limiting public bookings only. Not used for link bookings.';

create index bookings_public_rate_idx
  on bookings (created_ip, created_at)
  where source = 'public';

create index bookings_email_future_idx
  on bookings (event_type_id, attendee_email, start_utc)
  where status = 'confirmed';
