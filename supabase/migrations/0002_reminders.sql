-- Reminders.
--
-- A row per (booking, kind) rather than a job queue, because the unique constraint is what
-- makes double-sending impossible. A cron that overlaps itself, retries, or runs twice after
-- a deploy must not mean a prospect gets the same reminder three times — and "the code
-- checks first" is not a guarantee when two processes check at the same moment.

create type reminder_kind as enum ('day_before', 'hour_before', 'follow_up');
create type reminder_status as enum ('pending', 'sent', 'failed', 'skipped');

create table reminders (
  id           uuid primary key default gen_random_uuid(),
  booking_id   uuid not null references bookings(id) on delete cascade,
  kind         reminder_kind not null,
  /** When it becomes eligible to send. Computed from the booking, recomputed on reschedule. */
  due_at       timestamptz not null,
  status       reminder_status not null default 'pending',
  attempts     int not null default 0,
  last_error   text,
  sent_at      timestamptz,
  created_at   timestamptz not null default now(),

  -- The whole point. One reminder of each kind per booking, enforced by the database.
  unique (booking_id, kind)
);

-- The cron's only query: what is due and still pending.
create index reminders_due_idx on reminders (due_at) where status = 'pending';

alter table reminders enable row level security;
