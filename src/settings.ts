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


function validBrandLogo(value: string | null): boolean {
  if (!value) return true;
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length > 145_000) return false;
  try {
    const bytes = atob(match[2]);
    if (bytes.length > 100_000 || bytes.length < 24) return false;
    if (match[1] === "png") {
      return bytes.charCodeAt(0) === 137 && bytes.slice(1, 4) === "PNG" &&
        bytes.charCodeAt(4) === 13 && bytes.charCodeAt(5) === 10;
    }
    return bytes.charCodeAt(0) === 255 && bytes.charCodeAt(1) === 216 &&
      bytes.charCodeAt(bytes.length - 2) === 255 && bytes.charCodeAt(bytes.length - 1) === 217;
  } catch { return false; }
}

export async function getSettings(request: Request, env: Env): Promise<Response> {
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;

  const row = await env.DB.prepare(
    "SELECT name, business_email, business_phone, business_address, abn, google_review_url, contact_name, website_url, logo_data_url, bank_account_name, bank_bsb, bank_account_number, payment_instructions, timezone, currency, gst_registered, default_tax_rate_bps, owner_reminder_email_enabled FROM businesses WHERE id = ? LIMIT 1"
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
    contactName?: unknown;
    websiteUrl?: unknown;
    logoDataUrl?: unknown;
    bankAccountName?: unknown;
    bankBsb?: unknown;
    bankAccountNumber?: unknown;
    paymentInstructions?: unknown;
  }>(request);
  if (!body) return json({ error: "JSON body required." }, { status: 400 });

  const current = await env.DB.prepare(
    "SELECT name, business_email, business_phone, business_address, abn, google_review_url, contact_name, website_url, logo_data_url, bank_account_name, bank_bsb, bank_account_number, payment_instructions, gst_registered, owner_reminder_email_enabled FROM businesses WHERE id = ? LIMIT 1"
  ).bind(business.id).first<{
    name: string;
    business_email: string | null;
    business_phone: string | null;
    business_address: string | null;
    abn: string | null;
    google_review_url: string | null;
    gst_registered: number;
    owner_reminder_email_enabled: number;
    contact_name: string | null;
    website_url: string | null;
    logo_data_url: string | null;
    bank_account_name: string | null;
    bank_bsb: string | null;
    bank_account_number: string | null;
    payment_instructions: string | null;
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
  const contactName = "contactName" in body ? textValue(body.contactName, 120) : current.contact_name;
  const websiteUrl = "websiteUrl" in body ? textValue(body.websiteUrl, 1000) : current.website_url;
  const logoDataUrl = "logoDataUrl" in body ?
    (typeof body.logoDataUrl === "string" ? body.logoDataUrl : null) : current.logo_data_url;
  const bankAccountName = "bankAccountName" in body ? textValue(body.bankAccountName, 120) : current.bank_account_name;
  const bankBsbRaw = "bankBsb" in body ? textValue(body.bankBsb, 12) : current.bank_bsb;
  const bankBsb = bankBsbRaw?.replace(/[ -]/g, "") || null;
  const bankAccountNumber = "bankAccountNumber" in body ? textValue(body.bankAccountNumber, 20) : current.bank_account_number;
  const paymentInstructions = "paymentInstructions" in body ? textValue(body.paymentInstructions, 1200) : current.payment_instructions;
  if (!validOptionalUrl(websiteUrl)) return json({ error: "Website must be a valid web address." }, { status: 400 });
  if (!validBrandLogo(logoDataUrl)) return json({ error: "Upload a PNG or JPEG logo smaller than 100 KB." }, { status: 400 });
  if (bankBsb && !/^\\d{6}$/.test(bankBsb)) return json({ error: "Australian BSB must contain six digits." }, { status: 400 });
  if (bankAccountNumber && !/^\\d{4,12}$/.test(bankAccountNumber.replace(/[ -]/g, ""))) {
    return json({ error: "Bank account number must contain 4–12 digits." }, { status: 400 });
  }
  if ((bankBsb || bankAccountNumber || bankAccountName) && !(bankBsb && bankAccountNumber && bankAccountName)) {
    return json({ error: "Complete the account name, BSB and account number together, or leave all blank." }, { status: 400 });
  }


  if (!validOptionalUrl(googleReviewUrl)) {
    return json({ error: "Google review link must be a valid web address." }, { status: 400 });
  }

  const reminderEmails = "ownerReminderEmailEnabled" in body
    ? body.ownerReminderEmailEnabled === true
    : Boolean(current.owner_reminder_email_enabled);
  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE businesses SET name = ?, business_email = ?, business_phone = ?, business_address = ?, abn = ?, google_review_url = ?, gst_registered = ?, owner_reminder_email_enabled = ?, contact_name = ?, website_url = ?, logo_data_url = ?, bank_account_name = ?, bank_bsb = ?, bank_account_number = ?, payment_instructions = ?, updated_at = ? WHERE id = ?"
  ).bind(name, businessEmail, businessPhone, businessAddress, abn, googleReviewUrl, gstRegistered ? 1 : 0, reminderEmails ? 1 : 0, contactName, websiteUrl, logoDataUrl, bankAccountName, bankBsb, bankAccountNumber?.replace(/[ -]/g, "") || null, paymentInstructions, now, business.id).run();

  return json({
    settings: {
      name,
      business_email: businessEmail,
      business_phone: businessPhone,
      business_address: businessAddress,
      abn,
      google_review_url: googleReviewUrl,
      gst_registered: gstRegistered ? 1 : 0,
      owner_reminder_email_enabled: reminderEmails ? 1 : 0,
      contact_name: contactName,
      website_url: websiteUrl,
      logo_data_url: logoDataUrl,
      bank_account_name: bankAccountName,
      bank_bsb: bankBsb,
      bank_account_number: bankAccountNumber?.replace(/[ -]/g, "") || null,
      payment_instructions: paymentInstructions
    }
  });
}
