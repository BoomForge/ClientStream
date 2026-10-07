import type { Env } from "./types";
import { constantTimeEqual, fromBase64, json } from "./http";

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

  let event: { event_id?: string; id?: string; type?: string };
  try {
    event = JSON.parse(rawBody) as typeof event;
  } catch {
    return json({ error: "Invalid JSON." }, { status: 400 });
  }

  const eventId = event.event_id ?? event.id;
  const eventType = event.type;
  if (!eventId || !eventType) return json({ error: "Square event is missing id or type." }, { status: 400 });

  await env.DB.prepare(
    "INSERT OR IGNORE INTO square_webhook_events (id, event_type, payload_json, status, received_at) VALUES (?, ?, ?, 'received', ?)"
  ).bind(eventId, eventType, rawBody, new Date().toISOString()).run();

  return json({ received: true });
}
