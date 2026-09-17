#!/usr/bin/env python3
"""Prove that bookings, the ledger and the calendar agree. Read-only; writes nothing.

    reconcile.py <client.json> [--json out.json] [--no-calendar]
    reconcile.py --self-test

Exit 0 only when every check passes. Any mismatch exits 1, because a reconciliation that
reports a problem and exits 0 is a reconciliation nobody will ever act on.

The four checks:

  1. every confirmed booking has a ledger row          (a booked call nobody is tracking)
  2. every 'booked' ledger row has a booking           (a ledger claiming a call that
                                                        does not exist)
  3. every booking with a google_event_id has that     (a call the client cannot see in
     event live on the calendar                         their own calendar)
  4. every confirmed booking has a google_event_id     (written but never synced)

Nothing here is read from memory or from a previous run: the ledger comes off disk, the
bookings out of the database, and the calendar out of Google, every time.

DEPENDENCY: check 2 needs the ledger to carry the 'booked' state and a booking_uid column.
Until leadbuild/scripts/schemas.py is extended, this script reports the ledger as
un-migrated and skips that check rather than pretending it passed.
"""

import argparse
import csv
import json
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

LEDGER_BOOKED_STATE = "booked"
LEDGER_UID_COLUMN = "booking_uid"

# Cloudflare sits in front of several of these APIs and rejects python-urllib's default
# agent with a 403 that is indistinguishable from a dead key. Learned the hard way; see
# the campaign-check skill.
UA = "agoutbound-reconcile/1.0"


# ── the comparison, as a pure function ──────────────────────────────────────────────────

def reconcile(ledger_rows, bookings, calendar_event_ids, ledger_migrated=True):
    """Compare three already-fetched views. Returns (findings, counts).

    ledger_rows        list of dicts straight from the master CSV
    bookings           list of dicts: id, lead_email, status, google_event_id
    calendar_event_ids set of event ids currently live on the calendar, or None if the
                       calendar was not read this run
    """
    findings = []

    confirmed = [b for b in bookings if b.get("status") == "confirmed"]
    ledger_by_email = {}
    for r in ledger_rows:
        email = (r.get("email") or "").strip().lower()
        if email:
            ledger_by_email.setdefault(email, []).append(r)

    # 1. Every confirmed booking must be represented in the ledger.
    for b in confirmed:
        email = (b.get("lead_email") or "").strip().lower()
        if not email:
            findings.append(("booking_without_email", b.get("id"), "booking has no lead_email"))
        elif email not in ledger_by_email:
            findings.append(("booking_not_in_ledger", b.get("id"), email))

    # 2. Every ledger row claiming a booking must have one.
    if ledger_migrated:
        booking_ids = {b.get("id") for b in bookings}
        for r in ledger_rows:
            if (r.get("state") or "").strip() != LEDGER_BOOKED_STATE:
                continue
            uid = (r.get(LEDGER_UID_COLUMN) or "").strip()
            if not uid:
                findings.append(("ledger_booked_without_uid", r.get("email"), "state=booked, no booking_uid"))
            elif uid not in booking_ids:
                findings.append(("ledger_uid_not_found", r.get("email"), uid))

    # 3 and 4. Calendar agreement.
    unsynced = [b for b in confirmed if not b.get("google_event_id")]
    for b in unsynced:
        findings.append(("booking_never_synced", b.get("id"), "no google_event_id"))

    if calendar_event_ids is not None:
        for b in confirmed:
            eid = b.get("google_event_id")
            if eid and eid not in calendar_event_ids:
                findings.append(("event_missing_from_calendar", b.get("id"), eid))

    counts = {
        "bookings_total": len(bookings),
        "bookings_confirmed": len(confirmed),
        "ledger_rows": len(ledger_rows),
        "ledger_booked_rows": sum(
            1 for r in ledger_rows if (r.get("state") or "").strip() == LEDGER_BOOKED_STATE
        ),
        "calendar_events": None if calendar_event_ids is None else len(calendar_event_ids),
        "unsynced": len(unsynced),
        "findings": len(findings),
    }
    return findings, counts


# ── live reads ──────────────────────────────────────────────────────────────────────────

def _get(url, headers):
    req = urllib.request.Request(url, headers={**headers, "User-Agent": UA})
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=30, context=ctx) as res:
        return json.loads(res.read().decode("utf-8"))


def read_ledger(path):
    """Straight off disk, every run. A cached ledger is not a ledger."""
    path = os.path.expanduser(path)
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
        migrated = LEDGER_UID_COLUMN in (reader.fieldnames or [])
    return rows, migrated



def resolve_client_id(slug):
    """Map the config's client slug to the clients.id UUID that bookings are keyed by.

    The client config carries `client` (e.g. "mka"), while bookings.client_id is a UUID
    foreign key. Filtering bookings by the slug would match nothing and report a perfectly
    clean, entirely fictional result -- the worst possible failure for a checker.
    """
    import urllib.parse, urllib.request, ssl
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise SystemExit("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set")
    q = urllib.parse.urlencode({"select": "id", "slug": f"eq.{slug}"})
    req = urllib.request.Request(
        f"{url.rstrip('/')}/rest/v1/clients?{q}",
        headers={"apikey": key, "Authorization": f"Bearer {key}", "User-Agent": UA},
    )
    with urllib.request.urlopen(req, timeout=30, context=ssl.create_default_context()) as res:
        rows = json.loads(res.read().decode("utf-8"))
    if not rows:
        raise SystemExit(f"no client row with slug '{slug}' -- has it been seeded?")
    return rows[0]["id"]

