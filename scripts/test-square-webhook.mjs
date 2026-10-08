import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";

const base = process.env.CLIENTSTREAM_TEST_URL || "http://127.0.0.1:8795";
const url = base + "/api/webhooks/square";
const key = "clientstream-test-webhook-key";
const body = JSON.stringify({
  event_id: "idempotency-" + randomUUID(),
  type: "subscription.updated",
  data: { object: { subscription: { id: "sub-test", customer_id: "customer-test" } } }
});
const signature = createHmac("sha256", key).update(url + body).digest("base64");

async function call(sig) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-square-hmacsha256-signature": sig },
    body
  });
  return { status: response.status, data: await response.json() };
}

const unauthorized = await call("tampered");
assert.equal(unauthorized.status, 403, "tampered signature must be rejected");

const first = await call(signature);
assert.equal(first.status, 200, "valid signature should be accepted");
assert.equal(first.data.received, true);

const repeat = await call(signature);
assert.equal(repeat.status, 200, "duplicate webhook should be acknowledged");
assert.equal(repeat.data.duplicate, true, "terminal event must not be reprocessed");

console.log("Square HMAC verification and duplicate event replay safeguards passed.");
