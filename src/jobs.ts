import type { Env } from "./types";
import { requireAuth, requireBusiness } from "./auth";
import { json, mutationOriginIsAllowed, readJson, textValue } from "./http";

function jobId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/jobs\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function validClient(env: Env, businessId: string, id: string | null): Promise<boolean> {
  if (!id) return true;
  const row = await env.DB.prepare(
    "SELECT id FROM clients WHERE id = ? AND business_id = ? AND status = 'active' LIMIT 1"
  ).bind(id, businessId).first<{ id: string }>();
  return Boolean(row);
}

export async function listJobs(request: Request, env: Env): Promise<Response> {
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;

  const result = await env.DB.prepare(
    "SELECT j.id, j.client_id, c.name AS client_name, j.title, j.description, j.status, j.scheduled_for, j.completed_at, j.created_at, j.updated_at FROM jobs j LEFT JOIN clients c ON c.id = j.client_id WHERE j.business_id = ? AND j.status != 'cancelled' ORDER BY CASE WHEN j.scheduled_for IS NULL THEN 1 ELSE 0 END, j.scheduled_for ASC, j.created_at DESC LIMIT 500"
  ).bind(business.id).all();

  return json({ jobs: result.results ?? [] });
}

export async function createJob(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) return json({ error: "Origin not allowed." }, { status: 403 });
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;

  const body = await readJson<{
    title?: unknown;
    description?: unknown;
    clientId?: unknown;
    scheduledFor?: unknown;
  }>(request);

  const title = typeof body?.title === "string" ? body.title.trim().slice(0, 180) : "";
  if (!title) return json({ error: "Job title is required." }, { status: 400 });

  const clientId = typeof body?.clientId === "string" && body.clientId ? body.clientId : null;
  if (!(await validClient(env, business.id, clientId))) {
    return json({ error: "Selected client is invalid." }, { status: 400 });
  }

  const description = textValue(body?.description, 5000);
  const scheduledFor = textValue(body?.scheduledFor, 40);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await env.DB.prepare(
    "INSERT INTO jobs (id, business_id, client_id, title, description, status, scheduled_for, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'planned', ?, ?, ?)"
  ).bind(id, business.id, clientId, title, description, scheduledFor, now, now).run();

  return json({ job: { id, client_id: clientId, title, description, status: "planned", scheduled_for: scheduledFor } }, { status: 201 });
}

export async function updateJob(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) return json({ error: "Origin not allowed." }, { status: 403 });
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;

  const id = jobId(new URL(request.url).pathname);
  if (!id) return json({ error: "Invalid job id." }, { status: 400 });
  const body = await readJson<Record<string, unknown>>(request);
  if (!body) return json({ error: "JSON body required." }, { status: 400 });

  const existing = await env.DB.prepare(
    "SELECT client_id, title, description, status, scheduled_for FROM jobs WHERE id = ? AND business_id = ? LIMIT 1"
  ).bind(id, business.id).first<{
    client_id: string | null;
    title: string;
    description: string | null;
    status: string;
    scheduled_for: string | null;
  }>();
  if (!existing) return json({ error: "Job not found." }, { status: 404 });

  const title = typeof body.title === "string" ? body.title.trim().slice(0, 180) : existing.title;
  if (!title) return json({ error: "Job title is required." }, { status: 400 });

  const allowed = new Set(["planned", "active", "completed", "cancelled"]);
  const status = typeof body.status === "string" && allowed.has(body.status) ? body.status : existing.status;
  const clientId = "clientId" in body
    ? (typeof body.clientId === "string" && body.clientId ? body.clientId : null)
    : existing.client_id;
  if (!(await validClient(env, business.id, clientId))) return json({ error: "Selected client is invalid." }, { status: 400 });

  const description = "description" in body ? textValue(body.description, 5000) : existing.description;
  const scheduledFor = "scheduledFor" in body ? textValue(body.scheduledFor, 40) : existing.scheduled_for;
  const completedAt = status === "completed" ? new Date().toISOString() : null;
  const now = new Date().toISOString();

  await env.DB.prepare(
    "UPDATE jobs SET client_id = ?, title = ?, description = ?, status = ?, scheduled_for = ?, completed_at = ?, updated_at = ? WHERE id = ? AND business_id = ?"
  ).bind(clientId, title, description, status, scheduledFor, completedAt, now, id, business.id).run();

  return json({ job: { id, client_id: clientId, title, description, status, scheduled_for: scheduledFor, completed_at: completedAt } });
}

export async function cancelJob(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) return json({ error: "Origin not allowed." }, { status: 403 });
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;
  const id = jobId(new URL(request.url).pathname);
  if (!id) return json({ error: "Invalid job id." }, { status: 400 });

  const result = await env.DB.prepare(
    "UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE id = ? AND business_id = ? AND status != 'cancelled'"
  ).bind(new Date().toISOString(), id, business.id).run();

  return result.meta.changes ? json({ cancelled: true }) : json({ error: "Job not found." }, { status: 404 });
}
