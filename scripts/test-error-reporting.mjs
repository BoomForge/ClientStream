import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
assert.ok(read("src/index.ts").includes('path === "/api/error-reports"'));
const endpoint = read("src/error-reports.ts");
for (const term of ["mutationOriginIsAllowed(request)", "REPORT_RATE_LIMITER.limit", "validEmail(email)",
                    "https://siteguard.clientstream.io/clientstream/error-report",
                    "response.status !== 201"]) assert.ok(endpoint.includes(term), term);
assert.ok(!endpoint.includes("RESEND_API_KEY"));
assert.ok(!endpoint.includes("emailConfigured(env)"));
assert.ok(!endpoint.includes("sendEmail(env"));
const html = read("public/report-error.html");
for (const name of ["issueType","summary","details","steps","email","pageUrl","website"]) assert.ok(html.includes('name="' + name + '"'), name);
assert.ok(read("public/report-error.js").includes('fetch("/api/error-reports"'));
assert.ok(read("marketing/index.html").includes('https://app.clientstream.io/report-error.html'));
assert.ok(read("public/index.html").includes('href="/report-error.html"'));
assert.ok(read("wrangler.jsonc").includes('"REPORT_RATE_LIMITER"'));
console.log("Error reporting validates input and uses only SiteGuard's existing mail service.");
