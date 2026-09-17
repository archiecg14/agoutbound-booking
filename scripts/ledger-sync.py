#!/usr/bin/env python3
"""Move bookings into the client's master ledger. The only thing that writes booking state.

    ledger-sync.py <client.json> [--dry-run] [--json out.json]
    ledger-sync.py --self-test

Every write goes through leadbuild's schemas.write_rows with the anti-loss guard armed, so
a change that would drop a row or remove a suppression is refused rather than succeeding
quietly. Nothing here calls open(path, "w") on a ledger.

Three rules that are not negotiable, and are tested:

  1. A booking whose email is not in the ledger NEVER creates a row. The ledger is built by
     leadbuild from evidenced sources; inventing a row here would put an unevidenced contact
     into a client's list. It is reported instead, and reconcile.py sees the same gap.

  2. A SUPPRESSED row is never moved to booked. Someone who unsubscribed and then booked is
     a compliance event a human has to look at, not a state transition to apply silently.
     Suppression outranks everything.

  3. Cancelling does not restore the previous state, because the previous state was never
     stored. It sets 'warm' — they engaged enough to book once — and says so. That is a
     judgement call, recorded here rather than hidden in a diff.
"""

import argparse
import csv
import importlib.util
import json
import os
import sys

SCHEMAS_PATH = os.path.expanduser("~/.claude/skills/leadbuild/scripts/schemas.py")

STATE_BOOKED = "booked"
STATE_NO_SHOW = "no-show"
STATE_AFTER_CANCEL = "warm"
STATE_SUPPRESSED = "suppressed"


def load_schemas():
    """leadbuild's schemas.py is THE writer. Import it rather than reimplementing it."""
    spec = importlib.util.spec_from_file_location("schemas", SCHEMAS_PATH)
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot load {SCHEMAS_PATH}")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


# ── the transformation, pure ────────────────────────────────────────────────────────────

def apply_bookings(ledger_rows, bookings, now):
    """Return (rows, changes, findings). `rows` is a new list; inputs are not mutated.

    Idempotent by construction: it computes the target values for a row and only records a
    change when they differ from what is already there.
    """
    rows = [dict(r) for r in ledger_rows]
    by_email = {}
    for r in rows:
        e = (r.get("email") or "").strip().lower()
        if e:
            by_email.setdefault(e, []).append(r)

    changes, findings = [], []

    # Oldest first, so that when a lead books, cancels and rebooks, the newest booking is
    # the one whose state survives.
    for b in sorted(bookings, key=lambda x: (x.get("created_at") or "")):
        email = (b.get("lead_email") or "").strip().lower()
        status = (b.get("status") or "").strip()

        if not email:
            findings.append(("booking_without_email", b.get("id"), "no lead_email"))
            continue

        targets = by_email.get(email)
        if not targets:
            # Rule 1. Report, never create.
            findings.append(("no_ledger_row", b.get("id"), email))
            continue

        for row in targets:
            current = (row.get("state") or "").strip()

            if current == STATE_SUPPRESSED:
                # Rule 2. Suppression outranks a booking, always.
                findings.append(
                    ("booked_while_suppressed", b.get("id"), f"{email} is suppressed — not touched")
                )
                continue

            if status == "confirmed":
                target = {
                    "state": STATE_BOOKED,
                    "booking_uid": b.get("id") or "",
                    "booked_at": b.get("start_utc") or "",
                    "last_touch": now,
                    "next_action": f"attend call {b.get('start_utc') or ''}".strip(),
                }
            elif status == "no_show":
                target = {
                    "state": STATE_NO_SHOW,
                    "booking_uid": b.get("id") or "",
                    "booked_at": b.get("start_utc") or "",
                    "last_touch": now,
                    "next_action": "no-show — decide whether to re-offer",
                }
            elif status in ("cancelled", "rescheduled"):
                # Rule 3. Only release the row if THIS booking is the one holding it.
                if (row.get("booking_uid") or "").strip() != (b.get("id") or ""):
                    continue
                target = {
                    "state": STATE_AFTER_CANCEL,
                    "booking_uid": "",
                    "booked_at": "",
                    "last_touch": now,
                    "next_action": f"booking {status} — was {b.get('start_utc') or ''}".strip(),
                }
            else:
                findings.append(("unknown_status", b.get("id"), status))
                continue

            diff = {k: v for k, v in target.items() if (row.get(k) or "") != v}
            if diff:
                changes.append({"email": email, "booking": b.get("id"), "from": current, "to": target["state"]})
                row.update(target)

    return rows, changes, findings


# ── self-test ───────────────────────────────────────────────────────────────────────────

