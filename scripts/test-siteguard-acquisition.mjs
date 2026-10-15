import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const files = [
  ["marketing/index.html", "clientstream_website"],
  ["marketing/siteguard.html", "clientstream_marketing_guide"],
  ["public/index.html", "clientstream_app"],
  ["public/siteguard.html", "clientstream_monitoring_guide"],
  ["public/siteguard-outage-checklist.html", "siteguard_outage_guide"],
  ["public/siteguard-ssl-guide.html", "siteguard_ssl_guide"]
];
for (const [path, source] of files) {
  const doc = readFileSync(new URL("../" + path, import.meta.url), "utf8");
  assert.match(doc, new RegExp("href=\"https://siteguard\\.clientstream\\.io/\\?utm_source=" + source + "&amp;utm_medium="),
    path + " missing tracked customer-acquisition CTA");
  assert.match(doc, /utm_campaign=siteguard_launch/, path + " missing launch campaign attribution");
  assert.match(doc, /SiteGuard/i, path + " lost clear product attribution");
}
const sitemap = readFileSync(new URL("../public/sitemap.xml", import.meta.url), "utf8");
const feed = readFileSync(new URL("../public/siteguard-feed.xml", import.meta.url), "utf8");
for(const slug of ["siteguard.html", "siteguard-outage-checklist.html", "siteguard-ssl-guide.html"]) {
  assert.ok(sitemap.includes("https://app.clientstream.io/" + slug), "Missing SiteGuard sitemap guide: " + slug);
  assert.ok(feed.includes("https://app.clientstream.io/" + slug), "Missing Atom distribution entry: " + slug);
}
assert.equal((sitemap.match(/<url>/g) || []).length, 3, "Avoid duplicate near-identical search entries.");
assert.ok(!sitemap.includes("siteguard-website-down.html"), "Duplicate outage guides should not be indexed.");
assert.ok(!sitemap.includes("siteguard-ssl-certificate-expiry.html"), "Duplicate SSL guides should not be indexed.");
console.log("SiteGuard first-party placements, six distinct tracking sources, canonical guides and feed passed.");
