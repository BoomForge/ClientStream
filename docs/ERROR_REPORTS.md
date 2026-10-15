# ClientStream error reporting via SiteGuard

ClientStream's public error-report form at `/report-error.html` posts to
`/api/error-reports` on the ClientStream Cloudflare Worker. The Worker validates
input and applies its existing dedicated Cloudflare rate limiter, then forwards
the validated JSON to `https://siteguard.clientstream.io/clientstream/error-report`.

SiteGuard's existing SkyPi-hosted service receives only this explicit path. Its
restricted portal process sends to the fixed support inbox using the
pre-existing `/etc/siteguard/email.json` Resend configuration. No key is moved
to ClientStream, no second account is required, and customers cannot choose
another recipient.

**SiteGuard needs its one-time code deployment before reporting will work.**
On SkyPi, from the existing checkout:

```bash
cd ~/SkyPiM
git pull --ff-only
sudo bash scripts/install_clientstream_error_bridge.sh
```

The installer checks SiteGuard services and mail configuration, runs offline
regression tests, installs a narrowly scoped path forwarder and portal handler,
restarts only the public SiteGuard origin and portal, performs non-email smoke
checks and rolls back if a step fails. It does not modify monitoring, Cloudflare
Tunnel settings, merchant integrations or Sollet.

After the installer passes, submit a **real test** via ClientStream's report
form and confirm email receipt at the specified support inbox. A successful
submission means Resend accepted the message, not that the inbox received it;
inbox verification is a separate check.

The site's login/password-reset, billing, invoice and quote email handlers are
unchanged. Those still use ClientStream's older direct `sendEmail` integration
and are not covered by the SiteGuard support bridge.
