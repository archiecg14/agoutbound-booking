-- Email confirmation for public bookings.
--
-- A per-lead link needs none of this: it was mailed to that address, so using it already
-- proves control of the mailbox. The public page proves nothing - anyone can type anyone's
-- address - so until the address answers, what we have is a HOLD, not a booking.
--
-- NOTE FOR WHOEVER RUNS THIS: if the SQL editor refuses the first statement with
-- "unsafe use of new value of enum type", run that one line on its own, then the rest.
-- Postgres will not let a new enum value be USED in the transaction that adds it; nothing
-- below uses it, but editors differ.

alter type booking_status add value if not exists 'pending';

alter table bookings
  -- SHA-256 of the confirmation token, never the token itself  -  the same rule link_tokens
  -- follows. A database leak cannot then be turned into working confirmation links.
  add column confirm_token_hash  text,
  -- When the hold stops blocking the slot. Expiry is applied where availability is
  -- computed, NOT by a sweeper: a cron job that silently stops running would freeze a
  -- client's calendar behind holds nobody can see.
  add column confirm_expires_at  timestamptz,
  add column confirmed_at        timestamptz;

comment on column bookings.confirm_token_hash is
  'SHA-256 of the emailed confirmation token. Null for link bookings, which need no confirmation.';
comment on column bookings.confirm_expires_at is
  'A pending hold blocks its slot until this moment, then stops mattering. Not swept.';

-- Unique so one token can never resolve to two rows. Postgres treats nulls as distinct in a
-- unique index, so every link booking can keep a null here.
create unique index bookings_confirm_token_idx on bookings (confirm_token_hash);

-- The lookup availability makes on every public page render.
create index bookings_hold_idx on bookings (connection_id, confirm_expires_at);

-- The overlap constraint is deliberately NOT widened to cover holds.
--
-- It stays the single absolute guarantee that two confirmed bookings cannot occupy one
-- slot. Holds are a softer thing: they expire by clock, and a constraint predicate cannot
-- read the clock. Two holds racing for one slot is therefore possible and is settled at the
-- moment they confirm, where this constraint - not application code - has the final say.
