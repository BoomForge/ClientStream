import type { Env } from "./types";
import { requireAuth, requireBusiness } from "./auth";
import { json, mutationOriginIsAllowed, normaliseEmail, readJson, textValue, validEmail } from "./http";

function validOptionalUrl(value: string | null): boolean {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export async function getSettings(request: Request, env: Env): Promise<Response> {
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;

  const row = await env.DB.prepare(
    "SELECT name, business_email, business_phone, business_address, abn, google_review_url, timezone, currency, gst_registered, default_tax_rate_bps, owner_reminder_email_enabled FROM businesses WHERE id = ? LIMIT 1"
  ).bind(business.id).first();

  return json({ settings: row ?? null });
}

export async function updateSettings(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) return json({ error: "Origin not allowed." }, { status: 403 });

  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;
  if (business.role !== "owner" && business.role !== "admin") {
    return json({ error: "You do not have permission to edit business settings." }, { status: 403 });
  }

  const body = await readJson<{
    name?: unknown;
    businessEmail?: unknown;
    businessPhone?: unknown;
    businessAddress?: unknown;
    abn?: unknown;
    googleReviewUrl?: unknown;
    gstRegistered?: unknown;
    ownerReminderEmailEnabled?: unknown;
  }>(request);
  if (!body) return json({ error: "JSON body required." }, { status: 400 });

  const current = await env.DB.prepare(
    "SELECT name, business_email, business_phone, business_address, abn, google_review_url, gst_registered, owner_reminder_email_enabled FROM businesses WHERE id = ? LIMIT 1"
  ).bind(business.id).first<{
    name: string;
    business_email: string | null;
    business_phone: string | null;
    business_address: string | null;
    abn: string | null;
    google_review_url: string | null;
    gst_registered: number;
    owner_reminder_email_enabled: number;
  }>();
  if (!current) return json({ error: "Business not found." }, { status: 404 });

  const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : current.name;
  if (name.length < 2) return json({ error: "Business name is too short." }, { status: 400 });

  let businessEmail = "businessEmail" in body ? textValue(body.businessEmail, 254) : current.business_email;
  if (businessEmail) {
    businessEmail = normaliseEmail(businessEmail);
    if (!validEmail(businessEmail)) return json({ error: "Business email is invalid." }, { status: 400 });
  }

  const businessPhone = "businessPhone" in body ? textValue(body.businessPhone, 60) : current.business_phone;
  const businessAddress = "businessAddress" in body ? textValue(body.businessAddress, 1000) : current.business_address;
  const abn = "abn" in body ? textValue(body.abn, 30) : current.abn;
  const googleReviewUrl = "googleReviewUrl" in body ? textValue(body.googleReviewUrl, 1000) : current.google_review_url;
  const gstRegistered = "gstRegistered" in body ? Boolean(body.gstRegistered) : Boolean(current.gst_registered);

  if (!validOptionalUrl(googleReviewUrl)) {
    return json({ error: "Google review link must be a valid web address." }, { status: 400 });
  }

  const reminderEmails = "ownerReminderEmailEnabled" in body
    ? body.ownerReminderEmailEnabled === true
    : Boolean(current.owner_reminder_email_enabled);
  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE businesses SET name = ?, business_email = ?, business_phone = ?, business_address = ?, abn = ?, google_review_url = ?, gst_registered = ?, owner_reminder_email_enabled = ?, updated_at = ? WHERE id = ?"
  ).bind(name, businessEmail, businessPhone, businessAddress, abn, googleReviewUrl, gstRegistered ? 1 : 0, reminderEmails ? 1 : 0, now, business.id).run();

  return json({
    settings: {
      name,
      business_email: businessEmail,
      business_phone: businessPhone,
      business_address: businessAddress,
      abn,
      google_review_url: googleReviewUrl,
      gst_registered: gstRegistered ? 1 : 0,
      owner_reminder_email_enabled: reminderEmails ? 1 : 0
    }
  });
}
