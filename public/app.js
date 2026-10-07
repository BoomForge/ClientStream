const state = {
  me: null,
  clients: [],
  jobs: [],
  quotes: [],
  invoices: [],
  expenses: [],
  dashboard: null
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function money(value) {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format((Number(value) || 0) / 100);
}

function dateText(value) {
  if (!value) return "—";
  const date = new Date(value.length <= 10 ? value + "T00:00:00" : value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric" }).format(date);
}

let toastTimer;
function toast(message, error = false) {
  const node = $("#toast");
  node.textContent = message;
  node.className = "toast show" + (error ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.className = "toast"; }, 3600);
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  headers.set("accept", "application/json");

  const response = await fetch(path, { ...options, headers, credentials: "same-origin" });
  let data = {};
  try { data = await response.json(); } catch {}

  if (!response.ok) {
    const error = new Error(data.error || "Request failed.");
    error.status = response.status;
    error.code = data.code;
    throw error;
  }
  return data;
}

function showAuth() {
  $("#auth-view").classList.remove("hidden");
  $("#app-view").classList.add("hidden");
}

async function showApp() {
  $("#auth-view").classList.add("hidden");
  $("#app-view").classList.remove("hidden");
  $("#business-label").textContent = (state.me.business?.name || "CLIENTSTREAM").toUpperCase();
  $("#account-name").textContent = state.me.user.displayName || "Account";
  $("#account-email").textContent = state.me.user.email;
  $("#plan-chip").textContent = (state.me.business?.plan || "free") + " plan";
  await refreshAll();
}

async function boot() {
  try {
    state.me = await api("/api/me");
    await showApp();
  } catch (error) {
    if (error.status !== 401) toast(error.message, true);
    showAuth();
  }
}

function switchAuth(tab) {
  const login = tab === "login";
  $("#login-form").classList.toggle("hidden", !login);
  $("#register-form").classList.toggle("hidden", login);
  $$("[data-auth-tab]").forEach((button) => button.classList.toggle("active", button.dataset.authTab === tab));
}

$$("[data-auth-tab]").forEach((button) => button.addEventListener("click", () => switchAuth(button.dataset.authTab)));

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: form.get("email"), password: form.get("password") })
    });
    state.me = await api("/api/me");
    event.currentTarget.reset();
    await showApp();
  } catch (error) {
    toast(error.message, true);
  }
});

$("#register-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    await api("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        displayName: form.get("displayName"),
        businessName: form.get("businessName"),
        email: form.get("email"),
        password: form.get("password")
      })
    });
    state.me = await api("/api/me");
    event.currentTarget.reset();
    await showApp();
    toast("Your ClientStream account is ready.");
  } catch (error) {
    toast(error.message, true);
  }
});

$("#signout-button").addEventListener("click", async () => {
  try { await api("/api/auth/logout", { method: "POST" }); } catch {}
  state.me = null;
  showAuth();
});

