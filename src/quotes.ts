import type { Env } from "./types";
import { PLAN_CATALOG } from "./types";
import { requireAuth, requireBusiness } from "./auth";
import { cents, json, mutationOriginIsAllowed, readJson, textValue } from "./http";

function quoteId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/quotes\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function convertQuoteId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/quotes\/([^/]+)\/convert$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function quoteNumber(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return "QTE-" + date + "-" + crypto.randomUUID().slice(0, 6).toUpperCase();
}

function invoiceNumber(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return "INV-" + date + "-" + crypto.randomUUID().slice(0, 6).toUpperCase();
}

export async function listQuotes(request: Request, env: Env): Promise<Response> {
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;

  const result = await env.DB.prepare(
    "SELECT q.id, q.client_id, c.name AS client_name, q.number, q.status, q.currency, q.subtotal_cents, q.tax_cents, q.total_cents, q.issued_at, q.expires_at, q.accepted_at, q.notes, q.created_at FROM quotes q JOIN clients c ON c.id = q.client_id WHERE q.business_id = ? ORDER BY q.created_at DESC LIMIT 500"
  ).bind(business.id).all();

  return json({ quotes: result.results ?? [] });
}

export async function getQuote(request: Request, env: Env): Promise<Response> {
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;

  const id = quoteId(new URL(request.url).pathname);
  if (!id) return json({ error: "Invalid quote id." }, { status: 400 });

  const quote = await env.DB.prepare(
    "SELECT q.*, c.name AS client_name, c.company AS client_company, c.email AS client_email, c.phone AS client_phone, c.address AS client_address, b.name AS business_name, b.business_email, b.business_phone, b.business_address, b.abn FROM quotes q JOIN clients c ON c.id = q.client_id JOIN businesses b ON b.id = q.business_id WHERE q.id = ? AND q.business_id = ? LIMIT 1"
  ).bind(id, business.id).first();
  if (!quote) return json({ error: "Quote not found." }, { status: 404 });

  const items = await env.DB.prepare(
    "SELECT id, description, quantity, unit_price_cents, sort_order FROM quote_items WHERE quote_id = ? ORDER BY sort_order ASC"
  ).bind(id).all();

  return json({ quote, items: items.results ?? [] });
}

export async function createQuote(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) return json({ error: "Origin not allowed." }, { status: 403 });
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;

  const body = await readJson<{
    clientId?: unknown;
    expiresAt?: unknown;
    notes?: unknown;
    taxCents?: unknown;
    items?: unknown;
  }>(request);

  const clientId = typeof body?.clientId === "string" ? body.clientId : "";
  if (!clientId) return json({ error: "A client is required." }, { status: 400 });

  const client = await env.DB.prepare(
    "SELECT id FROM clients WHERE id = ? AND business_id = ? AND status = 'active' LIMIT 1"
  ).bind(clientId, business.id).first<{ id: string }>();
  if (!client) return json({ error: "Selected client is invalid." }, { status: 400 });

  if (!Array.isArray(body?.items) || body.items.length < 1 || body.items.length > 50) {
    return json({ error: "Add at least one quote item." }, { status: 400 });
  }

  const items: Array<{ id: string; description: string; quantity: number; unitPriceCents: number; lineTotalCents: number }> = [];
  for (const raw of body.items) {
    if (!raw || typeof raw !== "object") return json({ error: "Quote item is invalid." }, { status: 400 });
    const item = raw as Record<string, unknown>;
    const description = typeof item.description === "string" ? item.description.trim().slice(0, 500) : "";
    const quantity = typeof item.quantity === "number" && Number.isFinite(item.quantity) ? item.quantity : 0;
    const unitPriceCents = cents(item.unitPriceCents);
    if (!description || quantity <= 0 || quantity > 100000 || unitPriceCents === null) {
      return json({ error: "Each quote item needs a description, quantity and valid price." }, { status: 400 });
    }
    items.push({
      id: crypto.randomUUID(),
      description,
      quantity,
      unitPriceCents,
      lineTotalCents: Math.round(quantity * unitPriceCents)
    });
  }

  const subtotalCents = items.reduce((sum, item) => sum + item.lineTotalCents, 0);
  const taxCents = cents(body?.taxCents) ?? 0;
  const totalCents = subtotalCents + taxCents;
  if (totalCents <= 0) return json({ error: "Quote total must be greater than zero." }, { status: 400 });

  const id = crypto.randomUUID();
  const number = quoteNumber();
  const expiresAt = textValue(body?.expiresAt, 40);
  const notes = textValue(body?.notes, 5000);
  const now = new Date().toISOString();

  const statements = [
    env.DB.prepare(
      "INSERT INTO quotes (id, business_id, client_id, number, status, currency, subtotal_cents, tax_cents, total_cents, expires_at, notes, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', 'AUD', ?, ?, ?, ?, ?, ?, ?)"
    ).bind(id, business.id, clientId, number, subtotalCents, taxCents, totalCents, expiresAt, notes, now, now)
  ];

  items.forEach((item, index) => {
    statements.push(
      env.DB.prepare(
        "INSERT INTO quote_items (id, quote_id, description, quantity, unit_price_cents, sort_order) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(item.id, id, item.description, item.quantity, item.unitPriceCents, index)
    );
  });

  await env.DB.batch(statements);

  return json({
    quote: {
      id,
      client_id: clientId,
      number,
      status: "draft",
      currency: "AUD",
      subtotal_cents: subtotalCents,
      tax_cents: taxCents,
      total_cents: totalCents,
      expires_at: expiresAt,
      notes
    }
  }, { status: 201 });
}

