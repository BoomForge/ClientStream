# ClientStream production setup

The application code is designed to remain fully usable on the Free plan while optional external services are not configured.

## 1. Transactional email

ClientStream already contains email verification, password reset, due-reminder email, and Pro quote/invoice delivery.

Recommended setup:

1. Create a Resend account.
2. Add a dedicated transactional sending subdomain such as `mail.clientstream.io`.
3. Add the SPF and DKIM records Resend provides in Cloudflare DNS and verify the domain.
4. Create a Resend API key.
5. In GitHub > BoomForge/ClientStream > Settings > Secrets and variables > Actions, add:
   - `RESEND_API_KEY`
   - `EMAIL_FROM` (example: `ClientStream <notifications@mail.clientstream.io>`)
   - `PUBLIC_APP_URL` (use `https://app.clientstream.io` after cutover)
   - `SUPPORT_EMAIL` if a support mailbox exists.
6. Run the **Configure ClientStream Runtime** workflow.

Do not commit API keys.

## 2. Production app domain

The rebuilt app should live at `app.clientstream.io`; the current marketing site can remain at `clientstream.io`.

When ready:

1. Confirm there is no conflicting CNAME for `app.clientstream.io`.
2. Run the **Enable app.clientstream.io** workflow.
3. Set `PUBLIC_APP_URL=https://app.clientstream.io` through GitHub repository secrets and rerun **Configure ClientStream Runtime**.
4. Confirm login, password reset, quote/invoice print and API health on the custom domain.
5. Update the marketing site's old `clientstream.replit.app` links to `https://app.clientstream.io`.

Cloudflare Custom Domains create the required DNS record and certificate automatically.

## 3. PayPal recurring subscriptions (A$9.99/month)

ClientStream uses **Subscriptions v1**, not the Pixelwolf Store's one-time Orders v2 API. The existing Pixelwolf Store Live PayPal Business REST app credentials may be reused, but Pixelwolf's Hostinger-protected private settings are not shared with the Cloudflare Worker.

**Quickest route (automated provisioning):** Copy the Pixelwolf Store's Live PayPal REST app **Client ID** and **Secret** from PayPal Developer Dashboard into this ClientStream GitHub repository's Actions secrets `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` (never chat, screenshots or source). In GitHub Actions, run **Provision ClientStream PayPal**, choose `sandbox` with Sandbox credentials first or `live` with Live credentials after acceptance. The workflow reuses or creates the exact AUD 9.99/month ClientStream plan, registers the webhook, and pushes all PayPal Worker secrets securely into Cloudflare. It fails rather than enabling an incorrect plan or webhook. Only the PayPal credentials need copying; it does NOT read Hostinger's private Store configuration. Do not switch a live service back to sandbox while genuine subscribers are active.

**Manual alternative**, if the provisioning workflow cannot run:

1. In PayPal Developer Dashboard, create a **ClientStream Pro** catalog product and an **ACTIVE** subscription billing plan. The regular billing cycle must be MONTH / interval 1 / total_cycles 0, with a fixed price of **AUD 9.99**. No trial and no setup fee. The Worker refuses checkout if the real provider plan differs.
2. In that same REST app, register a webhook at `https://app.clientstream.io/api/webhooks/paypal` for `BILLING.SUBSCRIPTION.CREATED`, `BILLING.SUBSCRIPTION.ACTIVATED`, `BILLING.SUBSCRIPTION.UPDATED`, `BILLING.SUBSCRIPTION.CANCELLED`, `BILLING.SUBSCRIPTION.SUSPENDED`, `BILLING.SUBSCRIPTION.EXPIRED`, `BILLING.SUBSCRIPTION.PAYMENT.FAILED`, `PAYMENT.SALE.COMPLETED`, `PAYMENT.SALE.REFUNDED` and `PAYMENT.SALE.REVERSED`. Obtain the distinct PayPal **Webhook ID**, not the Client ID.
3. In GitHub repository Settings > Secrets and variables > Actions, securely set:
   - `PAYPAL_CLIENT_ID`
   - `PAYPAL_CLIENT_SECRET`
   - `PAYPAL_PLAN_ID` (starts with P-)
   - `PAYPAL_WEBHOOK_ID`
   - `PAYPAL_ENVIRONMENT=sandbox` for sandbox credentials/plan, or `live` for matching Live credentials/plan.
4. Run the existing **Configure ClientStream Runtime** workflow, then confirm /api/health shows `paypalBilling` and `paypalWebhook` both `configured`.
5. Verify an **email-verified** ClientStream owner can approve a Sandbox PayPal subscription and that a real signed Sandbox event activates Pro. Test webhook retries/duplicates, cancellation, and loss of paid status. Only after passing Sandbox acceptance configure Live credentials/plan. Sandbox and Live plan/webhook IDs are distinct. Do not charge a live payment just to test the code without explicit merchant approval.
6. The existing Pixelwolf Store remains separate. Do not commit PayPal client secrets or any bearer tokens. Enabling PayPal on Pixelwolf does not itself enable it on Cloudflare.

When PayPal cannot be configured, Free remains functional, and Pro checkout is disabled. No Square billing code remains active; the original historical Square D1 audit table is retained for non-destructive migration compatibility.

## 4. Encrypted database backup

Cloudflare D1 remains the system of record. ClientStream also contains a weekly encrypted export workflow.

Add `BACKUP_ENCRYPTION_PASSWORD` as a GitHub Actions repository secret. Use a long unique passphrase and store a copy outside GitHub. Once configured, the workflow exports D1, encrypts the SQL before upload, deletes the plaintext copy, and retains the encrypted GitHub artifact for 30 days.

Never upload a plaintext ClientStream database backup to a public repository.

## 5. Marketing cutover

The existing root marketing site should remain live until the app domain has passed the production smoke test. Do not replace `purple-cell-493f` with the SaaS Worker. The final marketing change is only to replace dead Replit app links with `https://app.clientstream.io`.
