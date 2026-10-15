import type { Env } from "./types";
import { PLAN_CATALOG } from "./types";
import { requireAuth, requireBusiness } from "./auth";
import { json, mutationOriginIsAllowed } from "./http";
import { paypalCall, paypalConfig, loadPayPalPlan, loadPayPalSubscription } from "./paypal";
import { planMatchesClientStream, subscriptionStatus, approvedPayPalUrl, hasConfirmedProPayment } from "./paypal-contract";
import type { PayPalSubscription } from "./paypal-contract";

interface LinkedSubscription {
  id: string;
  provider_subscription_id: string;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: number;
}

async function linked(env: Env, businessId: string): Promise<LinkedSubscription | null> {
  return env.DB.prepare(
    "SELECT id, provider_subscription_id, status, current_period_end, cancel_at_period_end FROM subscriptions WHERE business_id = ? AND provider = 'paypal' ORDER BY updated_at DESC LIMIT 1"
  ).bind(businessId).first<LinkedSubscription>();
}

async function applySubscription(env: Env, businessId: string, subscription: PayPalSubscription): Promise<boolean> {
  const config = paypalConfig(env);
  if (!config || !subscription.id || subscription.plan_id !== config.planId ||
      subscription.custom_id !== businessId) return false;

  const status = subscription.status === "ACTIVE" && !hasConfirmedProPayment(subscription)
    ? "pending" : subscriptionStatus(subscription.status);
  const now = new Date().toISOString();
  const nextBilling = subscription.billing_info?.next_billing_time ?? null;
  const currentPeriodStart = subscription.start_time ?? null;
  const payer = subscription.subscriber?.payer_id ?? null;
  const existing = await env.DB.prepare(
    "SELECT id, business_id FROM subscriptions WHERE provider = 'paypal' AND provider_subscription_id = ? LIMIT 1"
  ).bind(subscription.id).first<{ id: string; business_id: string }>();
  if (existing && existing.business_id !== businessId) return false;
  if (existing) {
    await env.DB.prepare(
      "UPDATE subscriptions SET provider_customer_id = ?, plan = 'pro', status = ?, current_period_start = ?, current_period_end = ?, cancel_at_period_end = 0, updated_at = ? WHERE id = ?"
    ).bind(payer, status, currentPeriodStart, nextBilling, now, existing.id).run();
  } else {
    await env.DB.prepare(
      "INSERT INTO subscriptions (id, business_id, provider, provider_customer_id, provider_subscription_id, plan, status, current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at) VALUES (?, ?, 'paypal', ?, ?, 'pro', ?, ?, ?, 0, ?, ?)"
    ).bind(crypto.randomUUID(), businessId, payer, subscription.id, status,
      currentPeriodStart, nextBilling, now, now).run();
  }
  await env.DB.prepare("UPDATE businesses SET plan = ?, updated_at = ? WHERE id = ?")
    .bind(status === "active" ? "pro" : "free", now, businessId).run();
  return true;
}

export async function reconcileLinkedSubscription(env: Env, subscriptionId: string): Promise<boolean> {
  const association = await env.DB.prepare(
    "SELECT business_id FROM subscriptions WHERE provider = 'paypal' AND provider_subscription_id = ? LIMIT 1"
  ).bind(subscriptionId).first<{ business_id: string }>();
  if (!association) return false;
  const remote = await loadPayPalSubscription(env, subscriptionId);
  if (remote.id !== subscriptionId) return false;
  return applySubscription(env, association.business_id, remote);
}

