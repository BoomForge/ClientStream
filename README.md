# ClientStream

ClientStream is being rebuilt as a Cloudflare-native SaaS with no Replit runtime dependency.

## Current phase

This repository contains the first rebuild foundation:

- Cloudflare Worker API
- Worker Static Assets frontend
- Cloudflare D1 migration schema
- Free and Pro entitlement definitions
- Square webhook verification + idempotent event intake
- CI type checking
- No production DNS or existing ClientStream deployment changes

The existing `clientstream.io` Worker remains untouched while this replacement is built and validated.

## Architecture

- **Frontend:** Cloudflare Worker Static Assets
- **API:** Cloudflare Worker
- **Database:** Cloudflare D1
- **Payments:** Square subscriptions
- **Source/deployment:** GitHub -> Cloudflare
- **Object storage:** intentionally deferred; R2 is not required for the foundation

## Local development

```bash
npm install
npm run dev
```

The foundation can run without D1. `GET /api/health` will report the database as `unbound`.

To enable D1:

1. Create a Cloudflare D1 database named `clientstream-db`.
2. Add its database ID to the D1 binding in your Wrangler configuration (see `wrangler.d1.example.jsonc`).
3. Apply migrations:

```bash
npm run db:migrate:local
npm run db:migrate:remote
```

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

The plan response lives at `GET /api/plans` and will become the single source of truth for UI entitlement checks.

## Safety

Do not put Square API keys, webhook signing keys, Cloudflare tokens, or other secrets in this repository.
