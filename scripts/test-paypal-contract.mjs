import assert from "node:assert/strict";
import { planMatchesClientStream, subscriptionStatus, approvedPayPalUrl } from "../src/paypal-contract.ts";

const valid = {
  id: "P-CLIENTSTREAM",
  status: "ACTIVE",
  billing_cycles: [{
    tenure_type: "REGULAR",
    total_cycles: 0,
    frequency: { interval_unit: "MONTH", interval_count: 1 },
    pricing_scheme: { fixed_price: { value: "9.99", currency_code: "AUD" } }
  }]
};
assert.equal(planMatchesClientStream(valid, valid.id), true);
for (const patch of [
  { status: "CREATED" }, { id: "P-OTHER" }, { billing_cycles: [] },
  { billing_cycles: [{ ...valid.billing_cycles[0], total_cycles: 12 }] },
  { billing_cycles: [{ ...valid.billing_cycles[0], frequency: { interval_unit: "YEAR", interval_count: 1 } }] },
  { billing_cycles: [{ ...valid.billing_cycles[0], pricing_scheme: { fixed_price: { value: "9.99", currency_code: "USD" } } }] },
  { billing_cycles: [{ ...valid.billing_cycles[0], pricing_scheme: { fixed_price: { value: "99.99", currency_code: "AUD" } } }] }
]) assert.equal(planMatchesClientStream({ ...valid, ...patch }, valid.id), false);

assert.equal(subscriptionStatus("ACTIVE"), "active");
assert.equal(subscriptionStatus("APPROVAL_PENDING"), "pending");
assert.equal(subscriptionStatus("SUSPENDED"), "past_due");
assert.equal(subscriptionStatus("CANCELLED"), "cancelled");
assert.equal(subscriptionStatus("EXPIRED"), "cancelled");
assert.equal(subscriptionStatus("UNKNOWN"), "inactive");

assert.equal(approvedPayPalUrl("https://www.paypal.com/webapps/billing/subscriptions?ba_token=abc", "live")?.startsWith("https://www.paypal.com"), true);
assert.equal(approvedPayPalUrl("https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=abc", "sandbox")?.startsWith("https://www.sandbox.paypal.com"), true);
for (const url of ["https://paypal.com.evil.example/checkout", "http://www.paypal.com", "javascript:alert(1)", "https://www.sandbox.paypal.com/", "https://user:pw@www.paypal.com"]) {
  assert.equal(approvedPayPalUrl(url, "live"), null);
}
console.log("PayPal recurring plan, status, and trusted approval URL rules passed.");
