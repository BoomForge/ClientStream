import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = p => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const endpoint = read("src/error-reports.ts");
assert.ok(read("src/index.ts").includes('path === "/api/error-reports"'));
for (const term of ["mutationOriginIsAllowed(request)", "REPORT_RATE_LIMITER.limit", "validEmail(email)",
  "emailConfigured(env)", "validEmail(recipient)", "sendEmail(env", "escapeHtml(text)",
  "Error reporting is temporarily unavailable"]) assert.ok(endpoint.includes(term), term);
assert.ok(!endpoint.includes("siteguard.clientstream.io"), "ClientStream reporting must not depend on SiteGuard or SkyPi.");
assert.ok(read("src/index.ts").includes('errorReportTransport: (emailConfigured(env)'));
const html = read("public/report-error.html");
for (const field of ["issueType","summary","details","steps","email","pageUrl","website"])
  assert.ok(html.includes('name="' + field + '"'), field);
assert.ok(read("public/report-error.js").includes('fetch("/api/error-reports"'));
assert.ok(read("marketing/index.html").includes('https://app.clientstream.io/report-error.html'));
assert.ok(read("public/index.html").includes('href="/report-error.html"'));
assert.ok(read("wrangler.jsonc").includes('"REPORT_RATE_LIMITER"'));
console.log("ClientStream error reporting retains validation and uses its own configured Resend transport.");
