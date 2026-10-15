// Report only anonymous, aggregated SiteGuard referral redirect counts.
// A redirect click is not a unique visitor, checkout, conversion or sale.
import { fileURLToPath } from "node:url";

const DATABASE_ID = "19030b2b-655d-4695-b74d-b28c93b25afa";
const SOURCES = new Set([
  "clientstream_website",
  "clientstream_marketing_guide",
  "clientstream_app",
  "clientstream_monitoring_guide",
  "siteguard_outage_guide",
  "siteguard_ssl_guide"
]);
const SQL = "SELECT source, SUM(clicks) AS clicks FROM siteguard_referral_clicks WHERE day_utc >= date('now', '-6 days') GROUP BY source ORDER BY source";

export function summarizeReferralCounts(body) {
  if (body?.success !== true || !Array.isArray(body?.result) ||
      body.result[0]?.success !== true || !Array.isArray(body.result[0]?.results)) {
    throw new Error("Cloudflare D1 query not confirmed successful");
  }
  const rows = body.result[0].results;
  const totals = Object.fromEntries([...SOURCES].map(source => [source, 0]));
  for (const row of rows) {
    if (!SOURCES.has(row?.source)) throw new Error("Unexpected referral source");
    const count = row.clicks;
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid aggregated click count");
    totals[row.source] = count;
  }
  return { totals, clicks: Object.values(totals).reduce((a, b) => a + b, 0) };
}

async function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !accountId) {
    console.log("SITEGUARD ACQUISITION UNVERIFIED: D1 read credentials unavailable. Do not report zero traffic.");
    return;
  }
  if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new Error("Invalid Cloudflare account identifier");
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${DATABASE_ID}/query`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({sql: SQL}),
      signal: AbortSignal.timeout(20000)
    }
  );
  if (!response.ok) throw new Error("Cloudflare D1 read failed: HTTP " + response.status);
  const { totals, clicks } = summarizeReferralCounts(await response.json());
  console.log("SITEGUARD ACQUISITION: last 7 UTC calendar days; privacy-safe redirect clicks.");
  for (const [source, count] of Object.entries(totals)) {
    console.log("  " + source + ": " + count);
  }
  console.log("SITEGUARD ACQUISITION TOTAL CLICKS:", clicks);
  console.log("Subscription/conversion count: UNVERIFIED (Whop payment events not available in this read-only D1 query).");
  console.log("External directory landing visits: NOT ATTRIBUTABLE unless that directory uses an approved tracked redirect.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => {
    console.error("SITEGUARD ACQUISITION UNVERIFIED:", error.message);
    process.exitCode = 1;
  });
}
