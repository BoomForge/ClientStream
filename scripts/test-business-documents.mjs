import { randomUUID } from "node:crypto";

const base = process.env.CLIENTSTREAM_TEST_URL || "http://127.0.0.1:8794";
const email = "brand-test-" + randomUUID() + "@example.invalid";
const password = "Brand-" + randomUUID() + "-Aa1!";
let cookie = "";
let registered = false;
async function call(path, method = "GET", body, expected = 200) {
  const headers = { accept: "application/json" };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(base + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const session = response.headers.get("set-cookie");
  if (session) cookie = session.split(";")[0];
  const data = await response.json().catch(() => ({}));
  if (response.status !== expected) {
    throw Error(method + " " + path + " expected " + expected + " got " + response.status + ": " + JSON.stringify(data));
  }
  return data;
}
const assert = (ok, why) => { if (!ok) throw Error(why); };
const logo = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==";

try {
  await call("/api/auth/register", "POST", {
    email, password, displayName: "Owner", businessName: "Brand " + randomUUID()
  }, 201);
  registered = true;
  await call("/api/settings", "PATCH", { bankBsb: "12-3", bankAccountName: "Example", bankAccountNumber: "123456" }, 400);
  await call("/api/settings", "PATCH", { logoDataUrl: "data:image/svg+xml;base64,PHN2Zz4=" }, 400);
  const profile = {
    name: "Branded Company",
    contactName: "Taylor Example",
    businessEmail: "contact@example.test",
    businessPhone: "03 6123 4567",
    businessAddress: "10 Business Lane\nHobart TAS 7000",
    websiteUrl: "https://example.test",
    bankAccountName: "Branded Company Pty Ltd",
    bankBsb: "123-456",
    bankAccountNumber: "98765432",
    paymentInstructions: "Reference: invoice number\nPayID: payments@example.test",
    logoDataUrl: logo
  };
  await call("/api/settings", "PATCH", profile);
  const settings = (await call("/api/settings")).settings;
  assert(settings.logo_data_url === logo, "Business logo failed to persist");
  assert(settings.bank_bsb === "123456", "BSB normalization failed");
  assert(settings.contact_name === "Taylor Example", "Contact person missing");
  const client = (await call("/api/clients", "POST", { name: "Specific Client" }, 201)).client;
  const job = (await call("/api/jobs", "POST", {
    clientId: client.id, title: "Original title", description: "Draft work"
  }, 201)).job;
  await call("/api/jobs/" + job.id, "PATCH", {
    title: "Updated customer job",
    description: "Details now edited",
    scheduledFor: "2026-11-07T11:30",
    clientId: client.id
  });
  const jobs = (await call("/api/jobs")).jobs;
  assert(jobs.some((x) => x.id === job.id && x.title === "Updated customer job" &&
    x.description === "Details now edited" && x.scheduled_for === "2026-11-07T11:30"),
    "Job edits did not persist");

  const item = [{ description: "Client-specific service", quantity: 1, unitPriceCents: 9900 }];
  const quote = (await call("/api/quotes", "POST", { clientId: client.id, items: item }, 201)).quote;
  const quoted = (await call("/api/quotes/" + quote.id)).quote;
  assert(quoted.business_name === profile.name, "Branded quote name missing");
  assert(quoted.business_logo_data_url === logo, "Branded quote logo missing");
  assert(quoted.business_contact_name === profile.contactName, "Quote contact missing");
  const invoice = (await call("/api/invoices", "POST", { clientId: client.id, items: item }, 201)).invoice;
  const billed = (await call("/api/invoices/" + invoice.id)).invoice;
  assert(billed.bank_bsb === "123456" && billed.bank_account_number === "98765432",
    "Invoice transfer instructions missing");
  assert(billed.payment_instructions.includes("PayID"), "Invoice alternative payment instructions missing");
  await call("/api/settings", "PATCH", { logoDataUrl: null });
  assert((await call("/api/settings")).settings.logo_data_url === null, "Logo removal failed");
  console.log("Business documents passed: customer job editing, logo, business identity, BSB and invoice payment details.");
} finally {
  if (registered) {
    try { await call("/api/account/delete", "POST", { password, confirmation: "DELETE" }); }
    catch (error) { console.error("Business setup test cleanup failed:", error.message); process.exitCode = 1; }
  }
}
