import type { Env } from "./types";
import { requireAuth, requireBusiness } from "./auth";
import { json } from "./http";

export async function dashboard(request: Request, env: Env): Promise<Response> {
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;

  const [clients, jobs, invoices, expenses] = await Promise.all([
    env.DB.prepare(
      "SELECT COUNT(*) AS count FROM clients WHERE business_id = ? AND status = 'active'"
    ).bind(business.id).first<{ count: number }>(),
    env.DB.prepare(
      "SELECT COUNT(*) AS count FROM jobs WHERE business_id = ? AND status IN ('planned', 'active')"
    ).bind(business.id).first<{ count: number }>(),
    env.DB.prepare(
      "SELECT COUNT(*) AS count, COALESCE(SUM(total_cents - amount_paid_cents), 0) AS outstanding, COALESCE(SUM(CASE WHEN status = 'paid' THEN total_cents ELSE 0 END), 0) AS paid FROM invoices WHERE business_id = ? AND status != 'void'"
    ).bind(business.id).first<{ count: number; outstanding: number; paid: number }>(),
    env.DB.prepare(
      "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM expenses WHERE business_id = ?"
    ).bind(business.id).first<{ total: number }>()
  ]);

  const recent = await env.DB.prepare(
    "SELECT i.id, i.number, i.status, i.total_cents, i.amount_paid_cents, i.due_at, c.name AS client_name FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.business_id = ? AND i.status != 'void' ORDER BY i.created_at DESC LIMIT 5"
  ).bind(business.id).all();

  return json({
    metrics: {
      clients: clients?.count ?? 0,
      openJobs: jobs?.count ?? 0,
      invoices: invoices?.count ?? 0,
      outstandingCents: invoices?.outstanding ?? 0,
      paidCents: invoices?.paid ?? 0,
      expenseCents: expenses?.total ?? 0
    },
    recentInvoices: recent.results ?? []
  });
}
