# Decisions

Append-only. Each entry: date, decision, why, source.

## 2026-09-16 — Build new rather than self-host cal.com
Archie's call, made twice after the cheaper option was put to him. Research later supported
it: neither incumbent offers an invisible arbitrary-payload attribution channel that
survives navigation and reaches the webhook.

## 2026-09-16 — Primary calendar, not an app-created secondary calendar
Archie's call. Events must land where the client actually looks. Costs a sensitive scope and
eventual verification; the narrower scope would have bought a smoother consent screen at the
price of the feature being useful.

## 2026-09-16 — Per-user OAuth, never domain-wide delegation
Google recommends against DWD outside critical business cases; it needs each client's super
admin, grants domain-wide access including super-admins, and fails entirely for consumer
Gmail. Source: knowledge.workspace.google.com domain-wide-delegation-best-practices.

## 2026-09-16 — Ship on production-unverified, never Testing
External + Testing issues refresh tokens expiring in 7 days. Source:
developers.google.com/identity/protocols/oauth2.

## 2026-09-16 — Separate dev and production Google Cloud projects
The unverified-app cap is 100 new grants for the lifetime of the project and cannot be
reset. Test accounts would permanently consume production runway. Source:
support.google.com/cloud/answer/15549945.

## 2026-09-16 — Vercel over Netlify for hosting
Netlify's free plan caps production deploys at roughly 20/month across all sites, which an
app under active development would exhaust. Nothing against Netlify for the finished thing.

## 2026-09-16 — Attribution via signed opaque token, not URL parameters
Both incumbents lose attribution to capped, visible parameters destroyed by navigation
hops. Source: Calendly community threads on hidden fields and UTM pass-through.
