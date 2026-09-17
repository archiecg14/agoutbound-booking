-- Slot granularity per event type.
--
-- It was a constant (15 minutes) shared by every event type, which is wrong in both
-- directions: a 15-minute triage call wants tighter spacing, and an hour-long deep dive
-- offering a start every quarter hour produces a wall of near-identical options that is
-- harder to choose from, not easier.
--
-- Defaulted to 15 so existing rows keep the behaviour they already had.

alter table event_types
  add column slot_interval_min int not null default 15
    check (slot_interval_min between 5 and 120);

comment on column event_types.slot_interval_min is
  'Minutes between candidate start times, anchored to the start of each working block.';
