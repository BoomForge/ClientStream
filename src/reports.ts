import type { Env } from "./types";
import { requireAuth, requireBusiness } from "./auth";
import { json } from "./http";

interface DateRange {
  from: string;
  to: string;
}

function validDate(value: string | null): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(value + "T00:00:00Z").getTime()));
}

function defaultFiscalRange(): DateRange {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const startYear = month >= 7 ? year : year - 1;
  return {
    from: startYear + "-07-01",
    to: (startYear + 1) + "-06-30"
  };
}

function rangeFromRequest(request: Request): DateRange | Response {
  const url = new URL(request.url);
  const defaults = defaultFiscalRange();
  const from = url.searchParams.get("from") ?? defaults.from;
  const to = url.searchParams.get("to") ?? defaults.to;

  if (!validDate(from) || !validDate(to) || from > to) {
    return json({ error: "Choose a valid report date range." }, { status: 400 });
  }

  const span = new Date(to + "T00:00:00Z").getTime() - new Date(from + "T00:00:00Z").getTime();
  if (span > 3 * 366 * 24 * 60 * 60 * 1000) {
    return json({ error: "Report range cannot exceed three years." }, { status: 400 });
  }

  return { from, to };
}

function endExclusive(to: string): string {
  const date = new Date(to + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export async function reportSummary(request: Request, env: Env): Promise<Response> {
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;

  const range = rangeFromRequest(request);
  if (range instanceof Response) return range;
  const next = endExclusive(range.to);

  const [income, expenses, invoices, outstanding, clients, incomeMonths, expenseMonths] = await Promise.all([
    env.DB.prepare(
      "SELECT COALESCE(SUM(amount_cents),0) AS total, COUNT(*) AS count, COALESCE(SUM(CASE WHEN invoice_id IS NOT NULL THEN amount_cents ELSE 0 END),0) AS invoiced, COALESCE(SUM(CASE WHEN invoice_id IS NULL THEN amount_cents ELSE 0 END),0) AS other FROM payments WHERE business_id = ? AND status = 'completed' AND paid_at >= ? AND paid_at < ?"
    ).bind(business.id, range.from, next).first<{ total: number; count: number; invoiced: number; other: number }>(),
    env.DB.prepare(
      "SELECT COALESCE(SUM(amount_cents),0) AS total, COUNT(*) AS count FROM expenses WHERE business_id = ? AND incurred_at >= ? AND incurred_at < ?"
    ).bind(business.id, range.from, next).first<{ total: number; count: number }>(),
    env.DB.prepare(
      "SELECT COALESCE(SUM(total_cents),0) AS issued, COUNT(*) AS count FROM invoices WHERE business_id = ? AND status NOT IN ('draft','void') AND issued_at >= ? AND issued_at < ?"
    ).bind(business.id, range.from, next).first<{ issued: number; count: number }>(),
    env.DB.prepare(
      "SELECT COALESCE(SUM(MAX(0, total_cents - amount_paid_cents)),0) AS outstanding FROM invoices WHERE business_id = ? AND status NOT IN ('draft','void')"
    ).bind(business.id).first<{ outstanding: number }>(),
    env.DB.prepare(
      "SELECT COUNT(*) AS count FROM clients WHERE business_id = ? AND status = 'active'"
    ).bind(business.id).first<{ count: number }>(),
    env.DB.prepare(
      "SELECT substr(paid_at,1,7) AS month, SUM(amount_cents) AS total FROM payments WHERE business_id = ? AND status = 'completed' AND paid_at >= ? AND paid_at < ? GROUP BY substr(paid_at,1,7) ORDER BY month"
    ).bind(business.id, range.from, next).all<{ month: string; total: number }>(),
    env.DB.prepare(
      "SELECT substr(incurred_at,1,7) AS month, SUM(amount_cents) AS total FROM expenses WHERE business_id = ? AND incurred_at >= ? AND incurred_at < ? GROUP BY substr(incurred_at,1,7) ORDER BY month"
    ).bind(business.id, range.from, next).all<{ month: string; total: number }>()
  ]);

  const incomeByMonth = new Map((incomeMonths.results ?? []).map((r) => [r.month, r.total]));
  const expensesByMonth = new Map((expenseMonths.results ?? []).map((r) => [r.month, r.total]));
  const month = new Date(range.from + "T12:00:00Z");
  const monthEnd = range.to.slice(0,7);
  const cashFlow: Array<{ month: string; incomeCents: number; expenseCents: number; netCents: number }> = [];
  while (month.toISOString().slice(0,7) <= monthEnd) {
    const key = month.toISOString().slice(0,7);
    const inc = incomeByMonth.get(key) ?? 0;
    const exp = expensesByMonth.get(key) ?? 0;
    cashFlow.push({ month: key, incomeCents: inc, expenseCents: exp, netCents: inc - exp });
    month.setUTCMonth(month.getUTCMonth() + 1);
  }

  return json({
    range,
    summary: {
      incomeCents: income?.total ?? 0,
      invoiceIncomeCents: income?.invoiced ?? 0,
      otherIncomeCents: income?.other ?? 0,
      expenseCents: expenses?.total ?? 0,
      netCents: (income?.total ?? 0) - (expenses?.total ?? 0),
      invoicesIssuedCents: invoices?.issued ?? 0,
      outstandingCents: outstanding?.outstanding ?? 0,
      paymentCount: income?.count ?? 0,
      expenseCount: expenses?.count ?? 0,
      invoiceCount: invoices?.count ?? 0,
      activeClients: clients?.count ?? 0
    },
    cashFlow
  });

}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return '"' + text.replace(/"/g, '""') + '"';
}

export async function exportReportCsv(request: Request, env: Env): Promise<Response> {
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;

  if (business.plan !== "pro") {
    return json({ error: "EOFY CSV export is a ClientStream Pro feature.", code: "PRO_REQUIRED" }, { status: 402 });
  }

  const range = rangeFromRequest(request);
  if (range instanceof Response) return range;
  const next = endExclusive(range.to);

  const [payments, expenses] = await Promise.all([
    env.DB.prepare(
      "SELECT p.paid_at AS occurred_at, 'income' AS type, i.number AS reference, c.name AS client_name, p.amount_cents, p.provider AS category, COALESCE(p.description,'') || CASE WHEN p.notes IS NOT NULL THEN ' — ' || p.notes ELSE '' END AS notes FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id LEFT JOIN clients c ON c.id = i.client_id WHERE p.business_id = ? AND p.status = 'completed' AND p.paid_at >= ? AND p.paid_at < ? ORDER BY p.paid_at ASC"
    ).bind(business.id, range.from, next).all(),
    env.DB.prepare(
      "SELECT e.incurred_at AS occurred_at, 'expense' AS type, '' AS reference, '' AS client_name, e.amount_cents, COALESCE(e.category,'') AS category, COALESCE(e.notes,'') AS notes FROM expenses e WHERE e.business_id = ? AND e.incurred_at >= ? AND e.incurred_at < ? ORDER BY e.incurred_at ASC"
    ).bind(business.id, range.from, next).all()
  ]);

  const rows = [...(payments.results ?? []), ...(expenses.results ?? [])] as Array<Record<string, unknown>>;
  rows.sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)));

  const header = ["Date","Type","Reference","Client","Amount AUD","Category","Notes"];
  const lines = [header.map(csvCell).join(",")];

  for (const row of rows) {
    lines.push([
      row.occurred_at,
      row.type,
      row.reference,
      row.client_name,
      ((Number(row.amount_cents) || 0) / 100).toFixed(2),
      row.category,
      row.notes
    ].map(csvCell).join(","));
  }

  const headers = new Headers({
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="clientstream-${range.from}-to-${range.to}.csv"`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });

  return new Response(lines.join("\r\n") + "\r\n", { headers });
}
