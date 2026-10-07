interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  APP_ENV?: string;
  SQUARE_WEBHOOK_SIGNATURE_KEY?: string;
  SQUARE_WEBHOOK_URL?: string;
}

type PlanId = "free" | "pro";

interface SessionUser {
  id: string;
  email: string;
  displayName: string | null;
}

interface BusinessContext {
  id: string;
  name: string;
  slug: string;
  plan: PlanId;
  role: "owner" | "admin" | "member";
}

interface AuthContext {
  user: SessionUser;
  business: BusinessContext | null;
}

const VERSION = "0.2.0-d1-auth-clients";
const SESSION_COOKIE = "cs_session";

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

function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.get("cookie") ?? "";
  const cookies: Record<string, string> = {};

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }

  return cookies;
}

function mutationOriginIsAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  return origin === new URL(request.url).origin;
}

function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

function slugify(value: string): string {
  const base = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return base || "business";
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

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );

  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function readJson<T>(request: Request): Promise<T | null> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) return null;

  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

async function getAuthContext(request: Request, env: Env): Promise<AuthContext | null> {
  const rawToken = parseCookies(request)[SESSION_COOKIE];
  if (!rawToken || rawToken.length < 32) return null;

  const tokenHash = await sha256Hex(rawToken);
  const now = new Date().toISOString();

  const userRow = await env.DB.prepare(
    `SELECT u.id, u.email, u.display_name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?
      LIMIT 1`
  )
    .bind(tokenHash, now)
    .first<{ id: string; email: string; display_name: string | null }>();

  if (!userRow) return null;

  const businessRow = await env.DB.prepare(
    `SELECT b.id, b.name, b.slug, b.plan, m.role
       FROM memberships m
       JOIN businesses b ON b.id = m.business_id
      WHERE m.user_id = ?
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
               b.created_at ASC
      LIMIT 1`
  )
    .bind(userRow.id)
    .first<{
      id: string;
      name: string;
      slug: string;
      plan: PlanId;
      role: "owner" | "admin" | "member";
    }>();

  return {
    user: {
      id: userRow.id,
      email: normaliseEmail(userRow.email),
      displayName: userRow.display_name
    },
    business: businessRow
      ? {
          id: businessRow.id,
          name: businessRow.name,
          slug: businessRow.slug,
          plan: businessRow.plan,
          role: businessRow.role
        }
      : null
  };
}

async function requireAuth(request: Request, env: Env): Promise<AuthContext | Response> {
  const context = await getAuthContext(request, env);
  return context ?? json({ error: "Authentication required." }, { status: 401 });
}

function requireBusiness(context: AuthContext): BusinessContext | Response {
  return (
    context.business ??
    json(
      { error: "Business onboarding is required.", code: "BUSINESS_REQUIRED" },
      { status: 409 }
    )
  );
}

async function handleMe(request: Request, env: Env): Promise<Response> {
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;

  return json({
    user: context.user,
    business: context.business,
    plan: context.business ? PLAN_CATALOG[context.business.plan] : null
  });
}

async function handleBusinessOnboarding(
  request: Request,
  env: Env
): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) {
    return json({ error: "Origin not allowed." }, { status: 403 });
  }

  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;

  if (context.business) {
    return json({ error: "This account already has a business." }, { status: 409 });
  }

  const body = await readJson<{ name?: unknown }>(request);
  const name = typeof body?.name === "string" ? body.name.trim() : "";

  if (name.length < 2 || name.length > 120) {
    return json(
      { error: "Business name must be between 2 and 120 characters." },
      { status: 400 }
    );
  }

  const businessId = crypto.randomUUID();
  const slug = `${slugify(name)}-${businessId.slice(0, 8)}`;
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO businesses
        (id, name, slug, owner_user_id, plan, timezone, currency, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'free', 'Australia/Hobart', 'AUD', ?, ?)`
    ).bind(businessId, name, slug, context.user.id, now, now),
    env.DB.prepare(
      `INSERT INTO memberships (business_id, user_id, role, created_at)
       VALUES (?, ?, 'owner', ?)`
    ).bind(businessId, context.user.id, now)
  ]);

  return json(
    {
      business: {
        id: businessId,
        name,
        slug,
        plan: "free",
        role: "owner"
      }
    },
    { status: 201 }
  );
}

async function handleListClients(request: Request, env: Env): Promise<Response> {
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;

  const business = requireBusiness(context);
  if (business instanceof Response) return business;

  const result = await env.DB.prepare(
    `SELECT id, name, company, email, phone, address, notes, status, created_at, updated_at
       FROM clients
      WHERE business_id = ? AND status = 'active'
      ORDER BY name COLLATE NOCASE ASC
      LIMIT 500`
  )
    .bind(business.id)
    .all();

  return json({ clients: result.results ?? [] });
}

async function handleCreateClient(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) {
    return json({ error: "Origin not allowed." }, { status: 403 });
  }

  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;

  const business = requireBusiness(context);
  if (business instanceof Response) return business;

  const body = await readJson<{
    name?: unknown;
    company?: unknown;
    email?: unknown;
    phone?: unknown;
    address?: unknown;
    notes?: unknown;
  }>(request);

  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (name.length < 1 || name.length > 160) {
    return json(
      { error: "Client name must be between 1 and 160 characters." },
      { status: 400 }
    );
  }

  const email =
    typeof body?.email === "string" && body.email.trim()
      ? normaliseEmail(body.email)
      : null;

  if (email && !validEmail(email)) {
    return json({ error: "Client email address is invalid." }, { status: 400 });
  }

  if (business.plan === "free") {
    const countRow = await env.DB.prepare(
      `SELECT COUNT(*) AS count
         FROM clients
        WHERE business_id = ? AND status = 'active'`
    )
      .bind(business.id)
      .first<{ count: number }>();

    const limit = PLAN_CATALOG.free.limits.clients;
    if ((countRow?.count ?? 0) >= limit) {
      return json(
        {
          error: "Free plan client limit reached.",
          code: "PLAN_LIMIT",
          limit
        },
        { status: 402 }
      );
    }
  }

  const clientId = crypto.randomUUID();
  const now = new Date().toISOString();
  const text = (value: unknown, max: number): string | null =>
    typeof value === "string" && value.trim()
      ? value.trim().slice(0, max)
      : null;

  await env.DB.prepare(
    `INSERT INTO clients
      (id, business_id, name, company, email, phone, address, notes, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
  )
    .bind(
      clientId,
      business.id,
      name,
      text(body?.company, 160),
      email,
      text(body?.phone, 60),
      text(body?.address, 1000),
      text(body?.notes, 5000),
      now,
      now
    )
    .run();

  return json(
    {
      client: {
        id: clientId,
        name,
        company: text(body?.company, 160),
        email,
        phone: text(body?.phone, 60),
        address: text(body?.address, 1000),
        notes: text(body?.notes, 5000),
        status: "active",
        created_at: now,
        updated_at: now
      }
    },
    { status: 201 }
  );
}

function clientIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/clients\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function handleUpdateClient(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) {
    return json({ error: "Origin not allowed." }, { status: 403 });
  }

  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;

  const clientId = clientIdFromPath(new URL(request.url).pathname);
  if (!clientId) return json({ error: "Invalid client id." }, { status: 400 });

  const body = await readJson<Record<string, unknown>>(request);
  if (!body) return json({ error: "JSON body required." }, { status: 400 });

  const existing = await env.DB.prepare(
    `SELECT id, name, company, email, phone, address, notes
       FROM clients
      WHERE id = ? AND business_id = ? AND status = 'active'
      LIMIT 1`
  )
    .bind(clientId, business.id)
    .first<{
      id: string;
      name: string;
      company: string | null;
      email: string | null;
      phone: string | null;
      address: string | null;
      notes: string | null;
    }>();

  if (!existing) return json({ error: "Client not found." }, { status: 404 });

  const value = (field: string, current: string | null, max: number): string | null => {
    if (!(field in body)) return current;
    const supplied = body[field];
    if (supplied === null) return null;
    if (typeof supplied !== "string") return current;
    const trimmed = supplied.trim();
    return trimmed ? trimmed.slice(0, max) : null;
  };

  const nameValue =
    "name" in body && typeof body.name === "string"
      ? body.name.trim().slice(0, 160)
      : existing.name;

  if (!nameValue) {
    return json({ error: "Client name cannot be empty." }, { status: 400 });
  }

  let emailValue = value("email", existing.email, 254);
  if (emailValue) {
    emailValue = normaliseEmail(emailValue);
    if (!validEmail(emailValue)) {
      return json({ error: "Client email address is invalid." }, { status: 400 });
    }
  }

  const company = value("company", existing.company, 160);
  const phone = value("phone", existing.phone, 60);
  const address = value("address", existing.address, 1000);
  const notes = value("notes", existing.notes, 5000);
  const now = new Date().toISOString();

  await env.DB.prepare(
    `UPDATE clients
        SET name = ?, company = ?, email = ?, phone = ?, address = ?, notes = ?, updated_at = ?
      WHERE id = ? AND business_id = ? AND status = 'active'`
  )
    .bind(
      nameValue,
      company,
      emailValue,
      phone,
      address,
      notes,
      now,
      clientId,
      business.id
    )
    .run();

  return json({
    client: {
      id: clientId,
      name: nameValue,
      company,
      email: emailValue,
      phone,
      address,
      notes,
      status: "active",
      updated_at: now
    }
  });
}

async function handleArchiveClient(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) {
    return json({ error: "Origin not allowed." }, { status: 403 });
  }

  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;

  const clientId = clientIdFromPath(new URL(request.url).pathname);
  if (!clientId) return json({ error: "Invalid client id." }, { status: 400 });

  const result = await env.DB.prepare(
    `UPDATE clients
        SET status = 'archived', updated_at = ?
      WHERE id = ? AND business_id = ? AND status = 'active'`
  )
    .bind(new Date().toISOString(), clientId, business.id)
    .run();

  if (!result.meta.changes) {
    return json({ error: "Client not found." }, { status: 404 });
  }

  return json({ archived: true });
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
        database: "bound",
        squareWebhook: env.SQUARE_WEBHOOK_SIGNATURE_KEY
          ? "configured"
          : "unconfigured",
        timestamp: new Date().toISOString()
      });
    }

    if (request.method === "GET" && url.pathname === "/api/plans") {
      return json({ plans: PLAN_CATALOG });
    }

    if (request.method === "GET" && url.pathname === "/api/me") {
      return handleMe(request, env);
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/onboarding/business"
    ) {
      return handleBusinessOnboarding(request, env);
    }

    if (request.method === "GET" && url.pathname === "/api/clients") {
      return handleListClients(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/clients") {
      return handleCreateClient(request, env);
    }

    if (url.pathname.startsWith("/api/clients/")) {
      if (request.method === "PATCH") return handleUpdateClient(request, env);
      if (request.method === "DELETE") return handleArchiveClient(request, env);
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
