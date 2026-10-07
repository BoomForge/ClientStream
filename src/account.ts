import type { Env } from "./types";
import { requireAuth, requireBusiness, verifyUserPassword } from "./auth";
import { json, mutationOriginIsAllowed, readJson } from "./http";

export async function exportAccountData(request: Request, env: Env): Promise<Response> {
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;

  const [
    businessRow,
    clients,
    jobs,
    quotes,
    quoteItems,
    invoices,
    invoiceItems,
    payments,
    expenses,
    reminders,
    subscription
  ] = await Promise.all([
    env.DB.prepare(
      "SELECT id, name, slug, plan, timezone, currency, business_email, business_phone, business_address, abn, google_review_url, gst_registered, created_at, updated_at FROM businesses WHERE id = ? LIMIT 1"
    ).bind(business.id).first(),
    env.DB.prepare(
      "SELECT id, name, company, email, phone, address, notes, status, created_at, updated_at FROM clients WHERE business_id = ? ORDER BY created_at ASC"
    ).bind(business.id).all(),
    env.DB.prepare(
      "SELECT id, client_id, title, description, status, scheduled_for, completed_at, created_at, updated_at FROM jobs WHERE business_id = ? ORDER BY created_at ASC"
    ).bind(business.id).all(),
    env.DB.prepare(
      "SELECT id, client_id, job_id, number, status, currency, subtotal_cents, tax_cents, total_cents, issued_at, expires_at, accepted_at, notes, created_at, updated_at FROM quotes WHERE business_id = ? ORDER BY created_at ASC"
    ).bind(business.id).all(),
    env.DB.prepare(
      "SELECT qi.id, qi.quote_id, qi.description, qi.quantity, qi.unit_price_cents, qi.sort_order FROM quote_items qi JOIN quotes q ON q.id = qi.quote_id WHERE q.business_id = ? ORDER BY qi.quote_id, qi.sort_order"
    ).bind(business.id).all(),
    env.DB.prepare(
      "SELECT id, client_id, job_id, quote_id, number, status, currency, subtotal_cents, tax_cents, total_cents, amount_paid_cents, issued_at, due_at, paid_at, notes, created_at, updated_at FROM invoices WHERE business_id = ? ORDER BY created_at ASC"
    ).bind(business.id).all(),
    env.DB.prepare(
      "SELECT ii.id, ii.invoice_id, ii.description, ii.quantity, ii.unit_price_cents, ii.sort_order FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE i.business_id = ? ORDER BY ii.invoice_id, ii.sort_order"
    ).bind(business.id).all(),
    env.DB.prepare(
      "SELECT id, invoice_id, provider, amount_cents, currency, status, paid_at, created_at FROM payments WHERE business_id = ? ORDER BY created_at ASC"
    ).bind(business.id).all(),
    env.DB.prepare(
      "SELECT id, description, category, amount_cents, currency, incurred_at, notes, created_at FROM expenses WHERE business_id = ? ORDER BY incurred_at ASC"
    ).bind(business.id).all(),
    env.DB.prepare(
      "SELECT id, client_id, invoice_id, kind, status, scheduled_for, sent_at, notified_at, payload_json, created_at FROM reminders WHERE business_id = ? ORDER BY created_at ASC"
    ).bind(business.id).all(),
    env.DB.prepare(
      "SELECT plan, status, current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at FROM subscriptions WHERE business_id = ? ORDER BY updated_at DESC LIMIT 1"
    ).bind(business.id).first()
  ]);

  const payload = {
    exportVersion: 1,
    exportedAt: new Date().toISOString(),
    account: {
      id: context.user.id,
      email: context.user.email,
      displayName: context.user.displayName,
      emailVerified: context.user.emailVerified
    },
    business: businessRow,
    clients: clients.results ?? [],
    jobs: jobs.results ?? [],
    quotes: quotes.results ?? [],
    quoteItems: quoteItems.results ?? [],
    invoices: invoices.results ?? [],
    invoiceItems: invoiceItems.results ?? [],
    payments: payments.results ?? [],
    expenses: expenses.results ?? [],
    reminders: reminders.results ?? [],
    subscription: subscription ?? null
  };

  const safeName = business.slug.replace(/[^a-z0-9-]/gi, "-").slice(0, 60) || "clientstream";
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": 'attachment; filename="' + safeName + '-data-export.json"',
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

export async function deleteAccount(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) return json({ error: "Origin not allowed." }, { status: 403 });

  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;

  if (business.role !== "owner") {
    return json({ error: "Only the business owner can delete this ClientStream business." }, { status: 403 });
  }

  const body = await readJson<{ password?: unknown; confirmation?: unknown }>(request);
  const password = typeof body?.password === "string" ? body.password : "";
  const confirmation = typeof body?.confirmation === "string" ? body.confirmation.trim() : "";

  if (confirmation !== "DELETE") {
    return json({ error: 'Type DELETE to confirm permanent deletion.' }, { status: 400 });
  }

  if (!(await verifyUserPassword(env, context.user.id, password))) {
    return json({ error: "Your password is incorrect." }, { status: 401 });
  }

  const activeSubscription = await env.DB.prepare(
    "SELECT provider_subscription_id FROM subscriptions WHERE business_id = ? AND provider = 'square' AND status IN ('active','pending','past_due') LIMIT 1"
  ).bind(business.id).first<{ provider_subscription_id: string | null }>();

  if (activeSubscription) {
    return json({
      error: "Cancel the active ClientStream Pro subscription before deleting the business.",
      code: "ACTIVE_SUBSCRIPTION"
    }, { status: 409 });
  }

  const providerIds = await env.DB.prepare(
    "SELECT provider_subscription_id FROM subscriptions WHERE business_id = ? AND provider_subscription_id IS NOT NULL"
  ).bind(business.id).all<{ provider_subscription_id: string }>();

  const cleanup: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM audit_log WHERE business_id = ? OR user_id = ?").bind(business.id, context.user.id)
  ];

  for (const row of providerIds.results ?? []) {
    cleanup.push(
      env.DB.prepare("DELETE FROM square_webhook_events WHERE payload_json LIKE ?")
        .bind("%" + row.provider_subscription_id.replace(/[%_]/g, "") + "%")
    );
  }

  cleanup.push(env.DB.prepare("DELETE FROM businesses WHERE id = ?").bind(business.id));
  await env.DB.batch(cleanup);

  const remaining = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM memberships WHERE user_id = ?"
  ).bind(context.user.id).first<{ count: number }>();

  if ((remaining?.count ?? 0) === 0) {
    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(context.user.id).run();
  }

  return json(
    { deleted: true },
    {
      headers: {
        "set-cookie": "cs_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
      }
    }
  );
}
