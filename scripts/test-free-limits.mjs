import { randomUUID } from "node:crypto";
const base = process.env.CLIENTSTREAM_TEST_URL || "http://127.0.0.1:8794";
const email = "free-boundary-" + randomUUID() + "@example.invalid";
const password = "Boundary-" + randomUUID() + "-Aa1!";
let cookie = "";
async function call(path, method = "GET", data, expected = 200) {
  const headers = { accept: "application/json" };
  if (cookie) headers.cookie = cookie;
  if (data !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(base + path, { method, headers, body: data === undefined ? undefined : JSON.stringify(data) });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const body = await res.json().catch(() => ({}));
  if (res.status !== expected) throw Error(method + " " + path + " expected " + expected + ", received " + res.status + " " + JSON.stringify(body));
  return body;
}
try {
  await call("/api/auth/register", "POST", {
    email, password, displayName: "Free Limit Tester", businessName: "Free Limits " + randomUUID()
  }, 201);
  let firstClient;
  for (let i = 1; i <= 10; i++) {
    const created = await call("/api/clients", "POST", { name: "Boundary Customer " + i }, 201);
    firstClient ||= created.client.id;
  }
  const blockedClient = await call("/api/clients", "POST", { name: "Should not exist" }, 402);
  if (blockedClient.code !== "PLAN_LIMIT") throw Error("Free client boundary lacks PLAN_LIMIT.");
  const invoiceDetails = {
    clientId: firstClient, taxMode: "none", items: [{ description: "Boundary service", quantity: 1, unitPriceCents: 100 }]
  };
  for (let i = 1; i <= 10; i++) {
    await call("/api/invoices", "POST", invoiceDetails, 201);
  }
  const blockedInvoice = await call("/api/invoices", "POST", invoiceDetails, 402);
  if (blockedInvoice.code !== "PLAN_LIMIT") throw Error("Free invoice boundary lacks PLAN_LIMIT.");
  console.log("Free plan 10-client / 10-invoice limits passed.");
} finally {
  if (cookie) {
    try { await call("/api/account/delete", "POST", { password, confirmation: "DELETE" }); }
    catch (error) { console.error("Free test cleanup failed:", error.message); process.exitCode = 1; }
  }
}
