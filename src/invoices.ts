import type { Env } from "./types";
import { PLAN_CATALOG } from "./types";
import { requireAuth, requireBusiness } from "./auth";
import { json, mutationOriginIsAllowed, readJson, textValue } from "./http";
import { documentTotals, nextDocumentNumber, parseDocumentItems, taxModeFrom, type TaxMode } from "./documents";

function invoiceId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/invoices\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function paymentInvoiceId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/invoices\/([^/]+)\/payments$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function isPastDate(value: string | null): boolean {
  return Boolean(value && value.slice(0, 10) < new Date().toISOString().slice(0, 10));
}

async function refreshOverdue(env: Env, businessId: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  await env.DB.prepare(
    "UPDATE invoices SET status = 'overdue', updated_at = ? WHERE business_id = ? AND status IN ('sent','part_paid') AND due_at IS NOT NULL AND substr(due_at,1,10) < ? AND amount_paid_cents < total_cents"
  ).bind(new Date().toISOString(), businessId, today).run();
}

async function businessGstRegistered(env: Env, businessId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT gst_registered FROM businesses WHERE id = ? LIMIT 1"
  ).bind(businessId).first<{ gst_registered: number }>();
  return Boolean(row?.gst_registered);
}

export async function listInvoices(request: Request, env: Env): Promise<Response> {
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;

  await refreshOverdue(env, business.id);

  const result = await env.DB.prepare(
    "SELECT i.id, i.client_id, c.name AS client_name, i.number, i.status, i.currency, i.subtotal_cents, i.tax_cents, i.total_cents, i.amount_paid_cents, i.issued_at, i.due_at, i.paid_at, i.notes, i.created_at FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.business_id = ? ORDER BY i.created_at DESC LIMIT 500"
  ).bind(business.id).all();

  return json({ invoices: result.results ?? [] });
}

