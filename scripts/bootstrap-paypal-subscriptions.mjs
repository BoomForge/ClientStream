import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const mode = process.env.PAYPAL_SETUP_MODE;
const clientId = process.env.PAYPAL_CLIENT_ID;
const secret = process.env.PAYPAL_CLIENT_SECRET;
if (!["sandbox", "live"].includes(mode) || !clientId || !secret) {
  throw Error("Choose PayPal sandbox/live and configure the matching GitHub API credential secrets.");
}
const base = mode === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
const callback = "https://app.clientstream.io/api/webhooks/paypal";
const name = "ClientStream Pro — AUD 9.99 monthly";
const types = [
  "BILLING.SUBSCRIPTION.CREATED",
  "BILLING.SUBSCRIPTION.ACTIVATED",
  "BILLING.SUBSCRIPTION.UPDATED",
  "BILLING.SUBSCRIPTION.CANCELLED",
  "BILLING.SUBSCRIPTION.SUSPENDED",
  "BILLING.SUBSCRIPTION.EXPIRED",
  "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
  "PAYMENT.SALE.COMPLETED",
  "PAYMENT.SALE.REFUNDED",
  "PAYMENT.SALE.REVERSED"
];

const auth = await fetch(base + "/v1/oauth2/token", {
  method: "POST",
  headers: {
    authorization: "Basic " + Buffer.from(clientId + ":" + secret).toString("base64"),
    "content-type": "application/x-www-form-urlencoded"
  },
  body: "grant_type=client_credentials"
});
if (!auth.ok) throw Error("Could not authenticate the PayPal REST app (HTTP " + auth.status + ").");
const token = (await auth.json()).access_token;
if (!token) throw Error("PayPal access token was missing.");

async function api(path, method = "GET", data) {
  const response = await fetch(base + path, {
    method,
    headers: {
      authorization: "Bearer " + token,
      accept: "application/json",
      "content-type": "application/json",
      prefer: "return=representation",
      ...(method === "POST" ? { "paypal-request-id": randomUUID() } : {})
    },
    body: data === undefined ? undefined : JSON.stringify(data)
  });
  if (!response.ok) throw Error("PayPal " + method + " " + path.split("?")[0] + " returned HTTP " + response.status + ". No credentials were logged.");
  const raw = await response.text();
  return raw ? JSON.parse(raw) : {};
}
function matchesMonthlyPlan(plan) {
  if (plan.status !== "ACTIVE") return false;
  if (!Array.isArray(plan.billing_cycles) || plan.billing_cycles.length !== 1) return false;
  const cycle = plan.billing_cycles[0];
  return cycle.tenure_type === "REGULAR" && cycle.total_cycles === 0 &&
    cycle.frequency?.interval_unit === "MONTH" && cycle.frequency?.interval_count === 1 &&
    cycle.pricing_scheme?.fixed_price?.value === "9.99" &&
    cycle.pricing_scheme?.fixed_price?.currency_code === "AUD";
}

let planId;
for (let page = 1; page <= 10 && !planId; page++) {
  const result = await api("/v1/billing/plans?page_size=20&page=" + page + "&total_required=true");
  const rows = result.plans ?? [];
  for (const entry of rows) {
    if (entry.name !== name) continue;
    const plan = await api("/v1/billing/plans/" + encodeURIComponent(entry.id));
    if (!matchesMonthlyPlan(plan)) {
      throw Error("An existing ClientStream billing plan has a conflicting amount, cadence, or inactive status. Resolve it in PayPal before provisioning.");
    }
    planId = plan.id;
    break;
  }
  if (rows.length < 20) break;
}

if (!planId) {
  const product = await api("/v1/catalogs/products", "POST", {
    name: "ClientStream Pro",
    description: "Subscription for ClientStream business management software",
    type: "SERVICE", category: "SOFTWARE",
    home_url: "https://app.clientstream.io"
  });
  if (!product.id) throw Error("PayPal did not return a product ID.");
  const created = await api("/v1/billing/plans", "POST", {
    product_id: product.id,
    name,
    description: "ClientStream Pro: AUD 9.99 every month until cancelled.",
    status: "ACTIVE",
    billing_cycles: [{
      frequency: { interval_unit: "MONTH", interval_count: 1 },
      tenure_type: "REGULAR",
      sequence: 1,
      total_cycles: 0,
      pricing_scheme: { fixed_price: { value: "9.99", currency_code: "AUD" } }
    }],
    payment_preferences: {
      auto_bill_outstanding: true,
      payment_failure_threshold: 1
    }
  });
  planId = created.id;
}
if (!/^P-[A-Z0-9]+$/i.test(planId)) throw Error("PayPal plan ID is invalid.");
const confirmed = await api("/v1/billing/plans/" + encodeURIComponent(planId));
if (!matchesMonthlyPlan(confirmed)) throw Error("PayPal did not confirm the required active AUD 9.99 monthly plan.");

const hooks = await api("/v1/notifications/webhooks");
const existing = (hooks.webhooks ?? []).find((entry) => entry.url === callback);
let webhookId = existing?.id;
if (existing) {
  const registered = new Set((existing.event_types ?? []).map((event) => event.name));
  const absent = types.filter((type) => !registered.has(type) && !registered.has("*"));
  if (absent.length) throw Error("Existing PayPal webhook is missing events: " + absent.join(", ") + ". Update it in PayPal before rerunning.");
} else {
  const created = await api("/v1/notifications/webhooks", "POST", {
    url: callback,
    event_types: types.map((name) => ({ name }))
  });
  webhookId = created.id;
}
if (!/^[A-Z0-9-]{8,70}$/i.test(webhookId)) throw Error("PayPal webhook ID is invalid.");

if (!process.env.GITHUB_OUTPUT) throw Error("GitHub Actions output is missing.");
appendFileSync(process.env.GITHUB_OUTPUT,
  "plan_id=" + planId + "\nwebhook_id=" + webhookId + "\nmode=" + mode + "\n"
);
console.log("PayPal " + mode + " monthly AUD 9.99 plan verified, registered webhook verified.");
console.log("IDs are available only through this workflow's step outputs; no credentials have been printed.");