def self_test():
    now = "2026-09-17T10:00:00Z"
    base = [
        {"email": "a@x.com", "state": "loaded", "booking_uid": "", "booked_at": "", "last_touch": "", "next_action": ""},
        {"email": "stop@x.com", "state": "suppressed", "booking_uid": "", "booked_at": "", "last_touch": "", "next_action": ""},
    ]

    # Known-good: a confirmed booking books the row and nothing else moves.
    rows, changes, findings = apply_bookings(
        base, [{"id": "b1", "lead_email": "a@x.com", "status": "confirmed", "start_utc": "2026-09-20T09:00:00Z"}], now
    )
    assert rows[0]["state"] == "booked" and rows[0]["booking_uid"] == "b1", rows[0]
    assert rows[1]["state"] == "suppressed", "an unrelated row moved"
    assert findings == [], findings
    assert len(changes) == 1, changes

    # Idempotent: the same booking applied to the result changes nothing.
    rows2, changes2, _ = apply_bookings(
        rows, [{"id": "b1", "lead_email": "a@x.com", "status": "confirmed", "start_utc": "2026-09-20T09:00:00Z"}], now
    )
    assert changes2 == [], f"second run was not a no-op: {changes2}"

    # Rule 2: a suppressed contact booking is reported, never applied.
    rows3, _, findings3 = apply_bookings(
        base, [{"id": "b2", "lead_email": "stop@x.com", "status": "confirmed", "start_utc": "x"}], now
    )
    assert rows3[1]["state"] == "suppressed", "suppression was overwritten"
    assert any(f[0] == "booked_while_suppressed" for f in findings3), findings3

    # Rule 1: an unknown email is reported, never invented.
    rows4, changes4, findings4 = apply_bookings(
        base, [{"id": "b3", "lead_email": "ghost@x.com", "status": "confirmed", "start_utc": "x"}], now
    )
    assert len(rows4) == len(base), "a row was created"
    assert changes4 == [] and any(f[0] == "no_ledger_row" for f in findings4), findings4

    # Rule 3: cancelling releases the row, but only the booking that holds it.
    rows5, _, _ = apply_bookings(
        rows, [{"id": "b1", "lead_email": "a@x.com", "status": "cancelled", "start_utc": "2026-09-20T09:00:00Z"}], now
    )
    assert rows5[0]["state"] == "warm" and rows5[0]["booking_uid"] == "", rows5[0]

    rows6, changes6, _ = apply_bookings(
        rows, [{"id": "OTHER", "lead_email": "a@x.com", "status": "cancelled", "start_utc": "x"}], now
    )
    assert rows6[0]["state"] == "booked", "a stale cancellation released someone else's booking"
    assert changes6 == [], changes6

    # Book, cancel, rebook in one pass: the newest booking wins.
    rows7, _, _ = apply_bookings(
        base,
        [
            {"id": "b1", "lead_email": "a@x.com", "status": "cancelled", "start_utc": "t1", "created_at": "2026-09-01"},
            {"id": "b2", "lead_email": "a@x.com", "status": "confirmed", "start_utc": "t2", "created_at": "2026-09-02"},
        ],
        now,
    )
    assert rows7[0]["state"] == "booked" and rows7[0]["booking_uid"] == "b2", rows7[0]

    print("self-test: PASS — books, is idempotent, refuses suppressed rows, invents nothing,")
    print("           releases only its own booking, and lets the newest booking win")
    return 0


# ── live run ────────────────────────────────────────────────────────────────────────────

def read_ledger(path):
    with open(os.path.expanduser(path), newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))



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
        headers={"apikey": key, "Authorization": f"Bearer {key}", "User-Agent": "agoutbound-ledger-sync/1.0"},
    )
    with urllib.request.urlopen(req, timeout=30, context=ssl.create_default_context()) as res:
        rows = json.loads(res.read().decode("utf-8"))
    if not rows:
        raise SystemExit(f"no client row with slug '{slug}' -- has it been seeded?")
    return rows[0]["id"]

def read_bookings(client_id):
    import urllib.parse, urllib.request, ssl

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise SystemExit("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set")

    q = urllib.parse.urlencode(
        {"select": "id,lead_email,status,start_utc,created_at", "client_id": f"eq.{client_id}"}
    )
    req = urllib.request.Request(
        f"{url.rstrip('/')}/rest/v1/bookings?{q}",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "User-Agent": "agoutbound-ledger-sync/1.0",
        },
    )
    with urllib.request.urlopen(req, timeout=30, context=ssl.create_default_context()) as res:
        return json.loads(res.read().decode("utf-8"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("client_json", nargs="?")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--json", dest="json_out")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()

    if args.self_test:
        return self_test()
    if not args.client_json:
        ap.error("client_json is required unless --self-test is given")

    schemas = load_schemas()
    with open(os.path.expanduser(args.client_json), encoding="utf-8") as f:
        cfg = json.load(f)

    ledger_path = os.path.expanduser(cfg["ledger"])
    before = read_ledger(ledger_path)
    bookings = read_bookings(resolve_client_id(cfg["client"]))
    now = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()

    rows, changes, findings = apply_bookings(before, bookings, now)

    # The row-count diff is printed whether or not anything is written, because a count that
    # only appears on success is a count nobody checks.
    print(f"ledger rows {len(before)} -> {len(rows)}   bookings {len(bookings)}   changes {len(changes)}")
    for c in changes:
        print(f"  {c['email']}: {c['from']} -> {c['to']} ({c['booking']})")
    for kind, subject, detail in findings:
        print(f"FINDING {kind}: {subject} — {detail}", file=sys.stderr)

    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as f:
            json.dump({"changes": changes, "findings": findings}, f, indent=2)

    if args.dry_run:
        print("\n--dry-run: nothing written")
    elif changes:
        n = schemas.write_rows(ledger_path, "ledger", rows, prev=before)
        print(f"\nwrote {n} rows")
        _, problems = schemas.validate_file(ledger_path, "ledger")
        if problems:
            print(f"POST-WRITE SCHEMA FAILURE: {problems[:3]}", file=sys.stderr)
            return 1
    else:
        print("\nnothing to write")

    # Findings are not failures of the sync; they are things a human must look at.
    return 1 if any(f[0] == "booked_while_suppressed" for f in findings) else 0


if __name__ == "__main__":
    sys.exit(main())
