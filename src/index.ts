interface Env {
  ASSETS: Fetcher;
  DB?: D1Database;
  APP_ENV?: string;
  SQUARE_WEBHOOK_SIGNATURE_KEY?: string;
  SQUARE_WEBHOOK_URL?: string;
}

const VERSION = "0.1.0-foundation";

const PLAN_CATALOG = {
  free: {
    id: "free",
    name: "Free",
    monthlyAudCents: 0,
    limits: {
      clients: 10,
      invoices: 10,
      smartWriteGenerationsPerMonth: 5
    }
  },
  pro: {
    id: "pro",
    name: "Pro",
    monthlyAudCents: 999,
    limits: {
      clients: null,
      invoices: null,
      smartWriteGenerationsPerMonth: 100
    }
  }
} as const;

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "cache-control": "no-store"
};

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");

  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value);
  }

  return new Response(JSON.stringify(data), { ...init, headers });
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    const decoded = atob(value);
    return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function constantTimeEqualBase64(left: string, right: string): boolean {
  const a = decodeBase64(left);
  const b = decodeBase64(right);
  if (!a || !b || a.length !== b.length) return false;

  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a[index] ^ b[index];
  }
  return difference === 0;
}

async function squareSignatureIsValid(
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

  const expected = btoa(String.fromCharCode(...signedBytes));
  return constantTimeEqualBase64(signature, expected);
}

async function handleSquareWebhook(request: Request, env: Env): Promise<Response> {
  const signature = request.headers.get("x-square-hmacsha256-signature");
  if (!signature) {
    return json({ error: "Missing Square signature." }, { status: 401 });
  }

  if (!env.SQUARE_WEBHOOK_SIGNATURE_KEY) {
    return json(
      { error: "Square webhook is not configured." },
      { status: 503 }
    );
  }

  const rawBody = await request.text();
  if (rawBody.length > 1_000_000) {
    return json({ error: "Webhook body too large." }, { status: 413 });
  }

  const notificationUrl = env.SQUARE_WEBHOOK_URL ?? request.url;
  const valid = await squareSignatureIsValid(
    signature,
    rawBody,
    env.SQUARE_WEBHOOK_SIGNATURE_KEY,
    notificationUrl
  );

  if (!valid) {
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
  if (!eventId || !eventType) {
    return json({ error: "Square event is missing id or type." }, { status: 400 });
  }

  if (!env.DB) {
    return json(
      { error: "Database is not bound; webhook was not persisted." },
      { status: 503 }
    );
  }

  const receivedAt = new Date().toISOString();

  await env.DB.prepare(
    `INSERT OR IGNORE INTO square_webhook_events
       (id, event_type, payload_json, status, received_at)
     VALUES (?, ?, ?, 'received', ?)`
  )
    .bind(eventId, eventType, rawBody, receivedAt)
    .run();

  return json({ received: true }, { status: 200 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return new Response(null, { status: 204 });
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      return json({
        status: "ok",
        service: "clientstream",
        version: VERSION,
        environment: env.APP_ENV ?? "unknown",
        database: env.DB ? "bound" : "unbound",
        squareWebhook: env.SQUARE_WEBHOOK_SIGNATURE_KEY
          ? "configured"
          : "unconfigured",
        timestamp: new Date().toISOString()
      });
    }

    if (request.method === "GET" && url.pathname === "/api/plans") {
      return json({ plans: PLAN_CATALOG });
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/webhooks/square"
    ) {
      return handleSquareWebhook(request, env);
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ error: "Not found." }, { status: 404 });
    }

    return env.ASSETS.fetch(request);
  }
} satisfies ExportedHandler<Env>;
