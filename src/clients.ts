import type { Env } from "./types";
import { PLAN_CATALOG } from "./types";
import { requireAuth, requireBusiness } from "./auth";
import {
  json,
  mutationOriginIsAllowed,
  normaliseEmail,
  readJson,
  textValue,
  validEmail
} from "./http";

function clientId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/clients\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

export async function listClients(request: Request, env: Env): Promise<Response> {
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;

  const result = await env.DB.prepare(
    "SELECT id, name, company, email, phone, address, notes, status, created_at, updated_at FROM clients WHERE business_id = ? AND status = 'active' ORDER BY name COLLATE NOCASE ASC LIMIT 500"
  ).bind(business.id).all();

  return json({ clients: result.results ?? [] });
}

export async function createClient(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) return json({ error: "Origin not allowed." }, { status: 403 });

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
    return json({ error: "Client name must be between 1 and 160 characters." }, { status: 400 });
  }

  const email = typeof body?.email === "string" && body.email.trim()
    ? normaliseEmail(body.email)
    : null;
  if (email && !validEmail(email)) return json({ error: "Client email address is invalid." }, { status: 400 });

  if (business.plan === "free") {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM clients WHERE business_id = ? AND status = 'active'"
    ).bind(business.id).first<{ count: number }>();

    if ((row?.count ?? 0) >= PLAN_CATALOG.free.limits.clients) {
      return json(
        { error: "Free plan client limit reached.", code: "PLAN_LIMIT", limit: PLAN_CATALOG.free.limits.clients },
        { status: 402 }
      );
    }
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const company = textValue(body?.company, 160);
  const phone = textValue(body?.phone, 60);
  const address = textValue(body?.address, 1000);
  const notes = textValue(body?.notes, 5000);

  await env.DB.prepare(
    "INSERT INTO clients (id, business_id, name, company, email, phone, address, notes, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)"
  ).bind(id, business.id, name, company, email, phone, address, notes, now, now).run();

  return json({
    client: { id, name, company, email, phone, address, notes, status: "active", created_at: now, updated_at: now }
  }, { status: 201 });
}

export async function updateClient(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) return json({ error: "Origin not allowed." }, { status: 403 });

  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;

  const id = clientId(new URL(request.url).pathname);
  if (!id) return json({ error: "Invalid client id." }, { status: 400 });

  const body = await readJson<Record<string, unknown>>(request);
  if (!body) return json({ error: "JSON body required." }, { status: 400 });

  const existing = await env.DB.prepare(
    "SELECT name, company, email, phone, address, notes FROM clients WHERE id = ? AND business_id = ? AND status = 'active' LIMIT 1"
  ).bind(id, business.id).first<{
    name: string;
    company: string | null;
    email: string | null;
    phone: string | null;
    address: string | null;
    notes: string | null;
  }>();
  if (!existing) return json({ error: "Client not found." }, { status: 404 });

  const next = (field: string, current: string | null, max: number): string | null => {
    if (!(field in body)) return current;
    const supplied = body[field];
    if (supplied === null) return null;
    if (typeof supplied !== "string") return current;
    return supplied.trim() ? supplied.trim().slice(0, max) : null;
  };

  const name = typeof body.name === "string" ? body.name.trim().slice(0, 160) : existing.name;
  if (!name) return json({ error: "Client name cannot be empty." }, { status: 400 });

  let email = next("email", existing.email, 254);
  if (email) {
    email = normaliseEmail(email);
    if (!validEmail(email)) return json({ error: "Client email address is invalid." }, { status: 400 });
  }

  const company = next("company", existing.company, 160);
  const phone = next("phone", existing.phone, 60);
  const address = next("address", existing.address, 1000);
  const notes = next("notes", existing.notes, 5000);
  const now = new Date().toISOString();

  await env.DB.prepare(
    "UPDATE clients SET name = ?, company = ?, email = ?, phone = ?, address = ?, notes = ?, updated_at = ? WHERE id = ? AND business_id = ? AND status = 'active'"
  ).bind(name, company, email, phone, address, notes, now, id, business.id).run();

  return json({ client: { id, name, company, email, phone, address, notes, status: "active", updated_at: now } });
}

export async function archiveClient(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) return json({ error: "Origin not allowed." }, { status: 403 });

  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;
  const id = clientId(new URL(request.url).pathname);
  if (!id) return json({ error: "Invalid client id." }, { status: 400 });

  const result = await env.DB.prepare(
    "UPDATE clients SET status = 'archived', updated_at = ? WHERE id = ? AND business_id = ? AND status = 'active'"
  ).bind(new Date().toISOString(), id, business.id).run();

  return result.meta.changes
    ? json({ archived: true })
    : json({ error: "Client not found." }, { status: 404 });
}