function setView(name) {
  $$(".view").forEach((view) => view.classList.toggle("active", view.dataset.page === name));
  $$(".nav-item[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
  const titles = { dashboard: "Overview", clients: "Clients", jobs: "Jobs", quotes: "Quotes", invoices: "Invoices", expenses: "Expenses" };
  $("#view-title").textContent = titles[name] || "ClientStream";
}

$$(".nav-item[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));

function td(text, className = "") {
  const cell = document.createElement("td");
  cell.textContent = text ?? "—";
  if (className) cell.className = className;
  return cell;
}

function button(label, handler, danger = false) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = "row-button" + (danger ? " danger-text" : "");
  node.textContent = label;
  node.addEventListener("click", handler);
  return node;
}

function statusBadge(status) {
  const span = document.createElement("span");
  span.className = "status " + String(status).replace(/\s+/g, "_");
  span.textContent = String(status).replace(/_/g, " ");
  return span;
}

async function refreshAll() {
  await Promise.all([loadDashboard(), loadClients(), loadJobs(), loadQuotes(), loadInvoices(), loadExpenses()]);
}

async function loadDashboard() {
  try {
    state.dashboard = await api("/api/dashboard");
    renderDashboard();
  } catch (error) {
    toast(error.message, true);
  }
}

function renderDashboard() {
  const metrics = state.dashboard?.metrics || {};
  const definitions = [
    ["Active clients", metrics.clients || 0],
    ["Open jobs", metrics.openJobs || 0],
    ["Outstanding", money(metrics.outstandingCents)],
    ["Expenses", money(metrics.expenseCents)]
  ];

  const grid = $("#metric-grid");
  grid.replaceChildren(...definitions.map(([label, value]) => {
    const card = document.createElement("article");
    card.className = "metric";
    const name = document.createElement("span");
    name.textContent = label;
    const strong = document.createElement("strong");
    strong.textContent = String(value);
    card.append(name, strong);
    return card;
  }));

  const recent = $("#recent-invoices");
  const invoices = state.dashboard?.recentInvoices || [];
  if (!invoices.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No invoices yet.";
    recent.replaceChildren(empty);
    return;
  }

  recent.replaceChildren(...invoices.map((invoice) => {
    const row = document.createElement("div");
    row.className = "invoice-list-item";
    const number = document.createElement("strong");
    number.textContent = invoice.number;
    const client = document.createElement("span");
    client.textContent = invoice.client_name;
    const total = document.createElement("strong");
    total.textContent = money(invoice.total_cents);
    row.append(number, client, total, statusBadge(invoice.status));
    return row;
  }));
}

async function loadClients() {
  try {
    const data = await api("/api/clients");
    state.clients = data.clients || [];
    renderClients();
    fillClientSelects();
  } catch (error) {
    toast(error.message, true);
  }
}

function fillClientSelects() {
  const selects = [$("#job-form select[name='clientId']"), $("#quote-form select[name='clientId']"), $("#invoice-form select[name='clientId']")];
  selects.forEach((select, index) => {
    const first = index === 0 ? [["", "No client"]] : [["", "Select a client"]];
    select.replaceChildren(...[...first, ...state.clients.map((client) => [client.id, client.name])].map(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      return option;
    }));
  });
}

function renderClients() {
  const body = $("#clients-body");
  $("#clients-empty").classList.toggle("hidden", state.clients.length > 0);

  body.replaceChildren(...state.clients.map((client) => {
    const row = document.createElement("tr");
    row.append(
      td(client.name),
      td(client.company),
      td(client.email),
      td(client.phone)
    );

    const actions = document.createElement("td");
    actions.className = "row-actions";
    actions.append(
      button("Edit", () => openClientDialog(client)),
      button("Archive", async () => {
        if (!confirm("Archive " + client.name + "?")) return;
        try {
          await api("/api/clients/" + encodeURIComponent(client.id), { method: "DELETE" });
          await Promise.all([loadClients(), loadDashboard()]);
          toast("Client archived.");
        } catch (error) { toast(error.message, true); }
      }, true)
    );
    row.append(actions);
    return row;
  }));
}

function openClientDialog(client = null) {
  const form = $("#client-form");
  form.reset();
  form.elements.id.value = client?.id || "";
  form.elements.name.value = client?.name || "";
  form.elements.company.value = client?.company || "";
  form.elements.email.value = client?.email || "";
  form.elements.phone.value = client?.phone || "";
  form.elements.address.value = client?.address || "";
  form.elements.notes.value = client?.notes || "";
  $("#client-dialog-title").textContent = client ? "Edit client" : "Add client";
  $("#client-dialog").showModal();
}

