import type { Env } from "./types";
import { requireAuth, requireBusiness } from "./auth";
import { json } from "./http";
import { calendarDateInZone } from "./local-date";

interface DashboardMetrics {
  clients: number;
  openJobs: number;
  invoices: number;
  outstandingCents: number;
  paidCents: number;
  incomeCents: number;
  expenseCents: number;
}

interface SnapshotRow {
  snapshot_date: string;
  active_clients: number;
  open_jobs: number;
  outstanding_cents: number;
  expense_cents: number;
  income_cents: number | null;
}

async function currentMetrics(env: Env, businessId: string): Promise<DashboardMetrics> {
  const [clients, jobs, invoices, expenses, income] = await Promise.all([
    env.DB.prepare(
      "SELECT COUNT(*) AS count FROM clients WHERE business_id = ? AND status = 'active'"
    ).bind(businessId).first<{ count: number }>(),
    env.DB.prepare(
      "SELECT COUNT(*) AS count FROM jobs WHERE business_id = ? AND status IN ('planned', 'active')"
    ).bind(businessId).first<{ count: number }>(),
    env.DB.prepare(
      "SELECT COUNT(*) AS count, COALESCE(SUM(MAX(0, total_cents - amount_paid_cents)), 0) AS outstanding, COALESCE(SUM(CASE WHEN status = 'paid' THEN total_cents ELSE 0 END), 0) AS paid FROM invoices WHERE business_id = ? AND status NOT IN ('draft','void')"
    ).bind(businessId).first<{ count: number; outstanding: number; paid: number }>(),
    env.DB.prepare(
      "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM expenses WHERE business_id = ?"
    ).bind(businessId).first<{ total: number }>(),
    env.DB.prepare(
      "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM payments WHERE business_id = ? AND status = 'completed'"
    ).bind(businessId).first<{ total: number }>()
  ]);

  return {
    clients: clients?.count ?? 0,
    openJobs: jobs?.count ?? 0,
    invoices: invoices?.count ?? 0,
    outstandingCents: invoices?.outstanding ?? 0,
    paidCents: invoices?.paid ?? 0,
    incomeCents: income?.total ?? 0,
    expenseCents: expenses?.total ?? 0
  };
}

// Snapshots are observed values, not historical estimates. Past days without a
// recorded observation remain null in the API so the UI never invents a trend.
export async function captureDailyDashboardMetrics(env: Env, now = new Date()): Promise<void> {
  const businesses = await env.DB.prepare(
    "SELECT id, timezone FROM businesses"
  ).all<{ id: string; timezone: string | null }>();

  for (const business of businesses.results ?? []) {
    const metrics = await currentMetrics(env, business.id);
    const day = calendarDateInZone(now, business.timezone || "Australia/Hobart");
    await env.DB.prepare(
      `INSERT INTO dashboard_metric_snapshots
      (business_id, snapshot_date, active_clients, open_jobs, outstanding_cents, expense_cents, income_cents, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(business_id, snapshot_date) DO UPDATE SET
      active_clients = excluded.active_clients,
      open_jobs = excluded.open_jobs,
      outstanding_cents = excluded.outstanding_cents,
      expense_cents = excluded.expense_cents,
      income_cents = excluded.income_cents,
      observed_at = excluded.observed_at`
    ).bind(
      business.id, day, metrics.clients, metrics.openJobs,
      metrics.outstandingCents, metrics.expenseCents, metrics.incomeCents, now.toISOString()
    ).run();
  }

  // Keep enough history for trend comparisons without unbounded D1 growth.
  const cutoff = new Date(now.getTime() - 120 * 86400_000).toISOString().slice(0, 10);
  await env.DB.prepare("DELETE FROM dashboard_metric_snapshots WHERE snapshot_date < ?")
    .bind(cutoff).run();
}

function pastSevenLocalDays(today: string): string[] {
  // Work with calendar dates at UTC noon, independently of Hobart DST changes.
  const start = new Date(today + "T12:00:00Z");
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() - (6 - index));
    return date.toISOString().slice(0, 10);
  });
}

export async function dashboard(request: Request, env: Env): Promise<Response> {
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;

  const [metrics, recent, snapshots, timezone] = await Promise.all([
    currentMetrics(env, business.id),
    env.DB.prepare(
      "SELECT i.id, i.number, i.status, i.total_cents, i.amount_paid_cents, i.due_at, c.name AS client_name FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.business_id = ? AND i.status != 'void' ORDER BY i.created_at DESC LIMIT 5"
    ).bind(business.id).all(),
    env.DB.prepare(
      "SELECT snapshot_date, active_clients, open_jobs, outstanding_cents, expense_cents, income_cents FROM dashboard_metric_snapshots WHERE business_id = ? ORDER BY snapshot_date DESC LIMIT 8"
    ).bind(business.id).all<SnapshotRow>(),
    env.DB.prepare(
      "SELECT timezone FROM businesses WHERE id = ?"
    ).bind(business.id).first<{ timezone: string | null }>()
  ]);

  const today = calendarDateInZone(new Date(), timezone?.timezone || "Australia/Hobart");
  const byDate = new Map((snapshots.results ?? []).map((row) => [row.snapshot_date, row]));
  const trend = pastSevenLocalDays(today).map((date) => {
    // The final bar always reflects the same live totals as the KPI header.
    // Earlier bars only use real recorded observations.
    const row = date === today ? null : byDate.get(date);
    return {
      date,
      clients: date === today ? metrics.clients : row?.active_clients ?? null,
      openJobs: date === today ? metrics.openJobs : row?.open_jobs ?? null,
      outstandingCents: date === today ? metrics.outstandingCents : row?.outstanding_cents ?? null,
      expenseCents: date === today ? metrics.expenseCents : row?.expense_cents ?? null,
      incomeCents: date === today ? metrics.incomeCents : row?.income_cents ?? null
    };
  });

  return json({
    metrics,
    trend,
    recentInvoices: recent.results ?? []
  });
}
