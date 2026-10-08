// Runs against a disposable local D1 database, never production.
import { randomUUID } from "node:crypto";

const base = process.env.CLIENTSTREAM_TEST_URL || "http://127.0.0.1:8794";
const owners = [];
function assert(condition, message) { if (!condition) throw Error(message); }
async function request(owner, path, method = "GET", data, expected = 200) {
  const headers = { accept: "application/json" };
  if (data !== undefined) headers["content-type"] = "application/json";
  if (owner.cookie) headers.cookie = owner.cookie;
  const response = await fetch(base + path, { method, headers, body: data === undefined ? undefined : JSON.stringify(data) });
  const session = response.headers.get("set-cookie");
  if (session) owner.cookie = session.split(";")[0];
  const body = await response.json().catch(() => ({}));
  assert(response.status === expected, method + " " + path + ": expected " + expected + ", got " + response.status + " (" + JSON.stringify(body) + ")");
  return body;
}
async function owner(label) {
  const result = { email: "isolated-" + label + "-" + randomUUID() + "@example.invalid", password: "Isolation-" + randomUUID() + "-Aa1!", cookie: "" };
  owners.push(result);
  const created = await request(result, "/api/auth/register", "POST", {
    email: result.email, password: result.password, displayName: "Isolation " + label, businessName: "Isolation Business " + label
  }, 201);
  assert(created.business?.id, "Business creation failed");
  return result;
}
async function denied(owner, path, method = "GET", data) {
  const headers = { accept: "application/json", ...(owner.cookie ? { cookie: owner.cookie } : {}) };
  if (data !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(base + path, { method, headers, body: data === undefined ? undefined : JSON.stringify(data) });
  assert(res.status === 403 || res.status === 404 || res.status === 400,
    method + " " + path + " exposed another business record: HTTP " + res.status);
}
try {
  const a = await owner("a");
  const b = await owner("b");
  const client = (await request(a, "/api/clients", "POST", { name: "SECRET_A_CUSTOMER", email: "a@example.invalid" }, 201)).client;
  const job = (await request(a, "/api/jobs", "POST", { clientId: client.id, title: "SECRET_A_JOB" }, 201)).job;
  const quote = (await request(a, "/api/quotes", "POST", {
    clientId: client.id, taxMode: "none", items: [{ description: "SECRET_A_QUOTE", quantity: 1, unitPriceCents: 1000 }]
  }, 201)).quote;
  const invoice = (await request(a, "/api/invoices", "POST", {
    clientId: client.id, taxMode: "none", items: [{ description: "SECRET_A_INVOICE", quantity: 1, unitPriceCents: 1000 }]
  }, 201)).invoice;
  const expense = (await request(a, "/api/expenses", "POST", {
    description: "SECRET_A_EXPENSE", amountCents: 500, incurredAt: new Date().toISOString()
  }, 201)).expense;
  const reminder = (await request(a, "/api/reminders", "POST", {
    title: "SECRET_A_REMINDER", scheduledFor: new Date(Date.now() + 86400000).toISOString(), clientId: client.id
  }, 201)).reminder;

  await denied(b, "/api/clients/" + client.id, "PATCH", { name: "Changed" });
  await denied(b, "/api/clients/" + client.id, "DELETE");
  await denied(b, "/api/jobs/" + job.id, "PATCH", { title: "Changed" });
  await denied(b, "/api/jobs/" + job.id, "DELETE");
  await denied(b, "/api/quotes/" + quote.id);
  await denied(b, "/api/quotes/" + quote.id, "PATCH", { notes: "Changed" });
  await denied(b, "/api/quotes/" + quote.id + "/convert", "POST");
  await denied(b, "/api/invoices/" + invoice.id);
  await denied(b, "/api/invoices/" + invoice.id, "PATCH", { notes: "Changed" });
  await denied(b, "/api/invoices/" + invoice.id + "/payments", "POST", { amountCents: 200 });
  await denied(b, "/api/expenses/" + expense.id, "DELETE");
  await denied(b, "/api/reminders/" + reminder.id + "/complete", "POST");
  await denied(b, "/api/reminders/" + reminder.id, "DELETE");

  const lists = await Promise.all(["clients", "jobs", "quotes", "invoices", "expenses", "today"].map((name) =>
    request(b, "/api/" + name)));
  const exported = await request(b, "/api/account/export");
  for (const data of [...lists, exported]) {
    assert(!JSON.stringify(data).includes("SECRET_A_"), "Cross-tenant information leaked in listing/export.");
  }
  console.log("Two-business isolation passed: cross-tenant read, write and export denied.");
} finally {
  for (const item of owners) {
    if (!item.cookie) continue;
    try {
      await request(item, "/api/account/delete", "POST", { password: item.password, confirmation: "DELETE" });
    } catch (error) { console.error("Test account cleanup failed:", error.message); process.exitCode = 1; }
  }
}