export async function updateQuote(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) return json({ error: "Origin not allowed." }, { status: 403 });
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;

  const id = quoteId(new URL(request.url).pathname);
  if (!id) return json({ error: "Invalid quote id." }, { status: 400 });
  const body = await readJson<{ status?: unknown; expiresAt?: unknown; notes?: unknown }>(request);
  if (!body) return json({ error: "JSON body required." }, { status: 400 });

  const existing = await env.DB.prepare(
    "SELECT status, expires_at, notes, issued_at, accepted_at FROM quotes WHERE id = ? AND business_id = ? LIMIT 1"
  ).bind(id, business.id).first<{
    status: string;
    expires_at: string | null;
    notes: string | null;
    issued_at: string | null;
    accepted_at: string | null;
  }>();
  if (!existing) return json({ error: "Quote not found." }, { status: 404 });

  const allowed = new Set(["draft", "sent", "accepted", "declined", "expired"]);
  const status = typeof body.status === "string" && allowed.has(body.status) ? body.status : existing.status;
  const expiresAt = "expiresAt" in body ? textValue(body.expiresAt, 40) : existing.expires_at;
  const notes = "notes" in body ? textValue(body.notes, 5000) : existing.notes;
  const now = new Date().toISOString();
  const issuedAt = status === "sent" && !existing.issued_at ? now : existing.issued_at;
  const acceptedAt = status === "accepted" && !existing.accepted_at ? now : existing.accepted_at;

  await env.DB.prepare(
    "UPDATE quotes SET status = ?, expires_at = ?, notes = ?, issued_at = ?, accepted_at = ?, updated_at = ? WHERE id = ? AND business_id = ?"
  ).bind(status, expiresAt, notes, issuedAt, acceptedAt, now, id, business.id).run();

  return json({ quote: { id, status, expires_at: expiresAt, issued_at: issuedAt, accepted_at: acceptedAt } });
}

export async function convertQuote(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) return json({ error: "Origin not allowed." }, { status: 403 });
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;

  const id = convertQuoteId(new URL(request.url).pathname);
  if (!id) return json({ error: "Invalid quote id." }, { status: 400 });

  const quote = await env.DB.prepare(
    "SELECT id, client_id, number, subtotal_cents, tax_cents, total_cents, notes FROM quotes WHERE id = ? AND business_id = ? AND status != 'declined' LIMIT 1"
  ).bind(id, business.id).first<{
    id: string;
    client_id: string;
    number: string;
    subtotal_cents: number;
    tax_cents: number;
    total_cents: number;
    notes: string | null;
  }>();
  if (!quote) return json({ error: "Quote not found or cannot be converted." }, { status: 404 });

  const existingInvoice = await env.DB.prepare(
    "SELECT id, number FROM invoices WHERE quote_id = ? AND business_id = ? LIMIT 1"
  ).bind(id, business.id).first<{ id: string; number: string }>();
  if (existingInvoice) return json({ error: "This quote has already been converted.", invoice: existingInvoice }, { status: 409 });

  if (business.plan === "free") {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM invoices WHERE business_id = ? AND status != 'void'"
    ).bind(business.id).first<{ count: number }>();
    if ((row?.count ?? 0) >= PLAN_CATALOG.free.limits.invoices) {
      return json(
        { error: "Free plan invoice limit reached.", code: "PLAN_LIMIT", limit: PLAN_CATALOG.free.limits.invoices },
        { status: 402 }
      );
    }
  }

  const quoteItems = await env.DB.prepare(
    "SELECT description, quantity, unit_price_cents, sort_order FROM quote_items WHERE quote_id = ? ORDER BY sort_order ASC"
  ).bind(id).all<{ description: string; quantity: number; unit_price_cents: number; sort_order: number }>();

  const invoiceId = crypto.randomUUID();
  const number = invoiceNumber();
  const now = new Date().toISOString();

  const statements = [
    env.DB.prepare(
      "INSERT INTO invoices (id, business_id, client_id, quote_id, number, status, currency, subtotal_cents, tax_cents, total_cents, amount_paid_cents, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'draft', 'AUD', ?, ?, ?, 0, ?, ?, ?)"
    ).bind(invoiceId, business.id, quote.client_id, id, number, quote.subtotal_cents, quote.tax_cents, quote.total_cents, quote.notes, now, now),
    env.DB.prepare(
      "UPDATE quotes SET status = 'accepted', accepted_at = COALESCE(accepted_at, ?), updated_at = ? WHERE id = ? AND business_id = ?"
    ).bind(now, now, id, business.id)
  ];

  (quoteItems.results ?? []).forEach((item, index) => {
    statements.push(
      env.DB.prepare(
        "INSERT INTO invoice_items (id, invoice_id, description, quantity, unit_price_cents, sort_order) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(crypto.randomUUID(), invoiceId, item.description, item.quantity, item.unit_price_cents, index)
    );
  });

  await env.DB.batch(statements);

  return json({ invoice: { id: invoiceId, number, quote_id: id } }, { status: 201 });
}
