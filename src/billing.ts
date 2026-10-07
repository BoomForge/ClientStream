import type { AuthContext, BusinessContext, Env } from "./types";
import { PLAN_CATALOG } from "./types";
import { requireAuth, requireBusiness } from "./auth";
import { json, mutationOriginIsAllowed } from "./http";

const SQUARE_VERSION = "2026-09-16";

export interface SquareSubscription {
  id: string;
  customer_id: string;
  location_id?: string;
  plan_variation_id?: string;
  status?: string;
  start_date?: string;
  canceled_date?: string;
  charged_through_date?: string;
  paid_until_date?: string;
  created_at?: string;
}

interface BillingConfig {
  accessToken: string;
  locationId: string;
  planVariationId: string;
  baseUrl: string;
}

function getConfig(env: Env): BillingConfig | null {
  if (!env.SQUARE_ACCESS_TOKEN || !env.SQUARE_LOCATION_ID || !env.SQUARE_PRO_PLAN_VARIATION_ID) {
    return null;
  }
  return {
    accessToken: env.SQUARE_ACCESS_TOKEN,
    locationId: env.SQUARE_LOCATION_ID,
    planVariationId: env.SQUARE_PRO_PLAN_VARIATION_ID,
    baseUrl: env.SQUARE_ENVIRONMENT === "sandbox"
      ? "https://connect.squareupsandbox.com"
      : "https://connect.squareup.com"
  };
}

async function squareFetch<T>(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const config = getConfig(env);
  if (!config) throw new Error("Square billing is not configured.");

  const headers = new Headers(init.headers);
  headers.set("authorization", "Bearer " + config.accessToken);
  headers.set("square-version", SQUARE_VERSION);
  headers.set("content-type", "application/json");

  const response = await fetch(config.baseUrl + path, { ...init, headers });
  const body = await response.json() as {
    errors?: Array<{ code?: string; detail?: string }>;
  } & T;

  if (!response.ok) {
    const detail = body.errors?.[0]?.detail || body.errors?.[0]?.code || "Square request failed.";
    throw new Error(detail);
  }

  return body;
}

function localStatus(status?: string): "pending" | "active" | "past_due" | "cancelled" | "inactive" {
  switch ((status || "").toUpperCase()) {
    case "ACTIVE":
      return "active";
    case "PENDING":
      return "pending";
    case "PAUSED":
      return "past_due";
    case "CANCELED":
    case "DEACTIVATED":
      return "cancelled";
    default:
      return "inactive";
  }
}

function isProActive(subscription: SquareSubscription): boolean {
  return (subscription.status || "").toUpperCase() === "ACTIVE";
}

async function applySubscription(
  env: Env,
  businessId: string,
  subscription: SquareSubscription
): Promise<void> {
  const config = getConfig(env);
  if (!config || subscription.plan_variation_id !== config.planVariationId) return;

  const now = new Date().toISOString();
  const status = localStatus(subscription.status);
  const periodEnd = subscription.paid_until_date
    ?? subscription.charged_through_date
    ?? subscription.canceled_date
    ?? null;

  const existing = await env.DB.prepare(
    "SELECT id FROM subscriptions WHERE provider_subscription_id = ? OR (business_id = ? AND provider = 'square') ORDER BY created_at ASC LIMIT 1"
  ).bind(subscription.id, businessId).first<{ id: string }>();

  if (existing) {
    await env.DB.prepare(
      "UPDATE subscriptions SET provider_customer_id = ?, provider_subscription_id = ?, plan = 'pro', status = ?, current_period_start = COALESCE(current_period_start, ?), current_period_end = ?, updated_at = ? WHERE id = ?"
    ).bind(
      subscription.customer_id,
      subscription.id,
      status,
      subscription.start_date ?? null,
      periodEnd,
      now,
      existing.id
    ).run();
  } else {
    await env.DB.prepare(
      "INSERT INTO subscriptions (id, business_id, provider, provider_customer_id, provider_subscription_id, plan, status, current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at) VALUES (?, ?, 'square', ?, ?, 'pro', ?, ?, ?, 0, ?, ?)"
    ).bind(
      crypto.randomUUID(),
      businessId,
      subscription.customer_id,
      subscription.id,
      status,
      subscription.start_date ?? null,
      periodEnd,
      now,
      now
    ).run();
  }

  await env.DB.prepare(
    "UPDATE businesses SET plan = ?, updated_at = ? WHERE id = ?"
  ).bind(isProActive(subscription) ? "pro" : "free", now, businessId).run();
}

