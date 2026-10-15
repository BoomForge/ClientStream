import type { Env } from "./types";
import { json } from "./http";
import { paypalConfig, verifyPayPalEvent } from "./paypal";
import { reconcileLinkedSubscription } from "./billing";

// Never allow a verified but unassociated PayPal event to attach itself to a
// business using the subscriber's email. Only subscriptions created by our
// authenticated owner checkout and stored locally can affect entitlements.
function subscriptionIdFromEvent(event: {
  event_type?: string;
  resource?: { id?: string; billing_agreement_id?: string; subscription_id?: string };
}): string | null {
  const type = event.event_type ?? "";
  let id: string | undefined;
  if (type.startsWith("BILLING.SUBSCRIPTION.")) id = event.resource?.id;
  else if (type === "PAYMENT.SALE.COMPLETED" || type === "PAYMENT.SALE.DENIED" ||
           type === "PAYMENT.SALE.REFUNDED" || type === "PAYMENT.SALE.REVERSED") {
    id = event.resource?.billing_agreement_id ?? event.resource?.subscription_id;
  }
  return id && /^I-[A-Z0-9]+$/i.test(id) ? id : null;
}

export async function paypalWebhook(request: Request, env: Env): Promise<Response> {
  const config = paypalConfig(env);
  if (!config?.webhookId) return json({ error: "PayPal webhooks are not configured." }, { status: 503 });
  const raw = await request.text();
  if (raw.length > 500_000) return json({ error: "Webhook payload too large." }, { status: 413 });
  let event: {
    id?: string; event_type?: string;
    resource?: { id?: string; billing_agreement_id?: string; subscription_id?: string };
  };
  try { event = JSON.parse(raw) as typeof event; }
  catch { return json({ error: "Invalid webhook JSON." }, { status: 400 }); }
  if (typeof event.id !== "string" || !/^[A-Za-z0-9-]{8,90}$/.test(event.id) ||
      typeof event.event_type !== "string") return json({ error: "Invalid PayPal event." }, { status: 400 });

  try {
    if (!await verifyPayPalEvent(env, request, event)) return json({ error: "Invalid PayPal signature." }, { status: 403 });
  } catch {
    // Transient PayPal API failures must retry, not be treated as authenticated.
    return json({ error: "Unable to verify PayPal signature." }, { status: 503 });
  }
  const now = new Date().toISOString();
  const inserted = await env.DB.prepare(
    "INSERT OR IGNORE INTO paypal_webhook_events (id, event_type, status, received_at) VALUES (?, ?, 'received', ?)"
  ).bind(event.id, event.event_type, now).run();
  if (inserted.meta.changes !== 1) {
    const row = await env.DB.prepare(
      "SELECT status FROM paypal_webhook_events WHERE id = ?"
    ).bind(event.id).first<{ status: string }>();
    if (row?.status === "processed" || row?.status === "ignored") return json({ received: true, duplicate: true });

    const cutoff = new Date(Date.now() - 60_000).toISOString();
    const claim = await env.DB.prepare(
      "UPDATE paypal_webhook_events SET status = 'received', received_at = ?, processed_at = NULL, error = NULL WHERE id = ? AND (status = 'failed' OR (status = 'received' AND received_at < ?))"
    ).bind(now, event.id, cutoff).run();
    if (claim.meta.changes !== 1) return json({ error: "Webhook already being processed; retry." }, { status: 503 });
  }

  try {
    const subscriptionId = subscriptionIdFromEvent(event);
    const matched = subscriptionId ? await reconcileLinkedSubscription(env, subscriptionId) : false;
    await env.DB.prepare(
      "UPDATE paypal_webhook_events SET status = ?, processed_at = ? WHERE id = ?"
    ).bind(matched ? "processed" : "ignored", new Date().toISOString(), event.id).run();
  } catch {
    await env.DB.prepare(
      "UPDATE paypal_webhook_events SET status = 'failed', processed_at = ? WHERE id = ?"
    ).bind(new Date().toISOString(), event.id).run();
    return json({ error: "PayPal webhook processing failed." }, { status: 503 });
  }
  return json({ received: true });
}
