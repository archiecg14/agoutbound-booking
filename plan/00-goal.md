# AG Outbound Booking — Goal

The build brief is **[SPEC.md](../SPEC.md)** — single source of truth. This file exists so
the planning scaffold has an entry point; do not duplicate spec content here.

**Outcome:** every call booked out of a cold-email campaign lands in the client's real
calendar and in the master ledger, carrying the lead, campaign, wave and sequence step that
produced it.

**Done check:** `reconcile.py` reads ledger and calendar live and prints matched/unmatched
counts, exiting non-zero on mismatch.