$("#add-client").addEventListener("click", () => openClientDialog());
$("#client-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const id = form.get("id");
  const payload = {
    name: form.get("name"),
    company: form.get("company"),
    email: form.get("email"),
    phone: form.get("phone"),
    address: form.get("address"),
    notes: form.get("notes")
  };

  try {
    await api(id ? "/api/clients/" + encodeURIComponent(id) : "/api/clients", {
      method: id ? "PATCH" : "POST",
      body: JSON.stringify(payload)
    });
    $("#client-dialog").close();
    await Promise.all([loadClients(), loadDashboard()]);
    toast(id ? "Client updated." : "Client added.");
  } catch (error) { toast(error.message, true); }
});

async function loadJobs() {
  try {
    const data = await api("/api/jobs");
    state.jobs = data.jobs || [];
    renderJobs();
  } catch (error) { toast(error.message, true); }
}

function renderJobs() {
  const body = $("#jobs-body");
  $("#jobs-empty").classList.toggle("hidden", state.jobs.length > 0);

  body.replaceChildren(...state.jobs.map((job) => {
    const row = document.createElement("tr");
    row.append(td(job.title), td(job.client_name), td(dateText(job.scheduled_for)));

    const statusCell = document.createElement("td");
    const select = document.createElement("select");
    select.className = "inline-select";
    ["planned", "active", "completed"].forEach((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value[0].toUpperCase() + value.slice(1);
      option.selected = job.status === value;
      select.append(option);
    });
    select.addEventListener("change", async () => {
      try {
        await api("/api/jobs/" + encodeURIComponent(job.id), {
          method: "PATCH",
          body: JSON.stringify({ status: select.value })
        });
        await Promise.all([loadJobs(), loadDashboard()]);
        toast("Job updated.");
      } catch (error) {
        select.value = job.status;
        toast(error.message, true);
      }
    });
    statusCell.append(select);
    row.append(statusCell);

    const actions = document.createElement("td");
    actions.className = "row-actions";
    actions.append(button("Cancel", async () => {
      if (!confirm("Cancel this job?")) return;
      try {
        await api("/api/jobs/" + encodeURIComponent(job.id), { method: "DELETE" });
        await Promise.all([loadJobs(), loadDashboard()]);
        toast("Job cancelled.");
      } catch (error) { toast(error.message, true); }
    }, true));
    row.append(actions);
    return row;
  }));
}

$("#add-job").addEventListener("click", () => {
  $("#job-form").reset();
  fillClientSelects();
  $("#job-dialog").showModal();
});

$("#job-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    await api("/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        title: form.get("title"),
        clientId: form.get("clientId"),
        scheduledFor: form.get("scheduledFor"),
        description: form.get("description")
      })
    });
    $("#job-dialog").close();
    await Promise.all([loadJobs(), loadDashboard()]);
    toast("Job added.");
  } catch (error) { toast(error.message, true); }
});


async function loadQuotes() {
  try {
    const data = await api("/api/quotes");
    state.quotes = data.quotes || [];
    renderQuotes();
  } catch (error) { toast(error.message, true); }
}

function renderQuotes() {
  const body = $("#quotes-body");
  $("#quotes-empty").classList.toggle("hidden", state.quotes.length > 0);

  body.replaceChildren(...state.quotes.map((quote) => {
    const row = document.createElement("tr");
    row.append(td(quote.number), td(quote.client_name), td(money(quote.total_cents)));

    const statusCell = document.createElement("td");
    statusCell.append(statusBadge(quote.status));
    row.append(statusCell);

    const actions = document.createElement("td");
    actions.className = "row-actions";

    actions.append(button("Print", () => {
      window.open("/print.html?type=quote&id=" + encodeURIComponent(quote.id), "_blank", "noopener");
    }));

    if (quote.status === "draft") {
      actions.append(button("Mark sent", async () => {
        try {
          await api("/api/quotes/" + encodeURIComponent(quote.id), {
            method: "PATCH",
            body: JSON.stringify({ status: "sent" })
          });
          await loadQuotes();
          toast("Quote marked sent.");
        } catch (error) { toast(error.message, true); }
      }));
    }

    if (quote.status !== "declined" && quote.status !== "expired") {
      actions.append(button("To invoice", async () => {
        try {
          await api("/api/quotes/" + encodeURIComponent(quote.id) + "/convert", { method: "POST" });
          await Promise.all([loadQuotes(), loadInvoices(), loadDashboard()]);
          toast("Quote converted to invoice.");
          setView("invoices");
        } catch (error) { toast(error.message, true); }
      }));
    }

    row.append(actions);
    return row;
  }));
}

