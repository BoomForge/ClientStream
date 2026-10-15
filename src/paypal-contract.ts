// Pure PayPal subscription contract rules. No credentials or account state.
export interface PayPalPlan {
  id?: string;
  status?: string;
  product_id?: string;
  billing_cycles?: Array<{
    tenure_type?: string;
    total_cycles?: number;
    frequency?: { interval_unit?: string; interval_count?: number };
    pricing_scheme?: { fixed_price?: { value?: string; currency_code?: string } };
  }>;
}

export interface PayPalSubscription {
  id?: string;
  plan_id?: string;
  custom_id?: string;
  status?: string;
  start_time?: string;
  status_update_time?: string;
  subscriber?: { email_address?: string; payer_id?: string };
  billing_info?: {
    next_billing_time?: string;
    last_payment?: { time?: string; amount?: { value?: string; currency_code?: string } };
    failed_payments_count?: number;
  };
  links?: Array<{ rel?: string; href?: string }>;
}

export function planMatchesClientStream(plan: PayPalPlan, expectedPlanId: string): boolean {
  if (plan.id !== expectedPlanId || plan.status !== "ACTIVE") return false;
  const cycles = plan.billing_cycles ?? [];
  if (cycles.length !== 1) return false;
  const cycle = cycles[0];
  const price = cycle.pricing_scheme?.fixed_price;
  return cycle.tenure_type === "REGULAR"
    && cycle.total_cycles === 0
    && cycle.frequency?.interval_unit === "MONTH"
    && cycle.frequency.interval_count === 1
    && price?.currency_code === "AUD"
    && price.value === "9.99";
}

export function subscriptionStatus(value?: string): "pending" | "active" | "past_due" | "cancelled" | "inactive" {
  switch (value) {
    case "ACTIVE": return "active";
    case "APPROVAL_PENDING":
    case "APPROVED":
    case "CREATED": return "pending";
    case "SUSPENDED": return "past_due";
    case "CANCELLED":
    case "EXPIRED": return "cancelled";
    default: return "inactive";
  }
}

export function approvedPayPalUrl(value: string | undefined, mode: "sandbox" | "live"): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const domains = mode === "sandbox"
      ? ["www.sandbox.paypal.com", "sandbox.paypal.com"]
      : ["www.paypal.com", "paypal.com"];
    return url.protocol === "https:" && domains.includes(url.hostname)
      && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Pro requires a paid first cycle, not merely an approved recurring mandate. */
export function hasConfirmedProPayment(subscription: PayPalSubscription): boolean {
  const last = subscription.billing_info?.last_payment;
  const timestamp = last?.time ? Date.parse(last.time) : NaN;
  return subscription.status === "ACTIVE" &&
    Number.isFinite(timestamp) &&
    timestamp <= Date.now() + 300_000 &&
    last?.amount?.currency_code === "AUD" &&
    last?.amount?.value === "9.99";
}
