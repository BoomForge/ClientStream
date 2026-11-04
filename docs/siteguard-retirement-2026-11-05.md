# SiteGuard by ClientStream — sales retirement and Pi shutdown

Status: **sales-retirement code prepared 5 November 2026**. The Whop
merchant plan and independently hosted monitoring origin are NOT controlled
by the ClientStream code deployment.

## What this ClientStream release does

- Removes SiteGuard marketing placements from the ClientStream homepage and
  logged-in application sidebar.
- Replaces both ClientStream SiteGuard sales pages with a clear noindex
  retirement notice and existing-member billing instructions.
- Returns HTTP **410 Gone** from `/api/siteguard/referral` for every
  former sales tracking link, with no redirect and no D1 telemetry write.
- Removes SiteGuard sales pages from the marketing and app sitemaps. Free
  outage and SSL guides stay available without checkout links.
- Disables automatic SiteGuard directory and IndexNow promotional workflows.
- Migrates ClientStream's `/api/error-reports` off the SiteGuard mail bridge
  to its own Resend email transport, retaining origin, honeypot, validation and
  rate-limit controls. The endpoint returns 503 when RESEND_API_KEY,
  EMAIL_FROM or SUPPORT_EMAIL is absent or delivery fails; no false success.
  The `/api/health` field `errorReportTransport` reports
  `resend` only when email credentials and support recipient are configured.

## What this release does NOT do

- It does not delete SiteGuard user accounts, site history, monitoring jobs,
  Whop subscriptions, payment records, bank connections or any Pi files.
- It does not alter ClientStream's own PayPal plans, clients, invoices,
  notes, or general production database.
- It does not close `https://siteguard.clientstream.io/` or its monitoring
  probes/cron jobs; that service is hosted separately from this repo.
- It does not change Whop's plan
  `plan_CWrzRM1Z57v75`, historically advertised as A$9.99 per 30 days.

## Mandatory owner steps before switching off SkyPi

1. In your Whop seller dashboard open **Products** and locate the SiteGuard
   recurring plan. Match its plan identifier and product, not similarly
   named third-party listings. Set it to **archived / unavailable for
   purchase**, not merely "hidden", because direct checkout links may
   still work for hidden plans.
2. Verify new orders are blocked through the actual checkout link.
3. Inspect active or pending memberships, invoices and renewals.
   Cancel future renewal billing, notify active members of the service
   retirement, and arrange refunds or replacement monitoring for any paid
   period you cannot fulfil. Keep transaction records.
4. Verify ClientStream's own Cloudflare Worker has RESEND_API_KEY,
   EMAIL_FROM and SUPPORT_EMAIL set, and test a legitimate report once
   using /report-error.html. This avoids dependence on the SiteGuard/Pi
   email bridge. Check /api/health errorReportTransport equals "resend".
5. Export SiteGuard's customer/site/monitoring configuration and records
   from its actual host before removal. Preserve the backup securely.
6. Disable SiteGuard's own monitoring scheduler and stop its standalone
   website/worker **after** the billing and migration checks pass.
7. SkyPi hosts additional Pixelwolf delivery workflows: turning it off
   also stops those independent jobs. Confirm this interruption is intended.
   Do not remove the whole ClientStream app, shared Cloudflare account
   or any other ClientStream deployments.

## Known limits

The connected GitHub repository contains the **ClientStream marketing and
referral integration**, not the separately running SiteGuard origin.
Whop's seller account is not connected to this environment.
Until those independent services are checked, this is **partial retirement**,
not proof SiteGuard billing or monitoring is shut down.