$("#add-quote").addEventListener("click", () => {
  if (!state.clients.length) {
    toast("Add a client before creating a quote.", true);
    setView("clients");
    return;
  }
  $("#quote-form").reset();
  $("#quote-form input[name='quantity']").value = "1";
  $("#quote-form input[name='tax']").value = "0";
  fillClientSelects();
  $("#quote-dialog").showModal();
});

$("#quote-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const unitPrice = Number(form.get("unitPrice"));
  const tax = Number(form.get("tax") || 0);
  const quantity = Number(form.get("quantity"));

  try {
    await api("/api/quotes", {
      method: "POST",
      body: JSON.stringify({
        clientId: form.get("clientId"),
        expiresAt: form.get("expiresAt"),
        notes: form.get("notes"),
        taxCents: Math.round(tax * 100),
        items: [{
          description: form.get("description"),
          quantity,
          unitPriceCents: Math.round(unitPrice * 100)
        }]
      })
    });
    $("#quote-dialog").close();
    await loadQuotes();
    toast("Quote created.");
  } catch (error) { toast(error.message, true); }
});

async function loadInvoices() {
  try {
    const data = await api("/api/invoices");
    state.invoices = data.invoices || [];
    renderInvoices();
  } catch (error) { toast(error.message, true); }
}

function renderInvoices() {
  const body = $("#invoices-body");
  $("#invoices-empty").classList.toggle("hidden", state.invoices.length > 0);

  body.replaceChildren(...state.invoices.map((invoice) => {
    const outstanding = Math.max(0, invoice.total_cents - invoice.amount_paid_cents);
    const row = document.createElement("tr");
    row.append(td(invoice.number), td(invoice.client_name), td(money(invoice.total_cents)), td(money(outstanding)));

    const statusCell = document.createElement("td");
    statusCell.append(statusBadge(invoice.status));
    row.append(statusCell);

    const actions = document.createElement("td");
    actions.className = "row-actions";

    actions.append(button("Print", () => {
      window.open("/print.html?type=invoice&id=" + encodeURIComponent(invoice.id), "_blank", "noopener");
    }));

    if (invoice.status === "draft") {
      actions.append(button("Mark sent", async () => {
        try {
          await api("/api/invoices/" + encodeURIComponent(invoice.id), {
            method: "PATCH",
            body: JSON.stringify({ status: "sent" })
          });
          await Promise.all([loadInvoices(), loadDashboard()]);
          toast("Invoice marked sent.");
        } catch (error) { toast(error.message, true); }
      }));
    }

    if (outstanding > 0 && invoice.status !== "void") {
      actions.append(button("Payment", () => openPaymentDialog(invoice)));
    }

    if (invoice.status !== "paid" && invoice.status !== "void" && invoice.amount_paid_cents === 0) {
      actions.append(button("Void", async () => {
        if (!confirm("Void " + invoice.number + "?")) return;
        try {
          await api("/api/invoices/" + encodeURIComponent(invoice.id), {
            method: "PATCH",
            body: JSON.stringify({ status: "void" })
          });
          await Promise.all([loadInvoices(), loadDashboard()]);
          toast("Invoice voided.");
        } catch (error) { toast(error.message, true); }
      }, true));
    }

    row.append(actions);
    return row;
  }));
}

