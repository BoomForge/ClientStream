import type { Env } from "./types";
import { requireAuth, requireBusiness } from "./auth";
import { json, mutationOriginIsAllowed, readJson, textValue } from "./http";

interface ReminderPayload {
  title?: string;
  note?: string;
}

function reminderId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/reminders\/([^/]+)(?:\/complete)?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function parsePayload(value: unknown): ReminderPayload {
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value) as ReminderPayload;
    return {
      title: typeof parsed.title === "string" ? parsed.title : undefined,
      note: typeof parsed.note === "string" ? parsed.note : undefined
    };
  } catch {
    return {};
  }
}

export async function today(request: Request, env: Env): Promise<Response> {
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;

  const now = new Date().toISOString();
  const nextSevenDays = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const [reminders, overdueInvoices, jobs] = await Promise.all([
    env.DB.prepare(
      "SELECT r.id, r.client_id, c.name AS client_name, r.invoice_id, r.kind, r.scheduled_for, r.payload_json, r.created_at FROM reminders r LEFT JOIN clients c ON c.id = r.client_id WHERE r.business_id = ? AND r.status = 'pending' ORDER BY r.scheduled_for ASC LIMIT 100"
    ).bind(business.id).all<{
      id: string;
      client_id: string | null;
      client_name: string | null;
      invoice_id: string | null;
      kind: string;
      scheduled_for: string;
      payload_json: string | null;
      created_at: string;
    }>(),
    env.DB.prepare(
      "SELECT i.id, i.number, i.total_cents, i.amount_paid_cents, i.due_at, c.name AS client_name FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.business_id = ? AND i.status NOT IN ('paid','void') AND i.due_at IS NOT NULL AND i.due_at < ? ORDER BY i.due_at ASC LIMIT 50"
    ).bind(business.id, now.slice(0, 10)).all(),
    env.DB.prepare(
      "SELECT j.id, j.title, j.status, j.scheduled_for, c.name AS client_name FROM jobs j LEFT JOIN clients c ON c.id = j.client_id WHERE j.business_id = ? AND j.status IN ('planned','active') AND j.scheduled_for IS NOT NULL AND j.scheduled_for <= ? ORDER BY j.scheduled_for ASC LIMIT 50"
    ).bind(business.id, nextSevenDays).all()
  ]);

  return json({
    now,
    reminders: (reminders.results ?? []).map((row) => ({
      ...row,
      payload: parsePayload(row.payload_json),
      due: row.scheduled_for <= now
    })),
    overdueInvoices: overdueInvoices.results ?? [],
    upcomingJobs: jobs.results ?? []
  });
}

export async function createReminder(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) return json({ error: "Origin not allowed." }, { status: 403 });
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;

  const body = await readJson<{
    title?: unknown;
    note?: unknown;
    scheduledFor?: unknown;
    clientId?: unknown;
    invoiceId?: unknown;
    kind?: unknown;
  }>(request);

  const title = typeof body?.title === "string" ? body.title.trim().slice(0, 180) : "";
  const scheduledFor = typeof body?.scheduledFor === "string" ? body.scheduledFor.trim().slice(0, 40) : "";
  if (!title) return json({ error: "Reminder title is required." }, { status: 400 });
  if (!scheduledFor || Number.isNaN(new Date(scheduledFor).getTime())) {
    return json({ error: "Choose a valid reminder date and time." }, { status: 400 });
  }

  const clientId = typeof body?.clientId === "string" && body.clientId ? body.clientId : null;
  const invoiceId = typeof body?.invoiceId === "string" && body.invoiceId ? body.invoiceId : null;
  const allowedKinds = new Set(["follow_up", "payment", "job", "review", "general"]);
  const kind = typeof body?.kind === "string" && allowedKinds.has(body.kind) ? body.kind : "general";

  if (clientId) {
    const client = await env.DB.prepare(
      "SELECT id FROM clients WHERE id = ? AND business_id = ? AND status = 'active' LIMIT 1"
    ).bind(clientId, business.id).first<{ id: string }>();
    if (!client) return json({ error: "Selected client is invalid." }, { status: 400 });
  }

  if (invoiceId) {
    const invoice = await env.DB.prepare(
      "SELECT id FROM invoices WHERE id = ? AND business_id = ? AND status != 'void' LIMIT 1"
    ).bind(invoiceId, business.id).first<{ id: string }>();
    if (!invoice) return json({ error: "Selected invoice is invalid." }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const note = textValue(body?.note, 3000);
  const payload = JSON.stringify({ title, note });
  const now = new Date().toISOString();

  await env.DB.prepare(
    "INSERT INTO reminders (id, business_id, client_id, invoice_id, kind, status, scheduled_for, payload_json, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)"
  ).bind(id, business.id, clientId, invoiceId, kind, scheduledFor, payload, now).run();

  return json({
    reminder: { id, client_id: clientId, invoice_id: invoiceId, kind, scheduled_for: scheduledFor, payload: { title, note } }
  }, { status: 201 });
}

export async function completeReminder(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) return json({ error: "Origin not allowed." }, { status: 403 });
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;

  const id = reminderId(new URL(request.url).pathname);
  if (!id) return json({ error: "Invalid reminder id." }, { status: 400 });

  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    "UPDATE reminders SET status = 'sent', sent_at = ? WHERE id = ? AND business_id = ? AND status = 'pending'"
  ).bind(now, id, business.id).run();

  return result.meta.changes
    ? json({ completed: true })
    : json({ error: "Reminder not found." }, { status: 404 });
}

export async function cancelReminder(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) return json({ error: "Origin not allowed." }, { status: 403 });
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;

  const id = reminderId(new URL(request.url).pathname);
  if (!id) return json({ error: "Invalid reminder id." }, { status: 400 });

  const result = await env.DB.prepare(
    "UPDATE reminders SET status = 'cancelled' WHERE id = ? AND business_id = ? AND status = 'pending'"
  ).bind(id, business.id).run();

  return result.meta.changes
    ? json({ cancelled: true })
    : json({ error: "Reminder not found." }, { status: 404 });
}
