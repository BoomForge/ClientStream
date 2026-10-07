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
    "SELECT id, description, category, amount_cents, currency, incurred_at, notes, created_at FROM expenses WHERE business_id = ? ORDER BY incurred_at DESC, created_at DESC LIMIT 500"
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
