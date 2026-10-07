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

## 3. Square

Square is deliberately optional until credentials are available. Add these repository secrets later:

- `SQUARE_ACCESS_TOKEN`
- `SQUARE_LOCATION_ID`
- `SQUARE_PRO_PLAN_VARIATION_ID`
- `SQUARE_WEBHOOK_SIGNATURE_KEY`
- `SQUARE_WEBHOOK_URL=https://app.clientstream.io/api/webhooks/square`
- `SQUARE_ENVIRONMENT=production`

Then run **Configure ClientStream Runtime**.

## 4. Encrypted database backup

Cloudflare D1 remains the system of record. ClientStream also contains a weekly encrypted export workflow.

Add `BACKUP_ENCRYPTION_PASSWORD` as a GitHub Actions repository secret. Use a long unique passphrase and store a copy outside GitHub. Once configured, the workflow exports D1, encrypts the SQL before upload, deletes the plaintext copy, and retains the encrypted GitHub artifact for 30 days.

Never upload a plaintext ClientStream database backup to a public repository.

## 5. Marketing cutover

The existing root marketing site should remain live until the app domain has passed the production smoke test. Do not replace `purple-cell-493f` with the SaaS Worker. The final marketing change is only to replace dead Replit app links with `https://app.clientstream.io`.
