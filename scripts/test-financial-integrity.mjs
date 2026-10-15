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
  const draftResults = (await api("/api/income/available-invoices")).invoices;
  check(draftResults.some((x) => x.id === invoice.id && x.status === "draft"),
    "Newly created draft invoices must be discoverable with visible draft status");
  await api("/api/invoices/" + invoice.id + "/payments", "POST",
    { amountCents: 500, partialPayment: true }, 409);
  check(invoice.total_cents === 16500, "Invoice totals failed");
  await api("/api/invoices/" + invoice.id, "PATCH", { status: "sent" });
  let available = (await api("/api/income/available-invoices")).invoices;
  check(available.some((x) => x.id === invoice.id && x.outstanding_cents === 16500),
    "Issued outstanding invoice missing from income search");
  available = (await api("/api/income/available-invoices?q=" + encodeURIComponent(invoice.number))).invoices;
  check(available.some((x) => x.id === invoice.id), "Search by invoice number must find matching outstanding invoice");
  available = (await api("/api/income/available-invoices?q=Test%20Customer")).invoices;
  check(available.some((x) => x.id === invoice.id), "Search by client name must find matching invoice");
  check(!(await api("/api/income/available-invoices?q=nonmatchinginvoice")).invoices.some((x) => x.id === invoice.id),
    "Search should exclude unrelated invoices");

  await api("/api/invoices/" + invoice.id, "PATCH", { status: "draft" }, 409);
  await api("/api/invoices/" + invoice.id, "PATCH", { clientId: client.id }, 409);
  // Add Income uses partialPayment=true, preserving the remaining invoice.
  await api("/api/invoices/" + invoice.id + "/payments", "POST",
    { amountCents: 5000, partialPayment: false }, 400);
  await api("/api/invoices/" + invoice.id + "/payments", "POST",
    { amountCents: 16500, partialPayment: true }, 400);
  const payment1 = await api("/api/invoices/" + invoice.id + "/payments", "POST",
    { amountCents: 5000, partialPayment: true, notes: "First instalment" }, 201);
  check(payment1.invoice.amount_paid_cents === 5000 && payment1.invoice.status === "part_paid", "Partial payment state failed");
  available = (await api("/api/income/available-invoices")).invoices;
  check(available.some((x) => x.id === invoice.id && x.outstanding_cents === 11500),
    "Part-paid invoice should stay in the searchable list with its remaining balance");
  await api("/api/invoices/" + invoice.id, "PATCH", { status: "void" }, 409);
  await api("/api/invoices/" + invoice.id, "PATCH", { status: "draft" }, 409);
  const payment2 = await api("/api/invoices/" + invoice.id + "/payments", "POST", { amountCents: 11500, partialPayment: false }, 201);
  check(payment2.invoice.status === "paid" && !!payment2.invoice.paid_at, "Final payment timestamp/status failed");
  check(!(await api("/api/income/available-invoices")).invoices.some((x) => x.id === invoice.id),
    "Fully paid invoice must leave searchable income allocation results");
  await api("/api/invoices/" + invoice.id, "PATCH", { status: "sent" }, 409);
  await api("/api/invoices/" + invoice.id + "/payments", "POST", { amountCents: 100 }, 400);

  const today = new Date().toISOString().slice(0,10);
  // Recorded income is cash received, NOT the total of unpaid invoices.
  const ledger = await api("/api/income");
  check(ledger.income.filter((x) => x.invoice_id === invoice.id).length === 2, "Two invoice payments must appear in Income");
  const other = (await api("/api/income", "POST", {
    description: "Cash sale outside invoices", amountCents: 2750, receivedAt: today, notes: "Direct cash"
  }, 201)).income;
  await api("/api/income", "POST", {
    invoiceId: invoice.id, description: "Should be refused", amountCents: 300, receivedAt: today
  }, 400);
  check((await api("/api/income")).income.some((x) => x.id === other.id), "Standalone income was not listed");
  await api("/api/income/" + other.id, "PATCH", { amountCents: 3000, description: "Corrected cash sale" });
  const exp = (await api("/api/expenses", "POST", {
    description: "Office supplies", amountCents: 3000, incurredAt: today, category: "Operations"
  }, 201)).expense;
  await api("/api/expenses/" + exp.id, "PATCH", {
    description: "Updated supplies", amountCents: 4000, notes: "Correction"
  });
  await api("/api/expenses/" + exp.id, "PATCH", { amountCents: 0 }, 400);
  const expenses = await api("/api/expenses");
  check(expenses.expenses.some((x) => x.id === exp.id && x.amount_cents === 4000 && x.description === "Updated supplies"),
    "Expense edits not persisted");
  const dateRange = "?from=" + today + "&to=" + today;
  const report = (await api("/api/reports/summary" + dateRange)).summary;
  check(report.invoicesIssuedCents === 16500, "Period invoiced total incorrect");
  check(report.invoiceIncomeCents === 16500, "Cash received from invoice should equal recorded payments");
  check(report.otherIncomeCents === 3000, "Standalone cash income missing from report");
  check(report.incomeCents === 19500 && report.expenseCents === 4000 && report.netCents === 15500,
    "Actual income minus expenses is incorrect");
  check(report.outstandingCents === 0, "Paid invoices must not remain outstanding");
  const dashboard = (await api("/api/dashboard")).metrics;
  check(dashboard.incomeCents === 19500, "Dashboard income should sum completed real cash receipts");
  await api("/api/income/" + other.id, "DELETE");
  check((await api("/api/dashboard")).metrics.incomeCents === 16500, "Removing standalone receipt did not recalculate dashboard");
  await api("/api/expenses/" + exp.id, "DELETE");
  console.log("Financial state regression passed: income, invoice payments, editable expenses, cashflow, outstanding, GST and immutable issued documents.");
} finally {
  if (cookie) {
    try { await api("/api/account/delete", "POST", { password, confirmation: "DELETE" }); }
    catch (error) { console.error("Finance test cleanup failed:", error.message); process.exitCode = 1; }
  }
}