export async function getInvoice(request: Request, env: Env): Promise<Response> {
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;

  await refreshOverdue(env, business.id);

  const id = invoiceId(new URL(request.url).pathname);
  if (!id) return json({ error: "Invalid invoice id." }, { status: 400 });

  const invoice = await env.DB.prepare(
    "SELECT i.*, c.name AS client_name, c.company AS client_company, c.email AS client_email, c.phone AS client_phone, c.address AS client_address, b.name AS business_name, b.abn AS business_abn, b.business_email, b.business_phone, b.business_address FROM invoices i JOIN clients c ON c.id = i.client_id JOIN businesses b ON b.id = i.business_id WHERE i.id = ? AND i.business_id = ? LIMIT 1"
  ).bind(id, business.id).first();

  if (!invoice) return json({ error: "Invoice not found." }, { status: 404 });

  const [items, payments] = await Promise.all([
    env.DB.prepare(
      "SELECT id, description, quantity, unit_price_cents, sort_order FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order ASC"
    ).bind(id).all(),
    env.DB.prepare(
      "SELECT id, provider, amount_cents, status, paid_at FROM payments WHERE invoice_id = ? AND business_id = ? ORDER BY paid_at ASC"
    ).bind(id, business.id).all()
  ]);

  return json({ invoice, items: items.results ?? [], payments: payments.results ?? [] });
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
    taxMode?: unknown;
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

  const parsed = parseDocumentItems(body?.items);
  if (!parsed.items) return json({ error: parsed.error }, { status: 400 });

  const gstRegistered = await businessGstRegistered(env, business.id);
  if (body?.taxMode === "gst10" && !gstRegistered) {
    return json({ error: "Enable GST registration in Settings before adding GST.", code: "GST_REGISTRATION_REQUIRED" }, { status: 400 });
  }
  const taxMode = taxModeFrom(body?.taxMode, gstRegistered);
  const totals = documentTotals(parsed.items, taxMode);
  if (totals.totalCents <= 0) return json({ error: "Invoice total must be greater than zero." }, { status: 400 });

  const id = crypto.randomUUID();
  const number = await nextDocumentNumber(env, business.id, "invoice");
  const dueAt = textValue(body?.dueAt, 40);
  const notes = textValue(body?.notes, 5000);
  const now = new Date().toISOString();

  const statements = [
    env.DB.prepare(
      "INSERT INTO invoices (id, business_id, client_id, number, status, currency, subtotal_cents, tax_cents, total_cents, amount_paid_cents, due_at, notes, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', 'AUD', ?, ?, ?, 0, ?, ?, ?, ?)"
    ).bind(id, business.id, clientId, number, totals.subtotalCents, totals.taxCents, totals.totalCents, dueAt, notes, now, now)
  ];

  parsed.items.forEach((item, index) => {
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
      subtotal_cents: totals.subtotalCents,
      tax_cents: totals.taxCents,
      total_cents: totals.totalCents,
      amount_paid_cents: 0,
      due_at: dueAt,
      notes,
      taxMode,
      items: parsed.items
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

  const body = await readJson<{
    status?: unknown;
    dueAt?: unknown;
    notes?: unknown;
    clientId?: unknown;
    taxMode?: unknown;
    items?: unknown;
  }>(request);
  if (!body) return json({ error: "JSON body required." }, { status: 400 });

  const existing = await env.DB.prepare(
    "SELECT client_id, status, due_at, notes, amount_paid_cents, subtotal_cents, tax_cents, total_cents, issued_at FROM invoices WHERE id = ? AND business_id = ? LIMIT 1"
  ).bind(id, business.id).first<{
    client_id: string;
    status: string;
    due_at: string | null;
    notes: string | null;
    amount_paid_cents: number;
    subtotal_cents: number;
    tax_cents: number;
    total_cents: number;
    issued_at: string | null;
  }>();
  if (!existing) return json({ error: "Invoice not found." }, { status: 404 });

  let clientId = existing.client_id;
  let subtotalCents = existing.subtotal_cents;
  let taxCents = existing.tax_cents;
  let totalCents = existing.total_cents;
  let replacementItems: ReturnType<typeof parseDocumentItems>["items"] | undefined;

  const changingDraftContent = "clientId" in body || "items" in body || "taxMode" in body;
  if (changingDraftContent && existing.status !== "draft") {
    return json({ error: "Only draft invoices can have their client, line items or GST changed." }, { status: 409 });
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
          "SELECT description, quantity, unit_price_cents AS unitPriceCents FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order ASC"
        ).bind(id).all()).results;

    const parsed = parseDocumentItems(currentItems);
    if (!parsed.items) return json({ error: parsed.error }, { status: 400 });
    replacementItems = parsed.items;

    let taxMode: TaxMode = existing.tax_cents > 0 ? "gst10" : "none";
    if ("taxMode" in body) {
      const gstRegistered = await businessGstRegistered(env, business.id);
      if (body.taxMode === "gst10" && !gstRegistered) {
        return json({ error: "Enable GST registration in Settings before adding GST.", code: "GST_REGISTRATION_REQUIRED" }, { status: 400 });
      }
      taxMode = taxModeFrom(body.taxMode, gstRegistered);
    }

    const totals = documentTotals(parsed.items, taxMode);
    if (totals.totalCents <= 0) return json({ error: "Invoice total must be greater than zero." }, { status: 400 });
    subtotalCents = totals.subtotalCents;
    taxCents = totals.taxCents;
    totalCents = totals.totalCents;
  }

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
  const now = new Date().toISOString();
  const issuedAt = status === "sent" && !existing.issued_at ? now : existing.issued_at;

  if (status === "sent" && isPastDate(dueAt)) status = "overdue";

  const statements = [
    env.DB.prepare(
      "UPDATE invoices SET client_id = ?, status = ?, subtotal_cents = ?, tax_cents = ?, total_cents = ?, due_at = ?, notes = ?, issued_at = ?, updated_at = ? WHERE id = ? AND business_id = ?"
    ).bind(clientId, status, subtotalCents, taxCents, totalCents, dueAt, notes, issuedAt, now, id, business.id)
  ];

  if (replacementItems) {
    statements.push(env.DB.prepare("DELETE FROM invoice_items WHERE invoice_id = ?").bind(id));
    replacementItems.forEach((item, index) => {
      statements.push(
        env.DB.prepare(
          "INSERT INTO invoice_items (id, invoice_id, description, quantity, unit_price_cents, sort_order) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(item.id, id, item.description, item.quantity, item.unitPriceCents, index)
      );
    });
  }

  await env.DB.batch(statements);

  return json({
    invoice: {
      id,
      client_id: clientId,
      status,
      subtotal_cents: subtotalCents,
      tax_cents: taxCents,
      total_cents: totalCents,
      due_at: dueAt,
      notes,
      issued_at: issuedAt
    }
  });
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
  const amountCents = typeof body?.amountCents === "number" && Number.isFinite(body.amountCents)
    ? Math.round(body.amountCents)
    : null;

  if (amountCents === null || amountCents <= 0) {
    return json({ error: "Payment amount must be greater than zero." }, { status: 400 });
  }

  const invoice = await env.DB.prepare(
    "SELECT total_cents, amount_paid_cents, status, due_at FROM invoices WHERE id = ? AND business_id = ? LIMIT 1"
  ).bind(id, business.id).first<{
    total_cents: number;
    amount_paid_cents: number;
    status: string;
    due_at: string | null;
  }>();

  if (!invoice || invoice.status === "void") return json({ error: "Invoice not found." }, { status: 404 });

  const outstanding = invoice.total_cents - invoice.amount_paid_cents;
  if (amountCents > outstanding) {
    return json({ error: "Payment cannot exceed the outstanding balance." }, { status: 400 });
  }

  const newPaid = invoice.amount_paid_cents + amountCents;
  const paid = newPaid >= invoice.total_cents;
  const status = paid ? "paid" : (isPastDate(invoice.due_at) ? "overdue" : "part_paid");
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
