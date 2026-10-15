import type { Env } from "./types";
import { requireAuth, requireBusiness } from "./auth";
import { cents, json, mutationOriginIsAllowed, readJson, textValue } from "./http";

const paymentId = (path: string) => {
  const match = path.match(/^\/api\/income\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
};
const validDate = (value: string | null): value is string =>
  Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value + "T00:00:00Z")) &&
    new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value);

function incomeValues(body: Record<string, unknown>, existing?: {
  amount_cents: number; description: string | null; notes: string | null; paid_at: string | null;
}): { amountCents: number; description: string; notes: string | null; paidAt: string } | string {
  const amountCents = "amountCents" in body ? cents(body.amountCents) : existing?.amount_cents ?? null;
  const description = "description" in body ? textValue(body.description, 240) : existing?.description;
  const notes = "notes" in body ? textValue(body.notes, 2000) : existing?.notes ?? null;
  const paidAt = "receivedAt" in body ? textValue(body.receivedAt, 10) :
    existing?.paid_at?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
  if (!description) return "Income description is required.";
  if (amountCents === null || amountCents <= 0) return "Income amount must be greater than zero.";
  if (!validDate(paidAt)) return "Choose a valid payment received date.";
  return { amountCents, description, notes, paidAt };
}

export async function listIncome(request: Request, env: Env): Promise<Response> {
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;
  const rows = await env.DB.prepare(
    "SELECT p.id, p.invoice_id, p.provider, p.amount_cents, p.currency, p.status, p.paid_at, p.description, p.notes, p.created_at, i.number AS invoice_number, c.name AS client_name FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id AND i.business_id = p.business_id LEFT JOIN clients c ON c.id = i.client_id WHERE p.business_id = ? AND p.status = 'completed' ORDER BY p.paid_at DESC, p.created_at DESC LIMIT 500"
  ).bind(business.id).all();
  return json({ income: rows.results ?? [] });
}

export async function createIncome(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) return json({ error: "Origin not allowed." }, { status: 403 });
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;
  const body = await readJson<Record<string, unknown>>(request);
  if (!body) return json({ error: "JSON body required." }, { status: 400 });
  // Invoice payments must be recorded through the invoice endpoint to update its balance.
  if ("invoiceId" in body) return json({ error: "Use Invoices → Payment to record invoice payments." }, { status: 400 });
  const parsed = incomeValues(body);
  if (typeof parsed === "string") return json({ error: parsed }, { status: 400 });
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO payments (id, business_id, invoice_id, provider, amount_cents, currency, status, paid_at, created_at, description, notes) VALUES (?, ?, NULL, 'manual', ?, 'AUD', 'completed', ?, ?, ?, ?)"
  ).bind(id, business.id, parsed.amountCents, parsed.paidAt + "T12:00:00Z", now, parsed.description, parsed.notes).run();
  return json({ income: { id, invoice_id: null, ...parsed } }, { status: 201 });
}

export async function updateIncome(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) return json({ error: "Origin not allowed." }, { status: 403 });
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;
  const id = paymentId(new URL(request.url).pathname);
  if (!id) return json({ error: "Invalid income reference." }, { status: 400 });
  const existing = await env.DB.prepare(
    "SELECT amount_cents, description, notes, paid_at FROM payments WHERE id = ? AND business_id = ? AND invoice_id IS NULL AND provider = 'manual' AND status = 'completed'"
  ).bind(id, business.id).first<{
    amount_cents: number; description: string | null; notes: string | null; paid_at: string | null;
  }>();
  if (!existing) return json({ error: "Only standalone manual income can be edited." }, { status: 404 });
  const body = await readJson<Record<string, unknown>>(request);
  if (!body) return json({ error: "JSON body required." }, { status: 400 });
  const parsed = incomeValues(body, existing);
  if (typeof parsed === "string") return json({ error: parsed }, { status: 400 });
  await env.DB.prepare(
    "UPDATE payments SET description = ?, amount_cents = ?, notes = ?, paid_at = ? WHERE id = ? AND business_id = ? AND invoice_id IS NULL AND provider = 'manual'"
  ).bind(parsed.description, parsed.amountCents, parsed.notes,
    parsed.paidAt + "T12:00:00Z", id, business.id).run();
  await env.DB.prepare(
    "INSERT INTO audit_log (id, business_id, user_id, action, entity_type, entity_id, created_at) VALUES (?, ?, ?, 'income.updated', 'payment', ?, ?)"
  ).bind(crypto.randomUUID(), business.id, context.user.id, id, new Date().toISOString()).run();
  return json({ updated: true });
}

export async function deleteIncome(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) return json({ error: "Origin not allowed." }, { status: 403 });
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;
  const id = paymentId(new URL(request.url).pathname);
  if (!id) return json({ error: "Invalid income reference." }, { status: 400 });
  const result = await env.DB.prepare(
    "DELETE FROM payments WHERE id = ? AND business_id = ? AND invoice_id IS NULL AND provider = 'manual' AND status = 'completed'"
  ).bind(id, business.id).run();
  if (result.meta.changes !== 1) return json({ error: "Only standalone manual income can be removed." }, { status: 404 });
  await env.DB.prepare(
    "INSERT INTO audit_log (id, business_id, user_id, action, entity_type, entity_id, created_at) VALUES (?, ?, ?, 'income.deleted', 'payment', ?, ?)"
  ).bind(crypto.randomUUID(), business.id, context.user.id, id, new Date().toISOString()).run();
  return json({ deleted: true });
}