async function findBusinessForCustomer(env: Env, customerId: string): Promise<string | null> {
  const existing = await env.DB.prepare(
    "SELECT business_id FROM subscriptions WHERE provider = 'square' AND provider_customer_id = ? LIMIT 1"
  ).bind(customerId).first<{ business_id: string }>();
  if (existing) return existing.business_id;

  if (!getConfig(env)) return null;

  const customerResponse = await squareFetch<{ customer?: { id: string; email_address?: string } }>(
    env,
    "/v2/customers/" + encodeURIComponent(customerId),
    { method: "GET" }
  );
  const email = customerResponse.customer?.email_address?.trim().toLowerCase();
  if (!email) return null;

  const match = await env.DB.prepare(
    "SELECT b.id FROM users u JOIN memberships m ON m.user_id = u.id JOIN businesses b ON b.id = m.business_id WHERE u.email = ? COLLATE NOCASE ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END LIMIT 1"
  ).bind(email).first<{ id: string }>();

  return match?.id ?? null;
}

export async function processSquareSubscriptionEvent(
  env: Env,
  event: {
    type?: string;
    data?: {
      object?: {
        subscription?: SquareSubscription;
      };
    };
  }
): Promise<"processed" | "ignored"> {
  if (!event.type?.startsWith("subscription.")) return "ignored";

  const subscription = event.data?.object?.subscription;
  const config = getConfig(env);
  if (!subscription?.id || !subscription.customer_id || !config) return "ignored";
  if (subscription.plan_variation_id !== config.planVariationId) return "ignored";

  const bySubscription = await env.DB.prepare(
    "SELECT business_id FROM subscriptions WHERE provider_subscription_id = ? LIMIT 1"
  ).bind(subscription.id).first<{ business_id: string }>();

  const businessId = bySubscription?.business_id
    ?? await findBusinessForCustomer(env, subscription.customer_id);

  if (!businessId) return "ignored";

  await applySubscription(env, businessId, subscription);
  return "processed";
}

export async function billingStatus(request: Request, env: Env): Promise<Response> {
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;

  const row = await env.DB.prepare(
    "SELECT plan, status, provider_subscription_id, current_period_end, cancel_at_period_end FROM subscriptions WHERE business_id = ? AND provider = 'square' ORDER BY updated_at DESC LIMIT 1"
  ).bind(business.id).first<{
    plan: string;
    status: string;
    provider_subscription_id: string | null;
    current_period_end: string | null;
    cancel_at_period_end: number;
  }>();

  return json({
    configured: Boolean(getConfig(env)),
    businessPlan: business.plan,
    subscription: row ? {
      plan: row.plan,
      status: row.status,
      currentPeriodEnd: row.current_period_end,
      cancelAtPeriodEnd: Boolean(row.cancel_at_period_end)
    } : null,
    price: PLAN_CATALOG.pro.monthlyAudCents,
    currency: "AUD"
  });
}

export async function createCheckout(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) return json({ error: "Origin not allowed." }, { status: 403 });

  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;
  const config = getConfig(env);

  if (!config) return json({ error: "Square billing is not configured yet.", code: "BILLING_NOT_CONFIGURED" }, { status: 503 });
  if (business.plan === "pro") return json({ error: "This business is already on Pro." }, { status: 409 });

  const origin = new URL(request.url).origin;
  const payload = {
    idempotency_key: crypto.randomUUID(),
    description: "ClientStream Pro subscription for " + business.name,
    quick_pay: {
      name: "ClientStream Pro",
      price_money: {
        amount: PLAN_CATALOG.pro.monthlyAudCents,
        currency: "AUD"
      },
      location_id: config.locationId
    },
    checkout_options: {
      allow_tipping: false,
      ask_for_shipping_address: false,
      subscription_plan_id: config.planVariationId,
      redirect_url: origin + "/?billing=success"
    },
    pre_populated_data: {
      buyer_email: context.user.email
    }
  };

  const response = await squareFetch<{
    payment_link?: { id?: string; url?: string; long_url?: string };
  }>(env, "/v2/online-checkout/payment-links", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  const checkoutUrl = response.payment_link?.url ?? response.payment_link?.long_url;
  if (!checkoutUrl) throw new Error("Square did not return a checkout URL.");

  return json({ checkoutUrl });
}