export async function billingStatus(request: Request, env: Env): Promise<Response> {
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;
  const row = await linked(env, business.id);

  return json({
    provider: "paypal",
    configured: Boolean(paypalConfig(env)?.webhookId),
    environment: env.PAYPAL_ENVIRONMENT === "sandbox" ? "sandbox" : env.PAYPAL_ENVIRONMENT === "live" ? "live" : null,
    businessPlan: business.plan,
    subscription: row ? {
      plan: "pro",
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
  if (business.role !== "owner") return json({ error: "Only the business owner can manage billing." }, { status: 403 });
  if (!context.user.emailVerified) return json({
    error: "Verify your email before upgrading your plan.", code: "EMAIL_VERIFICATION_REQUIRED"
  }, { status: 403 });
  const config = paypalConfig(env);
  if (!config?.webhookId) return json({ error: "PayPal subscriptions and signed webhooks are not configured yet.", code: "BILLING_NOT_CONFIGURED" }, { status: 503 });
  if (business.plan === "pro") return json({ error: "This business is already on Pro." }, { status: 409 });
  // Prevent duplicate subscriptions from multiple clicks or prior pending checkout.
  const previous = await linked(env, business.id);
  if (previous?.provider_subscription_id) {
    let existing: PayPalSubscription | null = null;
    try { existing = await loadPayPalSubscription(env, previous.provider_subscription_id); }
    catch { return json({ error: "Unable to verify your existing PayPal subscription. Try again shortly." }, { status: 503 }); }
    if (existing.status === "ACTIVE") {
      await applySubscription(env, business.id, existing);
      return json({ error: "You already have a PayPal subscription. Use Check payment to confirm Pro activation.", code: "SUBSCRIPTION_ACTIVE" }, { status: 409 });
    }
    if (existing.status === "APPROVAL_PENDING" || existing.status === "APPROVED") {
      const href = existing.links?.find((link) => link.rel === "approve")?.href;
      const checkoutUrl = approvedPayPalUrl(href, config.mode);
      if (checkoutUrl) return json({ checkoutUrl });
      return json({ error: "PayPal is still preparing your subscription. Try again later." }, { status: 503 });
    }
    if (existing.status === "SUSPENDED") {
      return json({ error: "An existing subscription needs attention in PayPal before upgrading.", code: "SUBSCRIPTION_SUSPENDED" }, { status: 409 });
    }
  }

  const plan = await loadPayPalPlan(env);
  if (!planMatchesClientStream(plan, config.planId))
    return json({ error: "PayPal plan must be active at exactly A$9.99 per month before checkout.", code: "PLAN_MISMATCH" }, { status: 503 });

  const nowLock = new Date();
  // A D1 uniqueness claim prevents two concurrent tabs creating two paid plans.
  await env.DB.prepare(
    "DELETE FROM paypal_checkout_claims WHERE business_id = ? AND expires_at <= ?"
  ).bind(business.id, nowLock.toISOString()).run();
  const claimId = crypto.randomUUID();
  const claim = await env.DB.prepare(
    "INSERT OR IGNORE INTO paypal_checkout_claims (business_id, claim_id, expires_at) VALUES (?, ?, ?)"
  ).bind(business.id, claimId, new Date(nowLock.getTime() + 120_000).toISOString()).run();
  if (claim.meta.changes !== 1) {
    return json({ error: "PayPal checkout is already being prepared for this business. Try again shortly." }, { status: 409 });
  }
  try {
  const origin = new URL(request.url).origin;
  const result = await paypalCall<PayPalSubscription>(
    env,
    "/v1/billing/subscriptions",
    "POST",
    {
      plan_id: config.planId,
      custom_id: business.id,
      application_context: {
        brand_name: "ClientStream",
        shipping_preference: "NO_SHIPPING",
        user_action: "SUBSCRIBE_NOW",
        return_url: origin + "/?billing=success",
        cancel_url: origin + "/?billing=cancelled"
      }
    },
    crypto.randomUUID()
  );
  if (!result.id || !/^I-[A-Z0-9]+$/i.test(result.id)) throw new Error("PayPal did not return a valid subscription ID.");
  const checkoutUrl = approvedPayPalUrl(
    result.links?.find((link) => link.rel === "approve")?.href, config.mode
  );
  if (!checkoutUrl) throw new Error("PayPal did not return an approved checkout URL.");

  const now = new Date().toISOString();
  if (previous) {
    await env.DB.prepare(
      "UPDATE subscriptions SET provider_subscription_id = ?, provider_customer_id = NULL, plan = 'pro', status = 'pending', current_period_start = NULL, current_period_end = NULL, cancel_at_period_end = 0, updated_at = ? WHERE id = ?"
    ).bind(result.id, now, previous.id).run();
  } else {
    await env.DB.prepare(
      "INSERT INTO subscriptions (id, business_id, provider, provider_subscription_id, plan, status, created_at, updated_at) VALUES (?, ?, 'paypal', ?, 'pro', 'pending', ?, ?)"
    ).bind(crypto.randomUUID(), business.id, result.id, now, now).run();
  }
  return json({ checkoutUrl });
  } finally {
    await env.DB.prepare(
      "DELETE FROM paypal_checkout_claims WHERE business_id = ? AND claim_id = ?"
    ).bind(business.id, claimId).run();
  }
}

export async function reconcileBilling(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) return json({ error: "Origin not allowed." }, { status: 403 });
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;
  if (business.role !== "owner") return json({ error: "Only the business owner can manage billing." }, { status: 403 });
  if (!context.user.emailVerified) return json({ error: "Verify your email before managing your Pro subscription.", code: "EMAIL_VERIFICATION_REQUIRED" }, { status: 403 });
  if (!paypalConfig(env)) return json({ error: "PayPal subscriptions are not configured yet." }, { status: 503 });

  const row = await linked(env, business.id);
  if (!row?.provider_subscription_id) return json({ active: false, reconciled: false, message: "No linked PayPal subscription." });
  const subscription = await loadPayPalSubscription(env, row.provider_subscription_id);
  const applied = await applySubscription(env, business.id, subscription);
  if (!applied) return json({ error: "PayPal subscription does not match this business and plan." }, { status: 409 });
  return json({ reconciled: true, active: hasConfirmedProPayment(subscription), status: hasConfirmedProPayment(subscription) ? "active" : subscriptionStatus(subscription.status) });
}

export async function cancelBilling(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) return json({ error: "Origin not allowed." }, { status: 403 });
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;
  if (business.role !== "owner") return json({ error: "Only the business owner can cancel the subscription." }, { status: 403 });
  if (!paypalConfig(env)) return json({ error: "PayPal subscriptions are not configured yet." }, { status: 503 });

  const row = await linked(env, business.id);
  if (!row?.provider_subscription_id) return json({ error: "No linked PayPal subscription." }, { status: 404 });
  const remote = await loadPayPalSubscription(env, row.provider_subscription_id);
  if (!await applySubscription(env, business.id, remote)) {
    return json({ error: "Unable to validate your PayPal subscription." }, { status: 409 });
  }
  if (remote.status === "CANCELLED" || remote.status === "EXPIRED") {
    return json({ cancelled: true });
  }
  await paypalCall<unknown>(
    env, "/v1/billing/subscriptions/" + encodeURIComponent(row.provider_subscription_id) + "/cancel",
    "POST", { reason: "Customer cancelled ClientStream Pro." }, crypto.randomUUID()
  );
  const after = await loadPayPalSubscription(env, row.provider_subscription_id);
  if (!await applySubscription(env, business.id, after)) {
    return json({ error: "PayPal cancellation was requested but status could not be confirmed. Contact support." }, { status: 503 });
  }
  return json({ cancelled: after.status === "CANCELLED", cancellationScheduled: false, active: after.status === "ACTIVE" });
}
