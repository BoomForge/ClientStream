import type { Env } from "./types";
import { requireAuth, requireBusiness } from "./auth";
import { cents, json, mutationOriginIsAllowed, readJson, textValue } from "./http";

function expenseId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/expenses\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

export async function listExpenses(request: Request, env: Env): Promise<Response> {
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;

  const result = await env.DB.prepare(
    "SELECT id, description, category, amount_cents, currency, incurred_at, notes, created_at, updated_at FROM expenses WHERE business_id = ? ORDER BY incurred_at DESC, created_at DESC LIMIT 500"
  ).bind(business.id).all();

  return json({ expenses: result.results ?? [] });
}

export async function createExpense(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) return json({ error: "Origin not allowed." }, { status: 403 });
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;

  const body = await readJson<{
    description?: unknown;
    category?: unknown;
    amountCents?: unknown;
    incurredAt?: unknown;
    notes?: unknown;
  }>(request);

  const description = typeof body?.description === "string" ? body.description.trim().slice(0, 240) : "";
  const amountCents = cents(body?.amountCents);
  const incurredAt = typeof body?.incurredAt === "string" && body.incurredAt ? body.incurredAt.slice(0, 40) : new Date().toISOString().slice(0, 10);

  if (!description) return json({ error: "Expense description is required." }, { status: 400 });
  if (amountCents === null || amountCents <= 0) return json({ error: "Expense amount must be greater than zero." }, { status: 400 });

  const id = crypto.randomUUID();
  const category = textValue(body?.category, 100);
  const notes = textValue(body?.notes, 3000);
  const now = new Date().toISOString();

  await env.DB.prepare(
    "INSERT INTO expenses (id, business_id, description, category, amount_cents, currency, incurred_at, notes, created_at) VALUES (?, ?, ?, ?, ?, 'AUD', ?, ?, ?)"
  ).bind(id, business.id, description, category, amountCents, incurredAt, notes, now).run();

  return json({ expense: { id, description, category, amount_cents: amountCents, currency: "AUD", incurred_at: incurredAt, notes } }, { status: 201 });
}

export async function updateExpense(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) return json({ error: "Origin not allowed." }, { status: 403 });
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;
  const id = expenseId(new URL(request.url).pathname);
  if (!id) return json({ error: "Invalid expense id." }, { status: 400 });
  const body = await readJson<Record<string, unknown>>(request);
  if (!body) return json({ error: "JSON body required." }, { status: 400 });

  const existing = await env.DB.prepare(
    "SELECT description, category, amount_cents, incurred_at, notes FROM expenses WHERE id = ? AND business_id = ?"
  ).bind(id, business.id).first<{
    description: string; category: string | null; amount_cents: number;
    incurred_at: string; notes: string | null;
  }>();
  if (!existing) return json({ error: "Expense not found." }, { status: 404 });
  const description = "description" in body
    ? (typeof body.description === "string" ? body.description.trim().slice(0,240) : "")
    : existing.description;
  const amountCents = "amountCents" in body ? cents(body.amountCents) : existing.amount_cents;
  const incurredAt = "incurredAt" in body ? textValue(body.incurredAt, 10) : existing.incurred_at;
  if (!description) return json({ error: "Expense description is required." }, { status: 400 });
  if (amountCents === null || amountCents <= 0) return json({ error: "Expense amount must be greater than zero." }, { status: 400 });
  if (!incurredAt || !/^\d{4}-\d{2}-\d{2}$/.test(incurredAt) ||
      Number.isNaN(Date.parse(incurredAt + "T00:00:00Z")) ||
      new Date(incurredAt + "T00:00:00Z").toISOString().slice(0,10) !== incurredAt)
    return json({ error: "Choose a valid expense date." }, { status: 400 });
  const category = "category" in body ? textValue(body.category,100) : existing.category;
  const notes = "notes" in body ? textValue(body.notes,3000) : existing.notes;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE expenses SET description = ?, category = ?, amount_cents = ?, incurred_at = ?, notes = ?, updated_at = ? WHERE id = ? AND business_id = ?"
  ).bind(description,category,amountCents,incurredAt,notes,now,id,business.id).run();
  return json({ expense: { id, description, category, amount_cents: amountCents, incurred_at: incurredAt, notes, updated_at: now } });
}

export async function deleteExpense(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) return json({ error: "Origin not allowed." }, { status: 403 });
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;
  const id = expenseId(new URL(request.url).pathname);
  if (!id) return json({ error: "Invalid expense id." }, { status: 400 });

  const result = await env.DB.prepare(
    "DELETE FROM expenses WHERE id = ? AND business_id = ?"
  ).bind(id, business.id).run();

  return result.meta.changes ? json({ deleted: true }) : json({ error: "Expense not found." }, { status: 404 });
}
