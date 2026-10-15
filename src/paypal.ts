import type { Env } from "./types";
import type { PayPalPlan, PayPalSubscription } from "./paypal-contract";

type PayPalMode = "sandbox" | "live";
export interface PayPalConfig {
  baseUrl: string;
  mode: PayPalMode;
  planId: string;
  webhookId: string | null;
}

export function paypalConfig(env: Env): PayPalConfig | null {
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET || !env.PAYPAL_PLAN_ID ||
      !["sandbox", "live"].includes(env.PAYPAL_ENVIRONMENT ?? "")) return null;
  const mode = env.PAYPAL_ENVIRONMENT as PayPalMode;
  return {
    mode,
    baseUrl: mode === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com",
    planId: env.PAYPAL_PLAN_ID,
    webhookId: env.PAYPAL_WEBHOOK_ID?.trim() || null
  };
}

export async function paypalToken(env: Env): Promise<string> {
  const config = paypalConfig(env);
  if (!config) throw new Error("PayPal is not configured.");
  const authorization = btoa(env.PAYPAL_CLIENT_ID + ":" + env.PAYPAL_CLIENT_SECRET);
  const response = await fetch(config.baseUrl + "/v1/oauth2/token", {
    method: "POST",
    headers: {
      authorization: "Basic " + authorization,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json"
    },
    body: "grant_type=client_credentials"
  });
  if (!response.ok) throw new Error("PayPal authentication is unavailable.");
  const data = await response.json() as { access_token?: string };
  if (!data.access_token) throw new Error("PayPal did not issue an access token.");
  return data.access_token;
}

export async function paypalCall<T>(
  env: Env,
  path: string,
  method = "GET",
  body?: unknown,
  requestId?: string
): Promise<T> {
  const config = paypalConfig(env);
  if (!config) throw new Error("PayPal is not configured.");
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Invalid PayPal API path.");
  const token = await paypalToken(env);
  const headers: Record<string, string> = {
    authorization: "Bearer " + token,
    accept: "application/json",
    "content-type": "application/json",
    prefer: "return=representation"
  };
  if (requestId) headers["paypal-request-id"] = requestId;
  const response = await fetch(config.baseUrl + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.ok) {
    // PayPal failure payloads can contain account/customer information. Don't log or return them.
    throw new Error("PayPal request failed (HTTP " + response.status + ").");
  }
  const text = await response.text();
  return (text ? JSON.parse(text) : {}) as T;
}

export async function loadPayPalPlan(env: Env): Promise<PayPalPlan> {
  const config = paypalConfig(env);
  if (!config) throw new Error("PayPal is not configured.");
  return paypalCall<PayPalPlan>(env, "/v1/billing/plans/" + encodeURIComponent(config.planId));
}

export async function loadPayPalSubscription(env: Env, id: string): Promise<PayPalSubscription> {
  if (!/^I-[A-Z0-9]+$/i.test(id)) throw new Error("Invalid PayPal subscription reference.");
  return paypalCall<PayPalSubscription>(env, "/v1/billing/subscriptions/" + encodeURIComponent(id));
}

export async function verifyPayPalEvent(env: Env, request: Request, event: unknown): Promise<boolean> {
  const config = paypalConfig(env);
  if (!config?.webhookId) return false;
  const read = (header: string) => request.headers.get(header) || "";
  const transmission_id = read("paypal-transmission-id");
  const transmission_time = read("paypal-transmission-time");
  const transmission_sig = read("paypal-transmission-sig");
  const cert_url = read("paypal-cert-url");
  const auth_algo = read("paypal-auth-algo");
  if (!transmission_id || !transmission_time || !transmission_sig || !cert_url || !auth_algo) return false;
  const date = Date.parse(transmission_time);
  if (!Number.isFinite(date) || Math.abs(Date.now() - date) > 10 * 60_000) return false;
  if (auth_algo !== "SHA256withRSA") return false;
  // Only PayPal certificate URLs for the selected environment are accepted.
  try {
    const cert = new URL(cert_url);
    if (cert.protocol !== "https:" ||
        ![config.mode === "live" ? "api-m.paypal.com" : "api-m.sandbox.paypal.com",
          config.mode === "live" ? "api.paypal.com" : "api.sandbox.paypal.com"].includes(cert.hostname)
        || !cert.pathname.startsWith("/v1/notifications/certs/")) return false;
  } catch { return false; }

  const response = await paypalCall<{ verification_status?: string }>(
    env,
    "/v1/notifications/verify-webhook-signature",
    "POST",
    { auth_algo, cert_url, transmission_id, transmission_sig, transmission_time,
      webhook_id: config.webhookId, webhook_event: event }
  );
  return response.verification_status === "SUCCESS";
}
