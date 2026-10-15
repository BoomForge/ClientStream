import assert from "node:assert/strict";
import { paypalConfig, paypalCall, verifyPayPalEvent } from "../src/paypal.ts";

const env = {
  PAYPAL_CLIENT_ID: "sandbox-client",
  PAYPAL_CLIENT_SECRET: "sandbox-secret",
  PAYPAL_PLAN_ID: "P-TEST123",
  PAYPAL_WEBHOOK_ID: "WH-TEST123",
  PAYPAL_ENVIRONMENT: "sandbox"
};
const seen = [];
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    seen.push({ url, method: options.method ?? "GET", headers: options.headers, body: options.body });
    assert.ok(url.startsWith("https://api-m.sandbox.paypal.com/"), "Requests must stay in the selected PayPal environment");
    if (url.endsWith("/v1/oauth2/token")) {
      assert.equal(options.headers.authorization,
        "Basic " + Buffer.from("sandbox-client:sandbox-secret").toString("base64"));
      return new Response(JSON.stringify({ access_token: "sandbox-test-token" }), { status: 200 });
    }
    assert.equal(options.headers.authorization, "Bearer sandbox-test-token");
    if (url.endsWith("/v1/billing/plans/P-TEST123")) {
      return new Response(JSON.stringify({ id: "P-TEST123", status: "ACTIVE" }), { status: 200 });
    }
    if (url.endsWith("/v1/notifications/verify-webhook-signature")) {
      const body = JSON.parse(options.body);
      assert.equal(body.webhook_id, env.PAYPAL_WEBHOOK_ID);
      assert.equal(body.transmission_id, "tx-test-001");
      assert.equal(body.webhook_event.id, "WH-EVENT-001");
      return new Response(JSON.stringify({ verification_status: "SUCCESS" }), { status: 200 });
    }
    throw Error("Unexpected PayPal path " + url);
  };

  assert.equal(paypalConfig({ ...env, PAYPAL_ENVIRONMENT: undefined }), null);
  assert.equal(paypalConfig(env)?.mode, "sandbox");
  const plan = await paypalCall(env, "/v1/billing/plans/P-TEST123");
  assert.equal(plan.id, "P-TEST123");

  const now = new Date().toISOString();
  const event = { id: "WH-EVENT-001", event_type: "BILLING.SUBSCRIPTION.ACTIVATED" };
  const headers = {
    "paypal-transmission-id": "tx-test-001",
    "paypal-transmission-time": now,
    "paypal-transmission-sig": "signed-test",
    "paypal-cert-url": "https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-123",
    "paypal-auth-algo": "SHA256withRSA"
  };
  const req = new Request("https://app.clientstream.io/api/webhooks/paypal", { method: "POST", headers });
  assert.equal(await verifyPayPalEvent(env, req, event), true);

  const forgedReq = new Request("https://app.clientstream.io/api/webhooks/paypal", {
    method: "POST",
    headers: { ...headers, "paypal-cert-url": "https://api-m.sandbox.paypal.com.evil.example/certs/123" }
  });
  const previousCalls = seen.length;
  assert.equal(await verifyPayPalEvent(env, forgedReq, event), false);
  assert.equal(seen.length, previousCalls, "Forged certificate domain should be refused without PayPal calls");
  console.log("PayPal OAuth, API environment, webhook verification and forged-certificate rejection passed.");
} finally {
  globalThis.fetch = originalFetch;
}
