import type { Env } from "./types";
import { PLAN_CATALOG } from "./types";
import { getAuthContext, login, logout, register } from "./auth";
import { json } from "./http";
import { dashboard } from "./dashboard";
import { archiveClient, createClient, listClients, updateClient } from "./clients";
import { cancelJob, createJob, listJobs, updateJob } from "./jobs";
import { createExpense, deleteExpense, listExpenses } from "./expenses";
import { createInvoice, listInvoices, recordPayment, updateInvoice } from "./invoices";
import { squareWebhook } from "./square";

const VERSION = "0.3.0-usable-mvp";

async function api(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "OPTIONS") return new Response(null, { status: 204 });

  if (request.method === "GET" && path === "/api/health") {
    return json({
      status: "ok",
      service: "clientstream",
      version: VERSION,
      environment: env.APP_ENV ?? "unknown",
      database: "bound",
      squareWebhook: env.SQUARE_WEBHOOK_SIGNATURE_KEY ? "configured" : "unconfigured",
      timestamp: new Date().toISOString()
    });
  }

  if (request.method === "GET" && path === "/api/plans") return json({ plans: PLAN_CATALOG });

  if (request.method === "POST" && path === "/api/auth/register") return register(request, env);
  if (request.method === "POST" && path === "/api/auth/login") return login(request, env);
  if (request.method === "POST" && path === "/api/auth/logout") return logout(request, env);

  if (request.method === "GET" && path === "/api/me") {
    const context = await getAuthContext(request, env);
    if (!context) return json({ error: "Authentication required." }, { status: 401 });
    return json({
      user: context.user,
      business: context.business,
      plan: context.business ? PLAN_CATALOG[context.business.plan] : null
    });
  }

  if (request.method === "GET" && path === "/api/dashboard") return dashboard(request, env);

  if (path === "/api/clients") {
    if (request.method === "GET") return listClients(request, env);
    if (request.method === "POST") return createClient(request, env);
  }
  if (/^\/api\/clients\/[^/]+$/.test(path)) {
    if (request.method === "PATCH") return updateClient(request, env);
    if (request.method === "DELETE") return archiveClient(request, env);
  }

  if (path === "/api/jobs") {
    if (request.method === "GET") return listJobs(request, env);
    if (request.method === "POST") return createJob(request, env);
  }
  if (/^\/api\/jobs\/[^/]+$/.test(path)) {
    if (request.method === "PATCH") return updateJob(request, env);
    if (request.method === "DELETE") return cancelJob(request, env);
  }

  if (path === "/api/invoices") {
    if (request.method === "GET") return listInvoices(request, env);
    if (request.method === "POST") return createInvoice(request, env);
  }
  if (/^\/api\/invoices\/[^/]+$/.test(path) && request.method === "PATCH") {
    return updateInvoice(request, env);
  }
  if (/^\/api\/invoices\/[^/]+\/payments$/.test(path) && request.method === "POST") {
    return recordPayment(request, env);
  }

  if (path === "/api/expenses") {
    if (request.method === "GET") return listExpenses(request, env);
    if (request.method === "POST") return createExpense(request, env);
  }
  if (/^\/api\/expenses\/[^/]+$/.test(path) && request.method === "DELETE") {
    return deleteExpense(request, env);
  }

  if (request.method === "POST" && path === "/api/webhooks/square") return squareWebhook(request, env);

  return json({ error: "Not found." }, { status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    try {
      return await api(request, env);
    } catch (error) {
      console.error("ClientStream API error", error);
      return json({ error: "Something went wrong. Please try again." }, { status: 500 });
    }
  }
} satisfies ExportedHandler<Env>;
