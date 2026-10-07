const params = new URLSearchParams(location.search);
const type = params.get("type");
const id = params.get("id");
const $ = (selector) => document.querySelector(selector);

const money = (value) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format((Number(value) || 0) / 100);
const dateText = (value) => {
  if (!value) return "—";
  const date = new Date(value.length <= 10 ? value + "T00:00:00" : value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric" }).format(date);
};

function setText(selector, value) {
  $(selector).textContent = value || "";
}

async function load() {
  if (!id || !["invoice", "quote"].includes(type)) throw new Error("Invalid document link.");

  const response = await fetch("/api/" + (type === "invoice" ? "invoices" : "quotes") + "/" + encodeURIComponent(id), {
    headers: { accept: "application/json" },
    credentials: "same-origin"
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Unable to load document.");

  const doc = type === "invoice" ? data.invoice : data.quote;
  const items = data.items || [];

  document.title = (type === "invoice" ? "Invoice " : "Quote ") + doc.number;
  setText("#business-name", doc.business_name || "ClientStream");
  setText("#doc-kind", type === "invoice" ? "Invoice" : "Quote");
  setText("#doc-number", doc.number);
  setText("#client-name", doc.client_name);
  setText("#client-company", doc.client_company);
  setText("#client-address", doc.client_address);
  setText("#client-email", doc.client_email);
  setText("#doc-status", String(doc.status || "").replace(/_/g, " "));
  setText("#date-label", type === "invoice" ? "Issued" : "Issued");
  setText("#doc-date", dateText(doc.issued_at || doc.created_at));
  setText("#secondary-date-label", type === "invoice" ? "Due" : "Expires");
  setText("#secondary-date", dateText(type === "invoice" ? doc.due_at : doc.expires_at));

  $("#items-body").replaceChildren(...items.map((item) => {
    const row = document.createElement("tr");
    const values = [
      item.description,
      String(item.quantity),
      money(item.unit_price_cents),
      money(Math.round(item.quantity * item.unit_price_cents))
    ];
    values.forEach((value) => {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    });
    return row;
  }));

  setText("#subtotal", money(doc.subtotal_cents));
  setText("#tax", money(doc.tax_cents));
  setText("#total", money(doc.total_cents));

  if (type === "invoice" && Number(doc.amount_paid_cents) > 0) {
    $("#paid-row").classList.remove("hidden");
    $("#balance-row").classList.remove("hidden");
    setText("#paid", money(doc.amount_paid_cents));
    setText("#balance", money(Math.max(0, doc.total_cents - doc.amount_paid_cents)));
  }

  if (doc.notes) {
    $("#notes-section").classList.remove("hidden");
    setText("#notes", doc.notes);
  }
}

$("#print-button").addEventListener("click", () => window.print());
$("#close-button").addEventListener("click", () => window.close());

load().catch((error) => {
  $("#document").classList.add("hidden");
  $("#error").classList.remove("hidden");
  $("#error").textContent = error.message;
});
