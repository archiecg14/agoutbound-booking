-- A place to send someone the calendar cannot help.
--
-- The booking page only ever offers the event type's date_range_days window. Someone who
-- is away for all of it has no move except closing the tab, and a prospect who closes the
-- tab is gone. This column is where that person is sent instead.
--
-- Per client, not per deployment: every client's booking page has to point at that
-- client's own site. A single shared value would put one client's prospects in front of
-- another client's enquiry form.
--
-- Nullable on purpose. A client without one renders no line at all, which is the correct
-- behaviour for a client who has not told us where to send people.

alter table clients add column if not exists fallback_url text;

comment on column clients.fallback_url is
  'Absolute https URL shown to prospects who cannot find a workable slot. NULL renders nothing.';
