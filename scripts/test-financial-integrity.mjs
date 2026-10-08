import { randomUUID } from "node:crypto";

const base = process.env.CLIENTSTREAM_TEST_URL || "http://127.0.0.1:8794";
const email = "finance-test-" + randomUUID() + "@example.invalid";
const password = "Finance-" + randomUUID() + "-Aa1!";
let cookie = "";
async function api(path, method = "GET", body, status = 200) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const value = await response.json().catch(() => ({}));
  if (response.status !== status) throw Error(method + " " + path + ": expected " + status + ", got " + response.status + " " + JSON.stringify(value));
  return value;
}
const check = (ok, message) => { if (!ok) throw Error(message); };
const items = [{ description: "Service", quantity: 1.5, unitPriceCents: 10000 }, { description: "No-charge support", quantity: 1, unitPriceCents: 0 }];
try {
  await api("/api/auth/register", "POST", { email, password, displayName: "Finance Tester", businessName: "Finance Test " + randomUUID() }, 201);
  const client = (await api("/api/clients", "POST", { name: "Test Customer" }, 201)).client;
  // A non-GST-registered business cannot issue invoices with GST.
  await api("/api/invoices", "POST", { clientId: client.id, taxMode: "gst10", items }, 400);
  await api("/api/quotes", "POST", { clientId: client.id, taxMode: "gst10", items }, 400);
  await api("/api/settings", "PATCH", { gstRegistered: true });
  const quote = (await api("/api/quotes", "POST", { clientId: client.id, taxMode: "gst10", items }, 201)).quote;
  check(quote.subtotal_cents === 15000 && quote.tax_cents === 1500 && quote.total_cents === 16500, "Decimal/zero-price GST totals failed");
  await api("/api/quotes/" + quote.id, "PATCH", { status: "sent" });
  await api("/api/quotes/" + quote.id, "PATCH", { status: "draft" }, 409);
  await api("/api/quotes/" + quote.id, "PATCH", { items }, 409);
  const invoice = (await api("/api/invoices", "POST", { clientId: client.id, taxMode: "gst10", items }, 201)).invoice;
  check(invoice.total_cents === 16500, "Invoice totals failed");
  await api("/api/invoices/" + invoice.id, "PATCH", { status: "sent" });
  await api("/api/invoices/" + invoice.id, "PATCH", { status: "draft" }, 409);
  await api("/api/invoices/" + invoice.id, "PATCH", { clientId: client.id }, 409);
  const payment1 = await api("/api/invoices/" + invoice.id + "/payments", "POST", { amountCents: 5000 }, 201);
  check(payment1.invoice.amount_paid_cents === 5000 && payment1.invoice.status === "part_paid", "Partial payment state failed");
  await api("/api/invoices/" + invoice.id, "PATCH", { status: "void" }, 409);
  await api("/api/invoices/" + invoice.id, "PATCH", { status: "draft" }, 409);
  const payment2 = await api("/api/invoices/" + invoice.id + "/payments", "POST", { amountCents: 11500 }, 201);
  check(payment2.invoice.status === "paid" && !!payment2.invoice.paid_at, "Final payment timestamp/status failed");
  await api("/api/invoices/" + invoice.id, "PATCH", { status: "sent" }, 409);
  await api("/api/invoices/" + invoice.id + "/payments", "POST", { amountCents: 100 }, 400);
  console.log("Financial state regression passed: GST, decimal quantities, immutable issued docs and payments.");
} finally {
  if (cookie) {
    try { await api("/api/account/delete", "POST", { password, confirmation: "DELETE" }); }
    catch (error) { console.error("Finance test cleanup failed:", error.message); process.exitCode = 1; }
  }
}