async function searchSquareCustomers(env: Env, email: string): Promise<string[]> {
  const response = await squareFetch<{
    customers?: Array<{ id: string; email_address?: string }>;
  }>(env, "/v2/customers/search", {
    method: "POST",
    body: JSON.stringify({
      limit: 20,
      query: {
        filter: {
          email_address: {
            exact: email
          }
        }
      }
    })
  });

  return (response.customers ?? [])
    .filter((customer) => customer.email_address?.toLowerCase() === email.toLowerCase())
    .map((customer) => customer.id);
}

async function searchSubscriptions(env: Env, customerIds: string[]): Promise<SquareSubscription[]> {
  if (!customerIds.length) return [];
  const config = getConfig(env);
  if (!config) return [];

  const response = await squareFetch<{ subscriptions?: SquareSubscription[] }>(
    env,
    "/v2/subscriptions/search",
    {
      method: "POST",
      body: JSON.stringify({
        limit: 100,
        query: {
          filter: {
            location_ids: [config.locationId],
            customer_ids: customerIds
          }
        }
      })
    }
  );

  return (response.subscriptions ?? []).filter(
    (subscription) => subscription.plan_variation_id === config.planVariationId
  );
}

export async function reconcileBilling(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) return json({ error: "Origin not allowed." }, { status: 403 });

  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;
  if (!getConfig(env)) return json({ error: "Square billing is not configured yet." }, { status: 503 });

  const customerIds = await searchSquareCustomers(env, context.user.email);
  const subscriptions = await searchSubscriptions(env, customerIds);

  subscriptions.sort((a, b) => {
    const rank = (subscription: SquareSubscription) => isProActive(subscription) ? 0 : 1;
    const rankDifference = rank(a) - rank(b);
    if (rankDifference) return rankDifference;
    return String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""));
  });

  const subscription = subscriptions[0];
  if (!subscription) {
    return json({ reconciled: false, active: false, message: "No matching Square subscription is visible yet." });
  }

  await applySubscription(env, business.id, subscription);

  return json({
    reconciled: true,
    active: isProActive(subscription),
    status: localStatus(subscription.status)
  });
}

export async function cancelBilling(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) return json({ error: "Origin not allowed." }, { status: 403 });

  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;

  if (business.role !== "owner") {
    return json({ error: "Only the business owner can cancel the subscription." }, { status: 403 });
  }
  if (!getConfig(env)) return json({ error: "Square billing is not configured yet." }, { status: 503 });

  const row = await env.DB.prepare(
    "SELECT id, provider_subscription_id FROM subscriptions WHERE business_id = ? AND provider = 'square' AND provider_subscription_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1"
  ).bind(business.id).first<{ id: string; provider_subscription_id: string }>();

  if (!row?.provider_subscription_id) return json({ error: "No Square subscription is linked to this business." }, { status: 404 });

  const response = await squareFetch<{ subscription?: SquareSubscription }>(
    env,
    "/v2/subscriptions/" + encodeURIComponent(row.provider_subscription_id) + "/cancel",
    { method: "POST", body: "{}" }
  );

  if (response.subscription) {
    await applySubscription(env, business.id, response.subscription);
  }

  await env.DB.prepare(
    "UPDATE subscriptions SET cancel_at_period_end = 1, updated_at = ? WHERE id = ?"
  ).bind(new Date().toISOString(), row.id).run();

  return json({ cancellationScheduled: true });
}
