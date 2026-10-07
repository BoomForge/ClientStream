import type { Env } from "./types";
import { PLAN_CATALOG } from "./types";
import { requireAuth, requireBusiness } from "./auth";
import { cents, json, mutationOriginIsAllowed, readJson, textValue } from "./http";

function invoiceId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/invoices\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function paymentInvoiceId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/invoices\/([^/]+)\/payments$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function invoiceNumber(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return "INV-" + date + "-" + crypto.randomUUID().slice(0, 6).toUpperCase();
}

export async function listInvoices(request: Request, env: Env): Promise<Response> {
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;

  const result = await env.DB.prepare(
    "SELECT i.id, i.client_id, c.name AS client_name, i.number, i.status, i.currency, i.subtotal_cents, i.tax_cents, i.total_cents, i.amount_paid_cents, i.issued_at, i.due_at, i.paid_at, i.notes, i.created_at FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.business_id = ? ORDER BY i.created_at DESC LIMIT 500"
  ).bind(business.id).all();

  return json({ invoices: result.results ?? [] });
}

export async function createInvoice(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) return json({ error: "Origin not allowed." }, { status: 403 });
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;

  const body = await readJson<{
    clientId?: unknown;
    dueAt?: unknown;
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

  if (!Array.isArray(body?.items) || body.items.length < 1 || body.items.length > 50) {
    return json({ error: "Add at least one invoice item." }, { status: 400 });
  }

  const items: Array<{ id: string; description: string; quantity: number; unitPriceCents: number; lineTotalCents: number }> = [];
  for (const raw of body.items) {
    if (!raw || typeof raw !== "object") return json({ error: "Invoice item is invalid." }, { status: 400 });
    const item = raw as Record<string, unknown>;
    const description = typeof item.description === "string" ? item.description.trim().slice(0, 500) : "";
    const quantity = typeof item.quantity === "number" && Number.isFinite(item.quantity) ? item.quantity : 0;
    const unitPriceCents = cents(item.unitPriceCents);
    if (!description || quantity <= 0 || quantity > 100000 || unitPriceCents === null) {
      return json({ error: "Each invoice item needs a description, quantity and valid price." }, { status: 400 });
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
  if (totalCents <= 0) return json({ error: "Invoice total must be greater than zero." }, { status: 400 });

  const id = crypto.randomUUID();
  const number = invoiceNumber();
  const dueAt = textValue(body?.dueAt, 40);
  const notes = textValue(body?.notes, 5000);
  const now = new Date().toISOString();

  const statements = [
    env.DB.prepare(
      "INSERT INTO invoices (id, business_id, client_id, number, status, currency, subtotal_cents, tax_cents, total_cents, amount_paid_cents, due_at, notes, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', 'AUD', ?, ?, ?, 0, ?, ?, ?, ?)"
    ).bind(id, business.id, clientId, number, subtotalCents, taxCents, totalCents, dueAt, notes, now, now)
  ];

  items.forEach((item, index) => {
    statements.push(
      env.DB.prepare(
        "INSERT INTO invoice_items (id, invoice_id, description, quantity, unit_price_cents, sort_order) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(item.id, id, item.description, item.quantity, item.unitPriceCents, index)
    );
  });

  await env.DB.batch(statements);

  return json({
    invoice: {
      id,
      client_id: clientId,
      number,
      status: "draft",
      currency: "AUD",
      subtotal_cents: subtotalCents,
      tax_cents: taxCents,
      total_cents: totalCents,
      amount_paid_cents: 0,
      due_at: dueAt,
      notes,
      items
    }
  }, { status: 201 });
}

export async function updateInvoice(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) return json({ error: "Origin not allowed." }, { status: 403 });
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;

  const id = invoiceId(new URL(request.url).pathname);
  if (!id) return json({ error: "Invalid invoice id." }, { status: 400 });
  const body = await readJson<{ status?: unknown; dueAt?: unknown; notes?: unknown }>(request);
  if (!body) return json({ error: "JSON body required." }, { status: 400 });

  const existing = await env.DB.prepare(
    "SELECT status, due_at, notes, amount_paid_cents, total_cents, issued_at FROM invoices WHERE id = ? AND business_id = ? LIMIT 1"
  ).bind(id, business.id).first<{
    status: string;
    due_at: string | null;
    notes: string | null;
    amount_paid_cents: number;
    total_cents: number;
    issued_at: string | null;
  }>();
  if (!existing) return json({ error: "Invoice not found." }, { status: 404 });

  const allowed = new Set(["draft", "sent", "void"]);
  let status = existing.status;
  if (typeof body.status === "string" && allowed.has(body.status) && existing.status !== "paid") {
    status = body.status;
  }
  if (existing.amount_paid_cents > 0 && status === "void") {
    return json({ error: "An invoice with payments cannot be voided." }, { status: 409 });
  }

  const dueAt = "dueAt" in body ? textValue(body.dueAt, 40) : existing.due_at;
  const notes = "notes" in body ? textValue(body.notes, 5000) : existing.notes;
  const issuedAt = status === "sent" && !existing.issued_at ? new Date().toISOString() : existing.issued_at;
  const now = new Date().toISOString();

  await env.DB.prepare(
    "UPDATE invoices SET status = ?, due_at = ?, notes = ?, issued_at = ?, updated_at = ? WHERE id = ? AND business_id = ?"
  ).bind(status, dueAt, notes, issuedAt, now, id, business.id).run();

  return json({ invoice: { id, status, due_at: dueAt, notes, issued_at: issuedAt } });
}

export async function recordPayment(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) return json({ error: "Origin not allowed." }, { status: 403 });
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;

  const id = paymentInvoiceId(new URL(request.url).pathname);
  if (!id) return json({ error: "Invalid invoice id." }, { status: 400 });
  const body = await readJson<{ amountCents?: unknown }>(request);
  const amountCents = cents(body?.amountCents);
  if (amountCents === null || amountCents <= 0) {
    return json({ error: "Payment amount must be greater than zero." }, { status: 400 });
  }

  const invoice = await env.DB.prepare(
    "SELECT total_cents, amount_paid_cents, status FROM invoices WHERE id = ? AND business_id = ? LIMIT 1"
  ).bind(id, business.id).first<{ total_cents: number; amount_paid_cents: number; status: string }>();
  if (!invoice || invoice.status === "void") return json({ error: "Invoice not found." }, { status: 404 });

  const outstanding = invoice.total_cents - invoice.amount_paid_cents;
  if (amountCents > outstanding) {
    return json({ error: "Payment cannot exceed the outstanding balance." }, { status: 400 });
  }

  const newPaid = invoice.amount_paid_cents + amountCents;
  const paid = newPaid >= invoice.total_cents;
  const status = paid ? "paid" : "part_paid";
  const now = new Date().toISOString();
  const paymentId = crypto.randomUUID();

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO payments (id, business_id, invoice_id, provider, amount_cents, currency, status, paid_at, created_at) VALUES (?, ?, ?, 'manual', ?, 'AUD', 'completed', ?, ?)"
    ).bind(paymentId, business.id, id, amountCents, now, now),
    env.DB.prepare(
      "UPDATE invoices SET amount_paid_cents = ?, status = ?, paid_at = ?, updated_at = ? WHERE id = ? AND business_id = ?"
    ).bind(newPaid, status, paid ? now : null, now, id, business.id)
  ]);

  return json({
    payment: { id: paymentId, invoice_id: id, amount_cents: amountCents, paid_at: now },
    invoice: { id, amount_paid_cents: newPaid, status, paid_at: paid ? now : null }
  }, { status: 201 });
}