def read_bookings(client_id):
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise SystemExit("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set")

    q = urllib.parse.urlencode(
        {
            "select": "id,lead_email,status,google_event_id,start_utc",
            "client_id": f"eq.{client_id}",
        }
    )
    return _get(
        f"{url.rstrip('/')}/rest/v1/bookings?{q}",
        {"apikey": key, "Authorization": f"Bearer {key}"},
    )


def read_calendar_event_ids(access_token, time_min, time_max):
    """Live event ids on the primary calendar, following pagination to the end.

    Stopping at the first page would silently treat every event past it as missing, which
    turns a working system into a wall of false findings.
    """
    ids = set()
    page = None
    while True:
        params = {
            "timeMin": time_min,
            "timeMax": time_max,
            "singleEvents": "true",
            "maxResults": "2500",
            "showDeleted": "false",
        }
        if page:
            params["pageToken"] = page
        data = _get(
            "https://www.googleapis.com/calendar/v3/calendars/primary/events?"
            + urllib.parse.urlencode(params),
            {"Authorization": f"Bearer {access_token}"},
        )
        for item in data.get("items", []):
            if item.get("id"):
                ids.add(item["id"])
        page = data.get("nextPageToken")
        if not page:
            return ids


# ── self-test: prove the script before trusting it ──────────────────────────────────────

def self_test():
    """A checker that has never been shown to fail is not a checker.

    Runs the comparison against a known-good set (expects silence) and a known-bad set
    (expects one finding of each kind, by name).
    """
    good_ledger = [
        {"email": "a@x.com", "state": "booked", "booking_uid": "b1"},
        {"email": "b@x.com", "state": "loaded", "booking_uid": ""},
    ]
    good_bookings = [
        {"id": "b1", "lead_email": "a@x.com", "status": "confirmed", "google_event_id": "g1"},
    ]
    findings, counts = reconcile(good_ledger, good_bookings, {"g1"})
    assert findings == [], f"known-good produced findings: {findings}"
    assert counts["bookings_confirmed"] == 1, counts

    bad_ledger = [
        {"email": "a@x.com", "state": "booked", "booking_uid": "b1"},
        {"email": "ghost@x.com", "state": "booked", "booking_uid": "does-not-exist"},
        {"email": "noref@x.com", "state": "booked", "booking_uid": ""},
    ]
    bad_bookings = [
        {"id": "b1", "lead_email": "a@x.com", "status": "confirmed", "google_event_id": "gone"},
        {"id": "b2", "lead_email": "stranger@x.com", "status": "confirmed", "google_event_id": "g2"},
        {"id": "b3", "lead_email": "a@x.com", "status": "confirmed", "google_event_id": None},
    ]
    findings, _ = reconcile(bad_ledger, bad_bookings, {"g2"})
    kinds = {f[0] for f in findings}
    for expected in (
        "booking_not_in_ledger",
        "ledger_uid_not_found",
        "ledger_booked_without_uid",
        "booking_never_synced",
        "event_missing_from_calendar",
    ):
        assert expected in kinds, f"known-bad did not report {expected}: {sorted(kinds)}"

    # An un-migrated ledger must skip check 2 rather than report every row as broken.
    findings, _ = reconcile(
        [{"email": "a@x.com", "state": "loaded"}], [], None, ledger_migrated=False
    )
    assert findings == [], f"un-migrated ledger should be quiet, got {findings}"

    print("self-test: PASS — known-good is silent, known-bad reports all five kinds")
    return 0


# ── entry point ─────────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("client_json", nargs="?")
    ap.add_argument("--json", dest="json_out")
    ap.add_argument("--no-calendar", action="store_true", help="skip the live calendar read")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()

    if args.self_test:
        return self_test()
    if not args.client_json:
        ap.error("client_json is required unless --self-test is given")

    with open(os.path.expanduser(args.client_json), encoding="utf-8") as f:
        cfg = json.load(f)

    ledger_rows, migrated = read_ledger(cfg["ledger"])
    bookings = read_bookings(resolve_client_id(cfg["client"]))

    calendar_ids = None
    if not args.no_calendar:
        token = os.environ.get("GOOGLE_ACCESS_TOKEN")
        if not token:
            print("NOTE: GOOGLE_ACCESS_TOKEN not set — calendar checks SKIPPED", file=sys.stderr)
        else:
            starts = [b["start_utc"] for b in bookings if b.get("start_utc")]
            if starts:
                calendar_ids = read_calendar_event_ids(token, min(starts), max(starts))

    findings, counts = reconcile(ledger_rows, bookings, calendar_ids, ledger_migrated=migrated)

    print(json.dumps(counts, indent=2))
    if not migrated:
        print(
            f"\nNOTE: ledger has no '{LEDGER_UID_COLUMN}' column — check 2 SKIPPED, not passed.",
            file=sys.stderr,
        )
    if calendar_ids is None:
        print("NOTE: calendar not read — check 3 SKIPPED, not passed.", file=sys.stderr)

    for kind, subject, detail in findings:
        print(f"MISMATCH {kind}: {subject} — {detail}", file=sys.stderr)

    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as f:
            json.dump({"counts": counts, "findings": findings}, f, indent=2)

    if findings:
        print(f"\n{len(findings)} mismatch(es). NOT clean.", file=sys.stderr)
        return 1

    print("\nClean — bookings, ledger and calendar agree.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
