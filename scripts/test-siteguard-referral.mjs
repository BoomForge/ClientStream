import assert from "node:assert/strict";
import { siteguardReferral } from "../src/siteguard-referrals.ts";

const calls = [];
const env = {
  DB: {
    prepare(sql) {
      assert.match(sql, /INSERT INTO siteguard_referral_clicks/);
      return { bind(...args) { calls.push(args); return { async run() { return { success: true }; } }; } };
    }
  }
};
const urls = [
  ["clientstream_website", true],
  ["clientstream_marketing_guide", true],
  ["clientstream_app", true],
  ["clientstream_monitoring_guide", true],
  ["siteguard_outage_guide", true],
  ["siteguard_ssl_guide", true],
  ["totally_fake_source", false]
];
for (const [source, expected] of urls) {
  const before = calls.length;
  const res = await siteguardReferral(
    new Request("https://app.clientstream.io/api/siteguard/referral?source=" + source),
    env
  );
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "https://siteguard.clientstream.io/");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(calls.length, before + Number(expected), "Unexpected source aggregation count");
}
for (const suffix of [
  "?source=clientstream_website&probe=1",
  "?source=clientstream_website"
]) {
  const before = calls.length;
  const method = suffix.includes("probe") ? "GET" : "HEAD";
  const response = await siteguardReferral(
    new Request("https://app.clientstream.io/api/siteguard/referral" + suffix, { method }),
    env
  );
  assert.equal(response.status, 302);
  assert.equal(calls.length, before, "Healthcheck/HEAD requests must not pollute click counts");
}
for (const [source, day, count, updated] of calls) {
  assert.match(source, /^[a-z_]+$/);
  assert.match(day, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(typeof updated === "string" && updated.includes("T"));
  assert.equal(count, undefined); // only source/date/timestamp are bound; count hardcoded to 1 in SQL
}
console.log("SiteGuard safe redirect, six source allowlist, aggregate-only storage and probe bypass passed.");