$("#add-invoice").addEventListener("click", () => {
  if (!state.clients.length) {
    toast("Add a client before creating an invoice.", true);
    setView("clients");
    return;
  }
  $("#invoice-form").reset();
  $("#invoice-form input[name='quantity']").value = "1";
  $("#invoice-form input[name='tax']").value = "0";
  fillClientSelects();
  $("#invoice-dialog").showModal();
});

$("#invoice-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const unitPrice = Number(form.get("unitPrice"));
  const tax = Number(form.get("tax") || 0);
  const quantity = Number(form.get("quantity"));

  try {
    await api("/api/invoices", {
      method: "POST",
      body: JSON.stringify({
        clientId: form.get("clientId"),
        dueAt: form.get("dueAt"),
        notes: form.get("notes"),
        taxCents: Math.round(tax * 100),
        items: [{
          description: form.get("description"),
          quantity,
          unitPriceCents: Math.round(unitPrice * 100)
        }]
      })
    });
    $("#invoice-dialog").close();
    await Promise.all([loadInvoices(), loadDashboard()]);
    toast("Invoice created.");
  } catch (error) { toast(error.message, true); }
});

function openPaymentDialog(invoice) {
  const outstanding = Math.max(0, invoice.total_cents - invoice.amount_paid_cents);
  const form = $("#payment-form");
  form.reset();
  form.elements.invoiceId.value = invoice.id;
  form.elements.amount.value = (outstanding / 100).toFixed(2);
  form.elements.amount.max = (outstanding / 100).toFixed(2);
  $("#payment-balance").textContent = invoice.number + " · outstanding " + money(outstanding);
  $("#payment-dialog").showModal();
}

$("#payment-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const id = form.get("invoiceId");
  try {
    await api("/api/invoices/" + encodeURIComponent(id) + "/payments", {
      method: "POST",
      body: JSON.stringify({ amountCents: Math.round(Number(form.get("amount")) * 100) })
    });
    $("#payment-dialog").close();
    await Promise.all([loadInvoices(), loadDashboard()]);
    toast("Payment recorded.");
  } catch (error) { toast(error.message, true); }
});

async function loadExpenses() {
  try {
    const data = await api("/api/expenses");
    state.expenses = data.expenses || [];
    renderExpenses();
  } catch (error) { toast(error.message, true); }
}

function renderExpenses() {
  const body = $("#expenses-body");
  $("#expenses-empty").classList.toggle("hidden", state.expenses.length > 0);
  body.replaceChildren(...state.expenses.map((expense) => {
    const row = document.createElement("tr");
    row.append(td(expense.description), td(expense.category), td(dateText(expense.incurred_at)), td(money(expense.amount_cents)));
    const actions = document.createElement("td");
    actions.className = "row-actions";
    actions.append(button("Delete", async () => {
      if (!confirm("Delete this expense?")) return;
      try {
        await api("/api/expenses/" + encodeURIComponent(expense.id), { method: "DELETE" });
        await Promise.all([loadExpenses(), loadDashboard()]);
        toast("Expense deleted.");
      } catch (error) { toast(error.message, true); }
    }, true));
    row.append(actions);
    return row;
  }));
}

$("#add-expense").addEventListener("click", () => {
  $("#expense-form").reset();
  $("#expense-form input[name='incurredAt']").value = new Date().toISOString().slice(0, 10);
  $("#expense-dialog").showModal();
});

$("#expense-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    await api("/api/expenses", {
      method: "POST",
      body: JSON.stringify({
        description: form.get("description"),
        category: form.get("category"),
        amountCents: Math.round(Number(form.get("amount")) * 100),
        incurredAt: form.get("incurredAt"),
        notes: form.get("notes")
      })
    });
    $("#expense-dialog").close();
    await Promise.all([loadExpenses(), loadDashboard()]);
    toast("Expense added.");
  } catch (error) { toast(error.message, true); }
});

$$(".close-dialog").forEach((button) => {
  button.addEventListener("click", () => button.closest("dialog").close());
});

$$("dialog").forEach((dialog) => {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
});

boot();
