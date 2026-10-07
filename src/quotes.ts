import type { Env } from "./types";
import { PLAN_CATALOG } from "./types";
import { requireAuth, requireBusiness } from "./auth";
import { json, mutationOriginIsAllowed, readJson, textValue } from "./http";
import { documentTotals, nextDocumentNumber, parseDocumentItems, taxModeFrom, type TaxMode } from "./documents";

function quoteId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/quotes\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function convertQuoteId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/quotes\/([^/]+)\/convert$/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function businessGstRegistered(env: Env, businessId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT gst_registered FROM businesses WHERE id = ? LIMIT 1"
  ).bind(businessId).first<{ gst_registered: number }>();
  return Boolean(row?.gst_registered);
}

async function refreshExpired(env: Env, businessId: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  await env.DB.prepare(
    "UPDATE quotes SET status = 'expired', updated_at = ? WHERE business_id = ? AND status = 'sent' AND expires_at IS NOT NULL AND substr(expires_at,1,10) < ?"
  ).bind(new Date().toISOString(), businessId, today).run();
}

export async function listQuotes(request: Request, env: Env): Promise<Response> {
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;

  await refreshExpired(env, business.id);

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

  await refreshExpired(env, business.id);

  const id = quoteId(new URL(request.url).pathname);
  if (!id) return json({ error: "Invalid quote id." }, { status: 400 });

  const quote = await env.DB.prepare(
    "SELECT q.*, c.name AS client_name, c.company AS client_company, c.email AS client_email, c.phone AS client_phone, c.address AS client_address, b.name AS business_name, b.abn AS business_abn, b.business_email, b.business_phone, b.business_address FROM quotes q JOIN clients c ON c.id = q.client_id JOIN businesses b ON b.id = q.business_id WHERE q.id = ? AND q.business_id = ? LIMIT 1"
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
    taxMode?: unknown;
    items?: unknown;
  }>(request);

  const clientId = typeof body?.clientId === "string" ? body.clientId : "";
  if (!clientId) return json({ error: "A client is required." }, { status: 400 });

  const client = await env.DB.prepare(
    "SELECT id FROM clients WHERE id = ? AND business_id = ? AND status = 'active' LIMIT 1"
  ).bind(clientId, business.id).first<{ id: string }>();
  if (!client) return json({ error: "Selected client is invalid." }, { status: 400 });

  const parsed = parseDocumentItems(body?.items);
  if (!parsed.items) return json({ error: parsed.error }, { status: 400 });

  const taxMode = taxModeFrom(body?.taxMode, await businessGstRegistered(env, business.id));
  const totals = documentTotals(parsed.items, taxMode);
  if (totals.totalCents <= 0) return json({ error: "Quote total must be greater than zero." }, { status: 400 });

  const id = crypto.randomUUID();
  const number = await nextDocumentNumber(env, business.id, "quote");
  const expiresAt = textValue(body?.expiresAt, 40);
  const notes = textValue(body?.notes, 5000);
  const now = new Date().toISOString();

  const statements = [
    env.DB.prepare(
      "INSERT INTO quotes (id, business_id, client_id, number, status, currency, subtotal_cents, tax_cents, total_cents, expires_at, notes, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', 'AUD', ?, ?, ?, ?, ?, ?, ?)"
    ).bind(id, business.id, clientId, number, totals.subtotalCents, totals.taxCents, totals.totalCents, expiresAt, notes, now, now)
  ];

  parsed.items.forEach((item, index) => {
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
      subtotal_cents: totals.subtotalCents,
      tax_cents: totals.taxCents,
      total_cents: totals.totalCents,
      expires_at: expiresAt,
      notes,
      taxMode,
      items: parsed.items
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

  const body = await readJson<{
    status?: unknown;
    expiresAt?: unknown;
    notes?: unknown;
    clientId?: unknown;
    taxMode?: unknown;
    items?: unknown;
  }>(request);
  if (!body) return json({ error: "JSON body required." }, { status: 400 });

  const existing = await env.DB.prepare(
    "SELECT client_id, status, expires_at, notes, issued_at, accepted_at, subtotal_cents, tax_cents, total_cents FROM quotes WHERE id = ? AND business_id = ? LIMIT 1"
  ).bind(id, business.id).first<{
    client_id: string;
    status: string;
    expires_at: string | null;
    notes: string | null;
    issued_at: string | null;
    accepted_at: string | null;
    subtotal_cents: number;
    tax_cents: number;
    total_cents: number;
  }>();
  if (!existing) return json({ error: "Quote not found." }, { status: 404 });

  let clientId = existing.client_id;
  let subtotalCents = existing.subtotal_cents;
  let taxCents = existing.tax_cents;
  let totalCents = existing.total_cents;
  let replacementItems: ReturnType<typeof parseDocumentItems>["items"] | undefined;

  const changingDraftContent = "clientId" in body || "items" in body || "taxMode" in body;
  if (changingDraftContent && existing.status !== "draft") {
    return json({ error: "Only draft quotes can have their client, line items or GST changed." }, { status: 409 });
  }

  if ("clientId" in body) {
    clientId = typeof body.clientId === "string" ? body.clientId : "";
    const client = await env.DB.prepare(
      "SELECT id FROM clients WHERE id = ? AND business_id = ? AND status = 'active' LIMIT 1"
    ).bind(clientId, business.id).first<{ id: string }>();
    if (!client) return json({ error: "Selected client is invalid." }, { status: 400 });
  }

  if ("items" in body || "taxMode" in body) {
    const currentItems = "items" in body
      ? body.items
      : (await env.DB.prepare(
          "SELECT description, quantity, unit_price_cents AS unitPriceCents FROM quote_items WHERE quote_id = ? ORDER BY sort_order ASC"
        ).bind(id).all()).results;

    const parsed = parseDocumentItems(currentItems);
    if (!parsed.items) return json({ error: parsed.error }, { status: 400 });
    replacementItems = parsed.items;

    let taxMode: TaxMode = existing.tax_cents > 0 ? "gst10" : "none";
    if ("taxMode" in body) {
      taxMode = taxModeFrom(body.taxMode, await businessGstRegistered(env, business.id));
    }

    const totals = documentTotals(parsed.items, taxMode);
    if (totals.totalCents <= 0) return json({ error: "Quote total must be greater than zero." }, { status: 400 });
    subtotalCents = totals.subtotalCents;
    taxCents = totals.taxCents;
    totalCents = totals.totalCents;
  }

  const allowed = new Set(["draft", "sent", "accepted", "declined", "expired"]);
  const status = typeof body.status === "string" && allowed.has(body.status) ? body.status : existing.status;
  const expiresAt = "expiresAt" in body ? textValue(body.expiresAt, 40) : existing.expires_at;
  const notes = "notes" in body ? textValue(body.notes, 5000) : existing.notes;
  const now = new Date().toISOString();
  const issuedAt = status === "sent" && !existing.issued_at ? now : existing.issued_at;
  const acceptedAt = status === "accepted" && !existing.accepted_at ? now : existing.accepted_at;

  const statements = [
    env.DB.prepare(
      "UPDATE quotes SET client_id = ?, status = ?, subtotal_cents = ?, tax_cents = ?, total_cents = ?, expires_at = ?, notes = ?, issued_at = ?, accepted_at = ?, updated_at = ? WHERE id = ? AND business_id = ?"
    ).bind(clientId, status, subtotalCents, taxCents, totalCents, expiresAt, notes, issuedAt, acceptedAt, now, id, business.id)
  ];

  if (replacementItems) {
    statements.push(env.DB.prepare("DELETE FROM quote_items WHERE quote_id = ?").bind(id));
    replacementItems.forEach((item, index) => {
      statements.push(
        env.DB.prepare(
          "INSERT INTO quote_items (id, quote_id, description, quantity, unit_price_cents, sort_order) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(item.id, id, item.description, item.quantity, item.unitPriceCents, index)
      );
    });
  }

  await env.DB.batch(statements);

  return json({
    quote: {
      id,
      client_id: clientId,
      status,
      subtotal_cents: subtotalCents,
      tax_cents: taxCents,
      total_cents: totalCents,
      expires_at: expiresAt,
      notes,
      issued_at: issuedAt,
      accepted_at: acceptedAt
    }
  });
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
    "SELECT id, client_id, number, subtotal_cents, tax_cents, total_cents, notes FROM quotes WHERE id = ? AND business_id = ? AND status NOT IN ('declined','expired') LIMIT 1"
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
  if (existingInvoice) {
    return json({ error: "This quote has already been converted.", invoice: existingInvoice }, { status: 409 });
  }

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
  const number = await nextDocumentNumber(env, business.id, "invoice");
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
