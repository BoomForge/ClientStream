import type { Env } from "./types";
import { constantTimeEqual, fromBase64, json } from "./http";
import { processSquareSubscriptionEvent } from "./billing";
import type { SquareSubscription } from "./billing";

async function signatureIsValid(
  signature: string,
  rawBody: string,
  signatureKey: string,
  notificationUrl: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signatureKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signedBytes = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(notificationUrl + rawBody)
    )
  );
  let binary = "";
  for (const byte of signedBytes) binary += String.fromCharCode(byte);
  const expected = fromBase64(btoa(binary));
  const actual = fromBase64(signature);
  return Boolean(expected && actual && constantTimeEqual(expected, actual));
}

export async function squareWebhook(request: Request, env: Env): Promise<Response> {
  const signature = request.headers.get("x-square-hmacsha256-signature");
  if (!signature) return json({ error: "Missing Square signature." }, { status: 401 });
  if (!env.SQUARE_WEBHOOK_SIGNATURE_KEY) {
    return json({ error: "Square webhook is not configured." }, { status: 503 });
  }

  const rawBody = await request.text();
  if (rawBody.length > 1_000_000) return json({ error: "Webhook body too large." }, { status: 413 });

  const notificationUrl = env.SQUARE_WEBHOOK_URL ?? request.url;
  if (!(await signatureIsValid(signature, rawBody, env.SQUARE_WEBHOOK_SIGNATURE_KEY, notificationUrl))) {
    return json({ error: "Invalid Square signature." }, { status: 403 });
  }

  let event: { event_id?: string; id?: string; type?: string; data?: { object?: { subscription?: SquareSubscription } } };
  try {
    event = JSON.parse(rawBody) as typeof event;
  } catch {
    return json({ error: "Invalid JSON." }, { status: 400 });
  }

  const eventId = event.event_id ?? event.id;
  const eventType = event.type;
  if (!eventId || !eventType) return json({ error: "Square event is missing id or type." }, { status: 400 });

  const now = new Date().toISOString();
  const inserted = await env.DB.prepare(
    "INSERT OR IGNORE INTO square_webhook_events (id, event_type, payload_json, status, received_at) VALUES (?, ?, ?, 'received', ?)"
  ).bind(eventId, eventType, rawBody, now).run();

  if (inserted.meta.changes !== 1) {
    // Square retries and can deliver duplicates. Do not re-apply terminal events.
    const row = await env.DB.prepare(
      "SELECT status FROM square_webhook_events WHERE id = ?"
    ).bind(eventId).first<{ status: string }>();
    if (row?.status === "processed" || row?.status === "ignored") {
      return json({ received: true, duplicate: true });
    }
    // Retry previously failed events and recover stale claimed events, but
    // don't process the same ID concurrently while the first call is running.
    const cutoff = new Date(Date.now() - 60_000).toISOString();
    const claim = await env.DB.prepare(
      "UPDATE square_webhook_events SET status = 'received', received_at = ?, processed_at = NULL, error = NULL WHERE id = ? AND (status = 'failed' OR (status = 'received' AND received_at < ?))"
    ).bind(now, eventId, cutoff).run();
    if (claim.meta.changes !== 1) {
      return json({ error: "Webhook processing is already underway; retry later." }, { status: 503 });
    }
  }

  try {
    const status = await processSquareSubscriptionEvent(env, event);
    await env.DB.prepare(
      "UPDATE square_webhook_events SET status = ?, processed_at = ? WHERE id = ?"
    ).bind(status === "processed" ? "processed" : "ignored", new Date().toISOString(), eventId).run();
  } catch (error) {
    await env.DB.prepare(
      "UPDATE square_webhook_events SET status = 'failed', error = ? WHERE id = ?"
    ).bind(error instanceof Error ? error.message.slice(0, 1000) : "Unknown processing error", eventId).run();
    return json({ error: "Webhook processing failed." }, { status: 500 });
  }

  return json({ received: true });
}
