import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = path => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const pages = ["marketing/index.html", "marketing/siteguard.html", "public/index.html",
  "public/siteguard.html", "public/siteguard-outage-checklist.html", "public/siteguard-ssl-guide.html"];
for (const path of pages) {
  const html = read(path);
  assert.ok(!html.includes("api/siteguard/referral?source="), path + " still markets SiteGuard.");
  assert.ok(!html.includes("whop.com/checkout/"), path + " still exposes a checkout.");
  assert.ok(!html.includes("Visit SiteGuard and subscribe"), path + " still accepts customers.");
}
for (const path of ["marketing/siteguard.html", "public/siteguard.html"]) {
  const html=read(path);
  assert.match(html,/no longer available for new subscriptions/i);
  assert.match(html, /noindex/);
  assert.match(html,/whop.com/);
}
assert.ok(!read("marketing/index.html").includes('id="siteguard"'));
assert.ok(!read("public/index.html").includes('siteguard-sidebar-link"'));
for (const path of ["marketing/sitemap.xml","public/sitemap.xml"]) {
  assert.ok(!read(path).includes("siteguard.html"), path + " still advertises the product.");
}
for (const slug of ["siteguard-outage-checklist.html","siteguard-ssl-guide.html"]) {
  assert.ok(read("public/sitemap.xml").includes(slug), "Keep existing free guide: " + slug);
}
console.log("SiteGuard sales placements removed; free guides and ClientStream remain intact.");
