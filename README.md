# ClientStream

ClientStream is a Cloudflare-native SaaS for Australian sole traders and small businesses. It has no Replit runtime dependency.

## Current product

The rebuilt application includes:

- secure email/password accounts and server-side sessions
- email verification and password recovery when transactional email is configured
- business profiles, ABN, contact details and GST defaults
- clients and jobs
- Today view with reminders, overdue invoices and upcoming jobs
- multi-line quotes and invoices with sequential per-business numbering
- quote-to-invoice conversion, printing/PDF and Pro email delivery
- manual payment recording and overdue/part-paid states
- expenses
- EOFY/performance reporting and Pro CSV export
- Smart Write using Cloudflare Workers AI with a non-AI fallback
- Free/Pro entitlements
- Square subscription billing code, safely dormant until Square credentials are configured
- account data export and owner-confirmed permanent deletion
- Privacy Policy and Terms of Service

## Architecture

- **Frontend:** Cloudflare Worker Static Assets
- **API:** Cloudflare Worker
- **Database:** Cloudflare D1 (`clientstream-db`)
- **AI:** Cloudflare Workers AI
- **Transactional email:** Resend when configured
- **Payments:** Square subscriptions when configured
- **Deployments:** GitHub Actions -> Cloudflare
- **Production app target:** `app.clientstream.io`
- **Marketing site:** existing `clientstream.io` / `purple-cell-493f`

The live rebuild preview remains:

`https://clientstream.theevansorrell.workers.dev`

## Plan baseline

### Free

- 10 active clients
- 10 invoices
- 5 Smart Write generations/month

### Pro

- A$9.99/month
- unlimited clients
- unlimited invoices
- 100 Smart Write generations/month
- customer document email delivery
- EOFY CSV export

## Operational safety

CI validates TypeScript, browser JavaScript, a fresh local D1 migration chain and a Wrangler bundle dry-run.

A successful `main` build applies remote D1 migrations, deploys the Worker/static assets and then runs an end-to-end production smoke test that creates and removes a disposable business.

The Worker also has:

- Cloudflare-native authentication, mutation and AI rate limits
- hardened browser security headers
- request IDs for server-side failures
- hourly maintenance/automation
- deduplicated overdue/job/review reminders
- automatic overdue invoice and expired quote state
- expired session/token cleanup
- optional reminder email delivery

A weekly encrypted D1 export workflow is present but remains safely inactive until `BACKUP_ENCRYPTION_PASSWORD` is configured. Plaintext database exports are never uploaded as artifacts.

## Production setup

See [docs/PRODUCTION_SETUP.md](docs/PRODUCTION_SETUP.md).

External configuration still required before the public commercial launch:

1. Resend sending-domain verification/API key for transactional email.
2. `app.clientstream.io` activation after the rebuilt app passes final production testing.
3. Updating the root marketing site using the manual marketing workflow after the app domain is live.
4. Square production credentials/plan when billing setup is available.
5. A backup-encryption password to activate encrypted weekly D1 exports.

Do not commit Cloudflare, Resend, Square or backup secrets.

## D1

The Worker is bound to:

- database: `clientstream-db`
- binding: `DB`

Commands:

```bash
npm install
npm run check
npm run check:js
npm run db:migrate:local
npm run db:migrate:remote
npm run smoke:production
```

## Marketing cutover

The original public ClientStream site has been recovered into `marketing/` and its old Replit application links have been replaced with `https://app.clientstream.io/`.

The workflow **Deploy ClientStream Marketing** is manual-only and targets the existing `purple-cell-493f` Worker. Do not run it until the app custom domain is confirmed healthy.

## Data and privacy

Account owners can export business data from Settings. Permanent deletion requires owner access, the current password and explicit `DELETE` confirmation; deletion is blocked while an active Square subscription exists.

Public policy pages are available at:

- `/privacy.html`
- `/terms.html`
