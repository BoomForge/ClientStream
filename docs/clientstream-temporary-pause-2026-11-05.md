# ClientStream temporary service pause — 5 November 2026

## Owner intent

ClientStream and SiteGuard are paused for now while the owner switches off
SkyPi. This is a **reversible maintenance deployment**, not an account deletion,
domain cancellation or subscription cancellation. Existing accounts are believed
to be few or none, but **registered-user and payment counts must be verified
from live D1**, not inferred from owner recollection.

## What the code release does

- Cloudflare's ClientStream Worker serves a friendly **HTTP 503** maintenance
  page for the main app and other static routes while
  `CLIENTSTREAM_PAUSED=true` is set in the Wrangler config. Set
  `run_worker_first=true` so the Worker intercepts even static HTML assets;
  otherwise a direct visit to an old route could bypass the notice.
- The separate ClientStream marketing Worker displays a temporary closure page,
  without signup, promotional pricing or upgrade CTAs.
- Registration, new PayPal checkouts, billing reconciliation, account
  mutations, error submissions and usual app APIs return a paused response.
- Existing account login/logout, authenticated billing status, cancellation,
  and data export remain available through the restricted maintenance screen.
- Verified PayPal webhooks stay enabled to record payment/cancellation events.
  **Pausing the Worker does not stop PayPal's own recurring payments.**
- The D1 database, user accounts, invoices, jobs, quotes, balances, sessions,
  secrets and SiteGuard history are **not deleted**.
- Cloudflare hourly maintenance cron is removed, and GitHub's six-hour
  production health schedule is disabled. Manual checks remain available.

## Important production account verification

The PR CI has a read-only `production_inventory` job. It queries Cloudflare D1
for only (a) registered-user count, (b) known disposable smoke accounts,
(c) non-smoke count, (d) subscription count/status and (e) businesses on Pro.
The exact results should be reviewed before treating the service as having
no customers. Do not log email addresses, PayPal subscription IDs or users'
personal data.

The production deploy workflow repeats the anonymised counts before
deployment, then checks the paused site with a read-only smoke test that
never creates test users or starts payments.

## Before powering down SkyPi

1. Confirm that the public marketing and app origins both show the pause notice
   and that direct app routes no longer permit registration or checkout.
2. Check the production D1 counts and inspect paid membership/renewal status in
   **PayPal**; local subscription counts are **not** proof of zero active
   payments. Stop paid renewals appropriately if any customers exist.
3. Check **Whop** for SiteGuard memberships; it is a separate seller account.
   SiteGuard's stand-alone origin remains outside ClientStream's code.
4. Any ongoing site or app error reporting that depended on SiteGuard/SkyPi
   will be unavailable while paused. Do not report these services as live.

## Reopening

Restore ClientStream intentionally by reverting the pause commit or setting
`CLIENTSTREAM_PAUSED=false`, restoring `run_worker_first` routing as needed,
restoring tested Cloudflare and GitHub schedules, and deploying via normal CI.
Do not restart subscriptions or new checkout until the owner approves.

The code release does **not** cancel an external PayPal agreement, Whop plan,
external cron, Cloudflare account, DNS entry, or power down the Raspberry Pi.
