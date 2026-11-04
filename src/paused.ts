import type { Env } from "./types";
import { DEPLOY_REVISION } from "./revision";

/** Temporary, reversible pause; enabled by wrangler production configuration. */
export function clientStreamIsPaused(env: Env): boolean {
  return env.CLIENTSTREAM_PAUSED === "true";
}

const existingMemberPaths: ReadonlySet<string> = new Set([
  "POST /api/auth/login",
  "POST /api/auth/logout",
  "GET /api/me",
  "GET /api/billing/status",
  "POST /api/billing/cancel",
  "GET /api/account/export"
]);

/**
 * Only the owner's Cloudflare deployment changes this pause. The app keeps
 * verified PayPal webhook updates and limited authenticated subscriber
 * actions; every checkout, registration and data mutation is unavailable.
 */
export function clientStreamPausedApiAllowed(request: Request, path: string): boolean {
  if (path === "/api/webhooks/paypal" && request.method === "POST") return true;
  if (path === "/api/siteguard/referral" && (request.method === "GET" || request.method === "HEAD")) return true;
  return existingMemberPaths.has(request.method + " " + path);
}

export function clientStreamPausedHealth(): Response {
  return new Response(JSON.stringify({
    status: "paused",
    paused: true,
    service: "clientstream",
    revision: DEPLOY_REVISION,
    newRegistrations: false,
    newCheckouts: false,
    existingCustomerBillingAccess: true,
    paypalWebhookIntake: true
  }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow"
    }
  });
}

export function clientStreamPausedApiResponse(): Response {
  return new Response(JSON.stringify({
    status: "paused",
    error: "ClientStream is temporarily unavailable.",
    purchasesEnabled: false,
    registrationEnabled: false
  }), {
    status: 503,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "retry-after": "86400"
    }
  });
}

export async function clientStreamPausedPage(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const allowedAsset = url.pathname === "/maintenance.js" || url.pathname === "/favicon.svg";
  if (allowedAsset && (method === "GET" || method === "HEAD")) {
    return env.ASSETS.fetch(request);
  }
  if (method !== "GET" && method !== "HEAD") return clientStreamPausedApiResponse();
  const pageUrl = new URL("/maintenance.html", url.origin);
  const html = await env.ASSETS.fetch(new Request(pageUrl.toString(), { method: "GET" }));
  if (!html.ok) {
    return new Response("ClientStream is temporarily paused. Accounts and data are preserved.", {
      status: 503, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
    });
  }
  return new Response(method === "HEAD" ? null : html.body, {
    status: 503,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      "retry-after": "86400",
      "x-robots-tag": "noindex, nofollow",
      "x-clientstream-status": "paused",
      "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
    }
  });
}
