import { readFileSync } from "node:fs";

const base = (process.env.CLIENTSTREAM_SMOKE_URL || "https://clientstream.theevansorrell.workers.dev").replace(/\/$/, "");
const password = "SmokeTest-" + crypto.randomUUID() + "-Aa1!";
const email = "smoke-" + Date.now() + "-" + crypto.randomUUID().slice(0, 8) + "@example.invalid";
let cookie = "";

async function call(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("accept", "application/json");
  if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);

  const response = await fetch(base + path, { ...options, headers, redirect: "manual" });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];

  let body = null;
  const type = response.headers.get("content-type") || "";
  if (type.includes("application/json")) body = await response.json();
  else body = await response.text();

  if (!response.ok) {
    throw new Error(options.method + " " + path + " -> " + response.status + " " + JSON.stringify(body));
  }
  return body;
}

async function cleanup() {
  if (!cookie) {
    try {
      await call("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
    } catch (error) {
      console.error("Smoke cleanup could not restore login:", error.message);
    }
  }
  if (!cookie) return;
  try {
    await call("/api/account/delete", {
      method: "POST",
      body: JSON.stringify({ password, confirmation: "DELETE" })
    });
  } catch (error) {
    console.error("Smoke cleanup failed:", error.message);
  }
}

try {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const expectedVersion = source.match(/const VERSION = "([^"]+)"/)?.[1];
  if (!expectedVersion) throw new Error("Unable to determine expected ClientStream version.");

  let health = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      health = await call("/api/health", { method: "GET" });
      if (health.status === "ok" && health.database === "bound" && health.version === expectedVersion) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (!health || health.version !== expectedVersion) {
    throw new Error("Deployed Worker did not reach expected version " + expectedVersion + ".");
  }

  await call("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      email,
      password,
      displayName: "Smoke Test",
      businessName: "ClientStream Smoke " + Date.now()
    })
  });

  await call("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
  const me = await call("/api/me", { method: "GET" });
  if (!me.business?.id) throw new Error("Business onboarding failed.");

  const clientResult = await call("/api/clients", {
    method: "POST",
    body: JSON.stringify({
      name: "Smoke Customer",
      company: "Smoke Co",
      email: "customer@example.invalid",
      phone: "0400000000"
    })
  });
  const clientId = clientResult.client?.id;
  if (!clientId) throw new Error("Client creation failed.");

  const quoteResult = await call("/api/quotes", {
    method: "POST",
    body: JSON.stringify({
      clientId,
      taxMode: "gst10",
      notes: "Automated smoke test",
      items: [
        { description: "Service A", quantity: 1, unitPriceCents: 10000 },
        { description: "Service B", quantity: 2, unitPriceCents: 2500 }
      ]
    })
  });
  const quoteId = quoteResult.quote?.id;
  if (!quoteId || quoteResult.quote?.total_cents !== 16500) throw new Error("Quote totals failed.");

  const converted = await call("/api/quotes/" + encodeURIComponent(quoteId) + "/convert", { method: "POST" });
  const invoiceId = converted.invoice?.id;
  if (!invoiceId) throw new Error("Quote conversion failed.");

  const invoice = await call("/api/invoices/" + encodeURIComponent(invoiceId), { method: "GET" });
  if (invoice.invoice?.total_cents !== 16500 || (invoice.items || []).length !== 2) {
    throw new Error("Invoice conversion totals/items failed.");
  }

  const payment = await call("/api/invoices/" + encodeURIComponent(invoiceId) + "/payments", {
    method: "POST",
    body: JSON.stringify({ amountCents: 16500 })
  });
  if (payment.invoice?.status !== "paid") throw new Error("Payment completion failed.");

  const exportResponse = await fetch(base + "/api/account/export", {
    headers: { accept: "application/json", cookie }
  });
  if (!exportResponse.ok) throw new Error("Account export failed.");
  const exported = await exportResponse.json();
  if (!Array.isArray(exported.clients) || exported.clients.length !== 1) throw new Error("Export content failed.");

  await call("/api/account/delete", {
    method: "POST",
    body: JSON.stringify({ password, confirmation: "DELETE" })
  });
  cookie = "";

  console.log("ClientStream production smoke test passed.");
} catch (error) {
  console.error("ClientStream production smoke test failed:", error);
  await cleanup();
  process.exit(1);
}
