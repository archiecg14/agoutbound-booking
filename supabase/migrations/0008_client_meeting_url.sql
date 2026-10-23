-- Where the call actually happens.
--
-- Until now a booking produced a calendar invitation with a time and no way to join it.
-- This is the link that goes in that invitation, the "you're booked" page and every
-- reminder, so a prospect who has booked always knows where to turn up.
--
-- Per client, for the same reason as fallback_url: each client runs their own calls, and
-- one shared value would send one client's prospects into another client's meeting room.
--
-- Nullable on purpose. A client without one gets no join line at all rather than a
-- placeholder, which is the correct behaviour until they tell us where their calls are.

alter table clients add column if not exists meeting_url text;

alter table clients drop constraint if exists clients_meeting_url_is_https;

alter table clients add constraint clients_meeting_url_is_https
  check (meeting_url is null or meeting_url ~ '^https://[^[:space:]]+$');

comment on column clients.meeting_url is
  'Absolute https join link (e.g. a Zoom personal room) put on every booking. NULL adds nothing.';
