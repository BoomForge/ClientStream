# ClientStream

ClientStream is being rebuilt as a Cloudflare-native SaaS with no Replit runtime dependency.

## Current phase

The rebuild now has:

- Cloudflare Worker API
- Worker Static Assets frontend
- Real Cloudflare D1 binding to `clientstream-db`
- Core D1 schema for users, businesses, clients, jobs, quotes, invoices, payments and subscriptions
- Hashed server-side session lookup
- One-time login-token storage ready for the transactional-email step
- Business onboarding API
- Tenant-scoped client list/create/update/archive APIs
- Free-plan 10-client enforcement on the server
- Free and Pro entitlement definitions
- Square webhook verification + idempotent event intake
- CI TypeScript validation + Wrangler deployment dry-run

The existing `clientstream.io` Worker remains untouched while this replacement is built and validated.

## Architecture

- **Frontend:** Cloudflare Worker Static Assets
- **API:** Cloudflare Worker
- **Database:** Cloudflare D1
- **Payments:** Square subscriptions
- **Source/deployment:** GitHub -> Cloudflare
- **Object storage:** intentionally deferred; R2 is not required for the foundation

## D1

The Worker is bound to:

- database: `clientstream-db`
- binding: `DB`

Apply migrations before deploying a database-backed build:

```bash
npm install
npm run db:migrate:remote
```

## API baseline

Public:

- `GET /api/health`
- `GET /api/plans`
- `POST /api/webhooks/square` (requires valid Square signature)

Session-authenticated:

- `GET /api/me`
- `POST /api/onboarding/business`
- `GET /api/clients`
- `POST /api/clients`
- `PATCH /api/clients/:id`
- `DELETE /api/clients/:id` (archives rather than hard-deletes)

All client reads and writes are scoped to the authenticated user's business ID at query time.

## Authentication

The database now contains both hashed session storage and hashed one-time login-token storage. The email delivery/consume flow is intentionally not exposed until the transactional email provider is configured, so there is no insecure temporary login bypass in the rebuild.

## Square webhook

The endpoint is:

```
POST /api/webhooks/square
```

Configure these Cloudflare secrets/variables before enabling the Square webhook:

- `SQUARE_WEBHOOK_SIGNATURE_KEY` — secret
- `SQUARE_WEBHOOK_URL` — exact public webhook URL, e.g. `https://app.clientstream.io/api/webhooks/square`

Webhook payloads are signature-verified before they are accepted. Event IDs are stored in D1 with a primary key so Square retries cannot create duplicate work.

## Plan baseline

### Free
- 10 clients
- 10 invoices
- 5 Smart Write generations/month

### Pro
- A$9.99/month
- Unlimited clients
- Unlimited invoices
- 100 Smart Write generations/month

## Safety

Do not put Square API keys, webhook signing keys, Cloudflare tokens, or other secrets in this repository.
