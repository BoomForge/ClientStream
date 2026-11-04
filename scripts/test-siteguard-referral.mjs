import assert from "node:assert/strict";
import { siteguardReferral } from "../src/siteguard-referrals.ts";

// No one may reach the retired checkout through an old tracked referral.
// No D1 writes, leaked customer data or redirects must be possible.
const env = { DB: { prepare() { throw Error("Retired SiteGuard attempted a database write."); } } };
for (const method of ["GET", "HEAD", "POST"]) {
  for (const source of ["clientstream_website", "clientstream_app", "siteguard_ssl_guide", "unknown"]) {
    const response = await siteguardReferral(
      new Request("https://app.clientstream.io/api/siteguard/referral?source=" + source, { method }), env
    );
    assert.equal(response.status, 410);
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("cache-control"), "no-store");
    if(method !== "HEAD") {
      const body = await response.json();
      assert.equal(body.available_for_purchase, false);
      assert.equal(body.status, "retired");
    }
  }
}
console.log("SiteGuard referral is closed: no sale, no redirect, no telemetry mutations.");
