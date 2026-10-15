import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const js = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
assert.match(html, /id="plan-chip"[^>]*>Free plan<\/div>\s*<button[^>]*id="sidebar-upgrade"/);
assert.match(js, /\$\("#sidebar-upgrade"\)\.addEventListener\("click", startPayPalUpgrade\)/);
assert.match(js, /\$\("#upgrade-button"\)\.addEventListener\("click", startPayPalUpgrade\)/);

const begin = js.indexOf("let upgradePending = false;");
const end = js.indexOf('$("#upgrade-button").addEventListener("click", startPayPalUpgrade);', begin);
assert.ok(begin >= 0 && end > begin);
const functionSource = js.slice(begin, end);

async function scenario(configured) {
  const cta = { disabled: false, textContent: "Upgrade to Pro" };
  const label = { textContent: "Upgrade " };
  const sidebar = { disabled: false, firstChild: label };
  const panel = { scrollIntoView: () => { result.scrolled = true; } };
  const result = { requests: [], messages: [], view: null, scrolled: false, refreshes: 0 };
  const sandbox = {
    state: { billing: { configured, businessPlan: "free" }, me: { business: { plan: "free" } } },
    $: (query) => {
      if (query === "#upgrade-button") return cta;
      if (query === "#sidebar-upgrade") return sidebar;
      if (query === "#billing-panel") return panel;
      throw Error("Unexpected DOM selector " + query);
    },
    setView: (view) => { result.view = view; },
    toast: (message) => { result.messages.push(message); },
    renderBilling: () => { result.refreshes += 1; },
    api: async (path) => { result.requests.push(path); return { checkoutUrl: "https://www.paypal.com/checkout" }; },
    location: { href: "https://app.clientstream.io/" }
  };
  const action = runInNewContext(functionSource + "\nstartPayPalUpgrade", sandbox);
  await action();
  assert.equal(cta.disabled, false);
  assert.equal(sidebar.disabled, false);
  if (configured) {
    assert.deepEqual(result.requests, ["/api/billing/checkout"]);
    assert.equal(sandbox.location.href, "https://www.paypal.com/checkout");
    assert.equal(result.refreshes, 1);
  } else {
    assert.deepEqual(result.requests, []);
    assert.equal(result.view, "dashboard");
    assert.equal(result.scrolled, true);
    assert.equal(result.messages.length, 1);
  }
}
await scenario(true);
await scenario(false);
console.log("Sidebar Upgrade uses the same guarded PayPal checkout as Today and remains informative before setup.");
