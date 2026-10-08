# ClientStream production release and recovery runbook

Status: **release blocked pending live acceptance**. Keep the `clientstream.io` marketing Worker unchanged.

## Deployment gates (in order)

1. Confirm the latest successful main-branch CI SHA and deployed `/api/health.version` match.
2. Confirm disposable-account registration, actual password login, profile and signed-in password change, session revocation and logout.
3. Validate the custom domain `https://app.clientstream.io` for HTTPS, static assets, session cookies and print routes. Retain `workers.dev` for diagnostics. Do not point production tests to the new domain before it is healthy.
4. Configure `PUBLIC_APP_URL`, Resend sender and DNS only using GitHub Actions secrets, then perform verification/recovery delivery tests with real mailboxes. Test expired and reused tokens.
5. Complete client/job/multi-line-GST quote/invoice/partial and full payment/expense/reminder/export/deletion journeys, two-business isolation, mobile and keyboard tests.
6. Benchmark PBKDF2 iterations on the actual deployed Worker plan before increasing the target. Keep the stored per-row iterations authoritative.
7. Confirm Square sandbox subscription lifecycle and webhook idempotency before configuring real billing. Free must work without Square.
8. Produce a real encrypted D1 backup and restore it into an isolated database; check representative rows. Confirm the decryption password is also recoverable outside GitHub.
9. Confirm policies, ATO invoice compliance, monitored support and account-deletion/retention behaviour.
10. Only after the application and transactional email are proven, cut over the original marketing Worker using its dedicated deployment workflow; smoke test root-domain CTAs and have rollback ready.

## Rollback

- Identify the last validated commit and deployed Cloudflare Worker version from GitHub Actions / Cloudflare versions.
- Roll back the Worker **application code** to the last known-good compatible version, retaining `workers.dev` as an independent diagnostic route.
- Do not reverse or delete applied D1 migrations; schema changes must be forward-only. Assess whether old code supports the newer schema before redeploying.
- Restore D1 data only for verified data loss/corruption, after preserving the current database export for forensics. Prefer targeted forward fixes; never restore an older database merely because a new Worker code version failed.
- Keep the root marketing Worker intact until the distinct marketing cutover gate is satisfied.

## Scheduled operations

- Hourly: Cloudflare Worker scheduled maintenance at `17 * * * *`; confirm real execution in Cloudflare logs, not configuration alone.
- Weekly: encrypted D1 export through the prepared backup workflow; inspect completed artifact and perform regular decrypt/restore drills.
- First seven days after verified launch: review registration/auth 429s, 5xx, email delivery, webhook state, cron errors, support requests and Free-plan friction daily.
- Never write passwords, session cookies, reset tokens, provider keys or customer message bodies into logs or GitHub issues.

## Release evidence checklist

Record exact deployed SHA/version, CI/deploy workflow IDs, customer-journey test timestamp, browser/device coverage, backup artifact ID, restore-test result, email deliverability evidence, payment lifecycle evidence and the marketing Worker rollback version. Leave an item pending when proof is unavailable.

## Current external prerequisites

GitHub connector access does not provide direct Cloudflare DNS/Workers dashboard actions, GitHub Actions secret values or Square/Resend account provisioning. Do not fabricate completion. Do not push secrets into repository files. A successful CI dry-run is not a substitute for a live deployment/smoke test.
