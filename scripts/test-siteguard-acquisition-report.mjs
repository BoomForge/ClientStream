import assert from "node:assert/strict";
import { summarizeReferralCounts } from "./report-siteguard-acquisition.mjs";

const result = summarizeReferralCounts({
  success: true,
  result: [{
    success: true,
    results: [
      { source: "clientstream_website", clicks: 9 },
      { source: "siteguard_ssl_guide", clicks: 3 }
    ]
  }]
});
assert.equal(result.clicks, 12);
assert.equal(result.totals.clientstream_website, 9);
assert.equal(result.totals.clientstream_app, 0);
assert.equal(result.totals.siteguard_ssl_guide, 3);
assert.equal(Object.keys(result.totals).length, 6);
for (const invalid of [
  null,
  {success: false, result: []},
  {success: true, result: [{success: false, results: []}]},
  {success: true, result: [{success: true, results: [{source: "untrusted", clicks: 10}]}]},
  {success: true, result: [{success: true, results: [{source: "clientstream_app", clicks: -1}]}]},
  {success: true, result: [{success: true, results: [{source: "clientstream_app", clicks: "1"}]}]}
]) {
  assert.throws(() => summarizeReferralCounts(invalid));
}
console.log("SiteGuard read-only acquisition summary contract passed (including fail-closed cases).");
