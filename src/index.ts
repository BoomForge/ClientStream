import type { Env } from "./types";
import { PLAN_CATALOG } from "./types";
import { getAuthContext, login, logout, register, requestPasswordReset, resetPassword, sendVerification, verifyEmail } from "./auth";
import { json } from "./http";
import { dashboard } from "./dashboard";
import { archiveClient, createClient, listClients, updateClient } from "./clients";
import { cancelJob, createJob, listJobs, updateJob } from "./jobs";
import { createExpense, deleteExpense, listExpenses } from "./expenses";
import { createInvoice, getInvoice, listInvoices, recordPayment, updateInvoice } from "./invoices";
import { convertQuote, createQuote, getQuote, listQuotes, updateQuote } from "./quotes";
import { squareWebhook } from "./square";
import { billingStatus, cancelBilling, createCheckout, reconcileBilling } from "./billing";
import { emailConfigured } from "./email";
import { sendInvoiceEmail, sendQuoteEmail } from "./document-email";
import { cancelReminder, completeReminder, createReminder, today } from "./reminders";
import { exportReportCsv, reportSummary } from "./reports";
import { getSettings, updateSettings } from "./settings";
import { smartWrite, smartWriteUsage } from "./smart-write";
import { deleteAccount, exportAccountData } from "./account";
import { enforceAuthRateLimit, enforceMutationRateLimit, secureAssetResponse } from "./security";
import { runMaintenance } from "./maintenance";

const VERSION = "0.8.2-native-pbkdf2";

async function api(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "OPTIONS") return new Response(null, { status: 204 });

  if (path.startsWith("/api/auth/") && request.method !== "GET") {
    const limited = await enforceAuthRateLimit(request, env);
    if (limited) return limited;
  } else if (
    ["POST", "PATCH", "DELETE"].includes(request.method) &&
    path !== "/api/webhooks/square"
  ) {
    const limited = await enforceMutationRateLimit(request, env);
    if (limited) return limited;
  }

  if (request.method === "GET" && path === "/api/health") {
    return json({
      status: "ok",
      service: "clientstream",
      version: VERSION,
      environment: env.APP_ENV ?? "unknown",
      database: "bound",
      squareWebhook: env.SQUARE_WEBHOOK_SIGNATURE_KEY ? "configured" : "unconfigured",
      squareBilling: env.SQUARE_ACCESS_TOKEN && env.SQUARE_LOCATION_ID && env.SQUARE_PRO_PLAN_VARIATION_ID ? "configured" : "unconfigured",
      transactionalEmail: emailConfigured(env) ? "configured" : "unconfigured",
      workersAI: env.AI ? "configured" : "unconfigured",
      timestamp: new Date().toISOString()
    });
  }

  if (request.method === "GET" && path === "/api/plans") return json({ plans: PLAN_CATALOG });

  if (request.method === "GET" && path === "/api/account/export") return exportAccountData(request, env);
  if (request.method === "POST" && path === "/api/account/delete") return deleteAccount(request, env);

  if (request.method === "POST" && path === "/api/auth/register") return register(request, env);
  if (request.method === "POST" && path === "/api/auth/login") return login(request, env);
  if (request.method === "POST" && path === "/api/auth/logout") return logout(request, env);
  if (request.method === "POST" && path === "/api/auth/request-reset") return requestPasswordReset(request, env);
  if (request.method === "POST" && path === "/api/auth/reset-password") return resetPassword(request, env);
  if (request.method === "POST" && path === "/api/auth/send-verification") return sendVerification(request, env);
  if (request.method === "POST" && path === "/api/auth/verify-email") return verifyEmail(request, env);

  if (request.method === "GET" && path === "/api/me") {
    const context = await getAuthContext(request, env);
    if (!context) return json({ error: "Authentication required." }, { status: 401 });
    return json({
      user: context.user,
      business: context.business,
      plan: context.business ? PLAN_CATALOG[context.business.plan] : null,
      emailConfigured: emailConfigured(env)
    });
  }

  if (request.method === "GET" && path === "/api/dashboard") return dashboard(request, env);
  if (request.method === "GET" && path === "/api/today") return today(request, env);

  if (path === "/api/reminders" && request.method === "POST") return createReminder(request, env);
  if (/^\/api\/reminders\/[^/]+\/complete$/.test(path) && request.method === "POST") return completeReminder(request, env);
  if (/^\/api\/reminders\/[^/]+$/.test(path) && request.method === "DELETE") return cancelReminder(request, env);

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

  if (path === "/api/quotes") {
    if (request.method === "GET") return listQuotes(request, env);
    if (request.method === "POST") return createQuote(request, env);
  }
  if (/^\/api\/quotes\/[^/]+\/send-email$/.test(path) && request.method === "POST") {
    return sendQuoteEmail(request, env);
  }
  if (/^\/api\/quotes\/[^/]+\/convert$/.test(path) && request.method === "POST") {
    return convertQuote(request, env);
  }
  if (/^\/api\/quotes\/[^/]+$/.test(path)) {
    if (request.method === "GET") return getQuote(request, env);
    if (request.method === "PATCH") return updateQuote(request, env);
  }

  if (path === "/api/invoices") {
    if (request.method === "GET") return listInvoices(request, env);
    if (request.method === "POST") return createInvoice(request, env);
  }
  if (/^\/api\/invoices\/[^/]+$/.test(path)) {
    if (request.method === "GET") return getInvoice(request, env);
    if (request.method === "PATCH") return updateInvoice(request, env);
  }
  if (/^\/api\/invoices\/[^/]+\/send-email$/.test(path) && request.method === "POST") {
    return sendInvoiceEmail(request, env);
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

  if (request.method === "GET" && path === "/api/reports/summary") return reportSummary(request, env);
  if (request.method === "GET" && path === "/api/reports/export.csv") return exportReportCsv(request, env);

  if (path === "/api/settings") {
    if (request.method === "GET") return getSettings(request, env);
    if (request.method === "PATCH") return updateSettings(request, env);
  }

  if (request.method === "GET" && path === "/api/smart-write/usage") return smartWriteUsage(request, env);
  if (request.method === "POST" && path === "/api/smart-write") return smartWrite(request, env);

  if (request.method === "GET" && path === "/api/billing/status") return billingStatus(request, env);
  if (request.method === "POST" && path === "/api/billing/checkout") return createCheckout(request, env);
  if (request.method === "POST" && path === "/api/billing/reconcile") return reconcileBilling(request, env);
  if (request.method === "POST" && path === "/api/billing/cancel") return cancelBilling(request, env);

  if (request.method === "POST" && path === "/api/webhooks/square") return squareWebhook(request, env);

  return json({ error: "Not found." }, { status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return secureAssetResponse(await env.ASSETS.fetch(request));
    }

    const requestId = crypto.randomUUID();
    try {
      const response = await api(request, env);
      response.headers.set("x-request-id", requestId);
      return response;
    } catch (error) {
      console.error("ClientStream API error", {
        requestId,
        method: request.method,
        path: url.pathname,
        error
      });
      return json(
        { error: "Something went wrong. Please try again.", requestId },
        { status: 500, headers: { "x-request-id": requestId } }
      );
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runMaintenance(env));
  }
} satisfies ExportedHandler<Env>;
