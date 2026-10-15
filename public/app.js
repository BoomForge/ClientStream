const state = {
  me: null,
  clients: [],
  jobs: [],
  quotes: [],
  invoices: [],
  expenses: [],
  income: [],
  dashboard: null,
  billing: null,
  today: null,
  report: null,
  settings: null,
  smartUsage: null
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

function renderVerification() {
  const show = Boolean(state.me?.emailConfigured && !state.me?.user?.emailVerified);
  $("#verification-banner").classList.toggle("hidden", !show);
  if (show) $("#verification-email").textContent = state.me.user.email;
}

async function showApp() {
  $("#auth-view").classList.add("hidden");
  $("#app-view").classList.remove("hidden");
  $("#business-label").textContent = (state.me.business?.name || "CLIENTSTREAM").toUpperCase();
  $("#account-name").textContent = state.me.user.displayName || "Account";
  $("#account-email").textContent = state.me.user.email;
  $("#plan-chip").textContent = (state.me.business?.plan || "free") + " plan";
  syncSidebarUpgrade();
  renderVerification();
  await refreshAll();
  await handleBillingReturn();
}

function cleanAuthQuery(parameter) {
  const url = new URL(location.href);
  url.searchParams.delete(parameter);
  history.replaceState({}, "", url.pathname + url.search + url.hash);
}

async function handleAuthLinkBeforeBoot() {
  const url = new URL(location.href);
  const resetToken = url.searchParams.get("reset");
  const verifyToken = url.searchParams.get("verify");

  if (resetToken) {
    showAuth();
    $("#reset-form").elements.token.value = resetToken;
    $("#reset-dialog").showModal();
    return true;
  }

  if (verifyToken) {
    try {
      await api("/api/auth/verify-email", {
        method: "POST",
        body: JSON.stringify({ token: verifyToken })
      });
      cleanAuthQuery("verify");
      toast("Email verified.");
    } catch (error) {
      cleanAuthQuery("verify");
      toast(error.message, true);
    }
  }

  return false;
}

async function boot() {
  if (await handleAuthLinkBeforeBoot()) return;

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
  // currentTarget is reset to null by the browser after dispatch; capture it before awaiting.
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  try {
    await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: form.get("email"), password: form.get("password") })
    });
    state.me = await api("/api/me");
    formElement.reset();
    await showApp();
  } catch (error) {
    toast(error.message, true);
  }
});

$("#register-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  // currentTarget is reset to null by the browser after dispatch; capture it before awaiting.
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
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
    formElement.reset();
    await showApp();
    toast("Your ClientStream account is ready.");
  } catch (error) {
    toast(error.message, true);
  }
});

$("#forgot-password-button").addEventListener("click", () => {
  const email = $("#login-form").elements.email.value;
  $("#forgot-form").reset();
  if (email) $("#forgot-form").elements.email.value = email;
  $("#forgot-dialog").showModal();
});

$("#forgot-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    const result = await api("/api/auth/request-reset", {
      method: "POST",
      body: JSON.stringify({ email: form.get("email") })
    });
    $("#forgot-dialog").close();
    toast(result.message || "If the account exists, a reset link has been sent.");
  } catch (error) {
    toast(error.message, true);
  }
});

$("#reset-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const password = String(form.get("password") || "");
  const confirmPassword = String(form.get("confirmPassword") || "");
  if (password !== confirmPassword) {
    toast("The passwords do not match.", true);
    return;
  }

  try {
    await api("/api/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token: form.get("token"), password })
    });
    cleanAuthQuery("reset");
    $("#reset-dialog").close();
    state.me = await api("/api/me");
    await showApp();
    toast("Password updated.");
  } catch (error) {
    toast(error.message, true);
  }
});

$("#send-verification-button").addEventListener("click", async () => {
  try {
    const result = await api("/api/auth/send-verification", { method: "POST" });
    toast(result.sent ? "Verification email sent." : "A verification email was already sent recently.");
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
  const titles = { dashboard: "Today", clients: "Clients", jobs: "Jobs", quotes: "Quotes", invoices: "Invoices", expenses: "Expenses", reports: "Reports", smart: "Smart Write", settings: "Settings" };
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

async function refreshIdentity() {
  state.me = await api("/api/me");
  $("#business-label").textContent = (state.me.business?.name || "CLIENTSTREAM").toUpperCase();
  $("#account-name").textContent = state.me.user.displayName || "Account";
  $("#account-email").textContent = state.me.user.email;
  $("#plan-chip").textContent = (state.me.business?.plan || "free") + " plan";
  syncSidebarUpgrade();
  renderVerification();
}

async function refreshAll() {
  await Promise.all([
    loadDashboard(),
    loadBilling(),
    loadClients(),
    loadJobs(),
    loadQuotes(),
    loadInvoices(),
    loadExpenses(),
    loadIncome(),
    loadToday(),
    loadSettings(),
    loadSmartUsage(),
    loadReport()
  ]);
}

async function loadBilling() {
  try {
    state.billing = await api("/api/billing/status");
    renderBilling();
  } catch (error) {
    toast(error.message, true);
  }
}

function syncSidebarUpgrade() {
  const isPro = (state.billing?.businessPlan || state.me?.business?.plan) === "pro";
  $("#sidebar-upgrade").classList.toggle("hidden", isPro);
}

function renderBilling() {
  const billing = state.billing || {};
  const isPro = billing.businessPlan === "pro";
  const configured = Boolean(billing.configured);
  const subscription = billing.subscription;
  syncSidebarUpgrade();

  $("#billing-plan").textContent = isPro ? "Pro plan" : "Free plan";
  if (billing.environment === "sandbox") {
    $("#billing-copy").textContent = "PayPal Sandbox mode. No real charges will be made.";
  }

  $("#upgrade-button").classList.toggle("hidden", isPro);
  $("#cancel-billing").classList.toggle("hidden", !isPro || subscription?.cancelAtPeriodEnd);
  $("#reconcile-billing").classList.add("hidden");

  if (!configured && !isPro) {
    $("#upgrade-button").disabled = true;
    $("#upgrade-button").textContent = "PayPal setup pending";
    $("#billing-copy").textContent = "Your Free plan is active. Pro checkout will appear when PayPal subscriptions and verified webhooks are configured.";
    return;
  }

  $("#upgrade-button").disabled = false;
  $("#upgrade-button").textContent = "Upgrade to Pro";
  $("#reconcile-billing").classList.toggle("hidden",
    !(subscription && ["pending", "past_due"].includes(subscription.status)));


  if (isPro) {
    const end = subscription?.currentPeriodEnd ? " Next scheduled renewal: " + dateText(subscription.currentPeriodEnd) + "." : "";
    const cancelling = "";
    $("#billing-copy").textContent = "Unlimited clients and invoices, plus Pro features." + end + cancelling;
  } else {
    $("#billing-copy").textContent = "Up to 10 active clients and 10 invoices. Pro is A$9.99/month with unlimited clients and invoices.";
  }
}

async function handleBillingReturn() {
  const url = new URL(location.href);
  if (url.searchParams.get("billing") === "cancelled") {
    url.searchParams.delete("billing");
    history.replaceState({}, "", url.pathname + url.search + url.hash);
    toast("PayPal subscription approval was cancelled.");
    return;
  }
  if (url.searchParams.get("billing") !== "success") return;

  url.searchParams.delete("billing");
  history.replaceState({}, "", url.pathname + url.search + url.hash);

  $("#reconcile-billing").classList.remove("hidden");
  toast("PayPal approval received. Verifying your subscription…");

  try {
    const result = await api("/api/billing/reconcile", { method: "POST" });
    if (result.active) {
      await refreshIdentity();
      await Promise.all([loadBilling(), loadQuotes(), loadInvoices()]);
      $("#reconcile-billing").classList.add("hidden");
      toast("ClientStream Pro is active.");
    } else {
      toast("PayPal is still activating your subscription. Use Check payment shortly.");
    }
  } catch (error) {
    toast(error.message, true);
  }
}

let upgradePending = false;
async function startPayPalUpgrade() {
  if (upgradePending) return;
  if ((state.billing?.businessPlan || state.me?.business?.plan) === "pro") return;
  if (!state.billing?.configured) {
    setView("dashboard");
    $("#billing-panel").scrollIntoView({ behavior: "smooth", block: "center" });
    toast("PayPal subscriptions are not configured yet. The Free plan remains available.", true);
    return;
  }
  upgradePending = true;
  const upgrade = $("#upgrade-button");
  const sidebarUpgrade = $("#sidebar-upgrade");
  upgrade.disabled = true;
  sidebarUpgrade.disabled = true;
  upgrade.textContent = "Opening PayPal…";
  sidebarUpgrade.firstChild.textContent = "Opening… ";
  try {
    const result = await api("/api/billing/checkout", { method: "POST" });
    if (!result?.checkoutUrl) throw new Error("PayPal did not return a checkout link.");
    location.href = result.checkoutUrl;
  } catch (error) {
    toast(error.message, true);
  } finally {
    upgradePending = false;
    upgrade.disabled = false;
    upgrade.textContent = "Upgrade to Pro";
    sidebarUpgrade.firstChild.textContent = "Upgrade ";
    sidebarUpgrade.disabled = false;
    renderBilling();
  }
}
$("#upgrade-button").addEventListener("click", startPayPalUpgrade);
$("#sidebar-upgrade").addEventListener("click", startPayPalUpgrade);

$("#reconcile-billing").addEventListener("click", async () => {
  try {
    const result = await api("/api/billing/reconcile", { method: "POST" });
    if (!result.active) {
      toast("No active ClientStream Pro subscription is confirmed by PayPal yet.");
      return;
    }
    await refreshIdentity();
    await Promise.all([loadBilling(), loadQuotes(), loadInvoices()]);
    $("#reconcile-billing").classList.add("hidden");
    toast("ClientStream Pro is active.");
  } catch (error) {
    toast(error.message, true);
  }
});

$("#cancel-billing").addEventListener("click", async () => {
  if (!confirm("Cancel ClientStream Pro now? Pro features will be disabled when PayPal confirms cancellation. This stops future renewals.")) return;
  try {
    await api("/api/billing/cancel", { method: "POST" });
    await loadBilling();
    toast("PayPal cancellation confirmed. Future renewals have stopped.");
  } catch (error) {
    toast(error.message, true);
  }
});


function localDateTimeInput(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

async function loadToday() {
  try {
    state.today = await api("/api/today");
    renderToday();
  } catch (error) {
    toast(error.message, true);
  }
}

function makeTodayItem(icon, title, detail, due, actions = []) {
  const row = document.createElement("div");
  row.className = "today-item" + (due ? " due" : "");

  const iconNode = document.createElement("div");
  iconNode.className = "today-icon";
  iconNode.textContent = icon;

  const copy = document.createElement("div");
  copy.className = "today-copy";
  const strong = document.createElement("strong");
  strong.textContent = title;
  const span = document.createElement("span");
  span.textContent = detail;
  copy.append(strong, span);

  const actionBox = document.createElement("div");
  actionBox.className = "today-actions";
  actions.forEach((action) => actionBox.append(action));

  row.append(iconNode, copy, actionBox);
  return row;
}

function renderToday() {
  const list = $("#today-list");
  const nodes = [];
  const data = state.today || {};

  (data.reminders || []).forEach((reminder) => {
    const title = reminder.payload?.title || "Reminder";
    const client = reminder.client_name ? " · " + reminder.client_name : "";
    const detail = dateText(reminder.scheduled_for) + client + (reminder.payload?.note ? " · " + reminder.payload.note : "");
    const done = button("Done", async () => {
      try {
        await api("/api/reminders/" + encodeURIComponent(reminder.id) + "/complete", { method: "POST" });
        await loadToday();
        toast("Reminder completed.");
      } catch (error) { toast(error.message, true); }
    });
    const cancel = button("Cancel", async () => {
      try {
        await api("/api/reminders/" + encodeURIComponent(reminder.id), { method: "DELETE" });
        await loadToday();
      } catch (error) { toast(error.message, true); }
    }, true);
    nodes.push(makeTodayItem("✓", title, detail, reminder.due, [done, cancel]));
  });

  (data.overdueInvoices || []).forEach((invoice) => {
    const outstanding = Math.max(0, invoice.total_cents - invoice.amount_paid_cents);
    nodes.push(makeTodayItem(
      "$",
      "Overdue · " + invoice.number,
      invoice.client_name + " · " + money(outstanding) + " outstanding · due " + dateText(invoice.due_at),
      true,
      [button("Invoices", () => setView("invoices"))]
    ));
  });

  (data.upcomingJobs || []).forEach((job) => {
    nodes.push(makeTodayItem(
      "J",
      job.title,
      (job.client_name ? job.client_name + " · " : "") + dateText(job.scheduled_for),
      false,
      [button("Jobs", () => setView("jobs"))]
    ));
  });

  if (!nodes.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Nothing needs attention right now.";
    nodes.push(empty);
  }

  list.replaceChildren(...nodes);
}

$("#add-reminder").addEventListener("click", () => {
  const form = $("#reminder-form");
  form.reset();
  fillClientSelects();
  form.elements.scheduledFor.value = localDateTimeInput(new Date(Date.now() + 60 * 60 * 1000));
  $("#reminder-dialog").showModal();
});

$("#reminder-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const date = new Date(String(form.get("scheduledFor") || ""));
  if (Number.isNaN(date.getTime())) {
    toast("Choose a valid reminder time.", true);
    return;
  }

  try {
    await api("/api/reminders", {
      method: "POST",
      body: JSON.stringify({
        title: form.get("title"),
        kind: form.get("kind"),
        clientId: form.get("clientId"),
        scheduledFor: date.toISOString(),
        note: form.get("note")
      })
    });
    $("#reminder-dialog").close();
    await loadToday();
    toast("Reminder added.");
  } catch (error) {
    toast(error.message, true);
  }
});

function defaultFinancialYear() {
  const now = new Date();
  const year = now.getFullYear();
  const startYear = now.getMonth() >= 6 ? year : year - 1;
  return {
    from: startYear + "-07-01",
    to: (startYear + 1) + "-06-30"
  };
}

function ensureReportDates() {
  const form = $("#report-form");
  if (!form.elements.from.value || !form.elements.to.value) {
    const range = defaultFinancialYear();
    form.elements.from.value = range.from;
    form.elements.to.value = range.to;
  }
}

async function loadReport() {
  ensureReportDates();
  const form = $("#report-form");
  const params = new URLSearchParams({
    from: form.elements.from.value,
    to: form.elements.to.value
  });

  try {
    state.report = await api("/api/reports/summary?" + params.toString());
    renderReport();
  } catch (error) {
    toast(error.message, true);
  }
}

function renderCashFlow() {
  const host = $("#cashflow-chart");
  const data = state.report?.cashFlow || [];
  if (!data.length) { host.replaceChildren(); return; }
  const top = Math.max(1, ...data.flatMap((m) => [m.incomeCents, m.expenseCents]));
  host.replaceChildren(...data.map((month) => {
    const entry = document.createElement("div");
    entry.className = "cashflow-month";
    const bars = document.createElement("div");
    bars.className = "cashflow-month-bars";
    for (const [key, label] of [["incomeCents", "Income"], ["expenseCents", "Expenses"]]) {
      const bar = document.createElement("div");
      bar.className = "cashflow-bar " + (key === "incomeCents" ? "income" : "expense");
      bar.style.height = Math.max(2, Math.round(month[key] / top * 100)) + "%";
      bar.title = month.month + " · " + label + ": " + money(month[key]);
      bars.append(bar);
    }
    const monthLabel = document.createElement("span");
    monthLabel.textContent = month.month.slice(2);
    entry.append(bars, monthLabel);
    host.append(entry);
  }));
  host.setAttribute("aria-label", "Monthly cash flow: " + data.map((m) =>
    m.month + " income " + money(m.incomeCents) + " expenses " + money(m.expenseCents)).join("; "));
}

function renderReport() {
  const summary = state.report?.summary || {};
  const definitions = [
    ["Invoiced in period", money(summary.invoicesIssuedCents)],
    ["Received from invoices", money(summary.invoiceIncomeCents)],
    ["Other income", money(summary.otherIncomeCents)],
    ["Total income received", money(summary.incomeCents)],
    ["Expenses paid", money(summary.expenseCents)],
    ["Net cash flow", money(summary.netCents)],
    ["Outstanding now", money(summary.outstandingCents)]
  ];

  $("#report-metrics").replaceChildren(...definitions.map(([label, value]) => {
    const card = document.createElement("article");
    card.className = "metric";
    const span = document.createElement("span");
    span.textContent = label;
    const strong = document.createElement("strong");
    strong.textContent = value;
    card.append(span, strong);
    return card;
  }));

  renderCashFlow();
  const pro = state.me?.business?.plan === "pro";
  $("#export-report").disabled = !pro;
  $("#export-report").textContent = pro ? "Export CSV" : "CSV export · Pro";
  $("#report-note").textContent =
    "Range " + state.report.range.from + " to " + state.report.range.to +
    " · " + (summary.invoiceCount || 0) + " invoices · " +
    (summary.paymentCount || 0) + " actual receipts · " + (summary.expenseCount || 0) + " expenses. Outstanding now is the current unpaid balance on issued invoices, independent of the report date range.";
}

$("#report-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await loadReport();
});

$("#export-report").addEventListener("click", () => {
  if (state.me?.business?.plan !== "pro") {
    toast("EOFY CSV export is available on ClientStream Pro.", true);
    return;
  }
  const form = $("#report-form");
  const params = new URLSearchParams({ from: form.elements.from.value, to: form.elements.to.value });
  location.href = "/api/reports/export.csv?" + params.toString();
});

async function loadSmartUsage() {
  try {
    state.smartUsage = await api("/api/smart-write/usage");
    renderSmartUsage();
  } catch (error) {
    toast(error.message, true);
  }
}

function renderSmartUsage() {
  const usage = state.smartUsage;
  if (!usage) return;
  $("#smart-usage").textContent = usage.used + " / " + usage.limit + " this month";
}

$("#smart-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const submit = event.currentTarget.querySelector("button[type='submit']");
  submit.disabled = true;
  submit.textContent = "Writing…";

  try {
    const result = await api("/api/smart-write", {
      method: "POST",
      body: JSON.stringify({
        kind: form.get("kind"),
        clientName: form.get("clientName"),
        roughNotes: form.get("roughNotes")
      })
    });
    $("#smart-result").value = result.message;
    $("#copy-smart").disabled = false;
    $("#smart-mode").textContent = result.usedAI
      ? "Written with Cloudflare Workers AI."
      : "Written with ClientStream's offline-safe template fallback.";
    state.smartUsage = result.usage;
    renderSmartUsage();
  } catch (error) {
    toast(error.message, true);
  } finally {
    submit.disabled = false;
    submit.textContent = "Write message";
  }
});

$("#copy-smart").addEventListener("click", async () => {
  const value = $("#smart-result").value;
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    toast("Message copied.");
  } catch {
    $("#smart-result").select();
    document.execCommand("copy");
    toast("Message copied.");
  }
});

async function loadSettings() {
  try {
    const data = await api("/api/settings");
    state.settings = data.settings || {};
    const form = $("#settings-form");
    form.elements.name.value = state.settings.name || "";
    form.elements.abn.value = state.settings.abn || "";
    form.elements.businessEmail.value = state.settings.business_email || "";
    form.elements.businessPhone.value = state.settings.business_phone || "";
    form.elements.businessAddress.value = state.settings.business_address || "";
    form.elements.contactName.value = state.settings.contact_name || "";
    form.elements.websiteUrl.value = state.settings.website_url || "";
    form.elements.bankAccountName.value = state.settings.bank_account_name || "";
    form.elements.bankBsb.value = state.settings.bank_bsb || "";
    form.elements.bankAccountNumber.value = state.settings.bank_account_number || "";
    form.elements.paymentInstructions.value = state.settings.payment_instructions || "";
    pendingLogoData = undefined;
    updateLogoPreview(state.settings.logo_data_url);
    form.elements.googleReviewUrl.value = state.settings.google_review_url || "";
    form.elements.gstRegistered.checked = Boolean(state.settings.gst_registered);
    $("#owner-reminder-email-enabled").checked = Boolean(state.settings.owner_reminder_email_enabled);
  } catch (error) {
    toast(error.message, true);
  }
}

$("#change-password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const currentPassword = String(data.get("currentPassword") || "");
  const newPassword = String(data.get("newPassword") || "");
  if (newPassword !== String(data.get("confirmPassword") || "")) {
    toast("The new passwords do not match.", true);
    return;
  }
  try {
    await api("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword })
    });
    form.reset();
    toast("Password changed. Other sessions have been signed out.");
  } catch (error) {
    toast(error.message || "Unable to change password.", true);
  }
});


let pendingLogoData;
function updateLogoPreview(source) {
  const preview = $("#logo-preview");
  if (source && /^data:image\/(png|jpeg);base64,/.test(source)) {
    preview.src = source;
    preview.classList.remove("hidden");
  } else {
    preview.removeAttribute("src");
    preview.classList.add("hidden");
  }
}

$("#business-logo-file").addEventListener("change", async (event) => {
  const file = event.currentTarget.files?.[0];
  if (!file) return;
  if (!["image/png", "image/jpeg"].includes(file.type) || file.size > 300_000) {
    event.currentTarget.value = "";
    toast("Choose a PNG or JPEG up to 300 KB.", true);
    return;
  }
  try {
    const encoded = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Unable to read logo"));
      reader.readAsDataURL(file);
    });
    pendingLogoData = encoded;
    updateLogoPreview(encoded);
  } catch (error) {
    toast(error.message, true);
  }
});
$("#remove-business-logo").addEventListener("click", () => {
  pendingLogoData = null;
  $("#business-logo-file").value = "";
  updateLogoPreview(null);
});

$("#settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    const data = await api("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({
        name: form.get("name"),
        abn: form.get("abn"),
        businessEmail: form.get("businessEmail"),
        businessPhone: form.get("businessPhone"),
        businessAddress: form.get("businessAddress"),
        contactName: form.get("contactName"),
        websiteUrl: form.get("websiteUrl"),
        bankAccountName: form.get("bankAccountName"),
        bankBsb: form.get("bankBsb"),
        bankAccountNumber: form.get("bankAccountNumber"),
        paymentInstructions: form.get("paymentInstructions"),
        ...(pendingLogoData !== undefined ? { logoDataUrl: pendingLogoData } : {}),
        googleReviewUrl: form.get("googleReviewUrl"),
        gstRegistered: form.get("gstRegistered"),
        ownerReminderEmailEnabled: $("#owner-reminder-email-enabled").checked
      })
    });
    state.settings = data.settings;
    pendingLogoData = undefined;
    updateLogoPreview(state.settings.logo_data_url);
    $("#business-logo-file").value = "";
    await refreshIdentity();
    toast("Business profile saved.");
  } catch (error) {
    toast(error.message, true);
  }
});

$("#export-account").addEventListener("click", () => {
  location.href = "/api/account/export";
});

$("#delete-account").addEventListener("click", () => {
  $("#delete-account-form").reset();
  $("#delete-account-dialog").showModal();
});

$("#delete-account-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  if (String(form.get("confirmation") || "").trim() !== "DELETE") {
    toast("Type DELETE to confirm permanent deletion.", true);
    return;
  }

  try {
    await api("/api/account/delete", {
      method: "POST",
      body: JSON.stringify({
        password: form.get("password"),
        confirmation: form.get("confirmation")
      })
    });
    $("#delete-account-dialog").close();
    state.me = null;
    showAuth();
    toast("ClientStream business deleted.");
  } catch (error) {
    toast(error.message, true);
  }
});

async function loadDashboard() {
  try {
    state.dashboard = await api("/api/dashboard");
    renderDashboard();
  } catch (error) {
    toast(error.message, true);
  }
}

// Each date comes from a recorded business-local observation. Missing dates are
// not treated as zero, because doing so would invent historical activity.
function renderMetricTrend(points, key, currency, label) {
  const section = document.createElement("div");
  section.className = "metric-trend";
  const heading = document.createElement("div");
  heading.className = "metric-trend-heading";
  const period = document.createElement("span");
  period.textContent = "LAST 7 DAYS";
  const change = document.createElement("span");
  change.className = "metric-trend-change";

  const previous = points.slice(0, -1).filter((row) => Number.isFinite(row?.[key]));
  const latest = points.at(-1);
  if (previous.length && latest && Number.isFinite(latest[key])) {
    const diff = latest[key] - previous.at(-1)[key];
    const formatted = currency ? money(Math.abs(diff)) : String(Math.abs(diff));
    change.textContent = diff === 0 ? "No change" : (diff > 0 ? "+" : "−") + formatted;
    change.title = "Change since last recorded day";
  } else {
    change.textContent = "Tracking from today";
  }
  heading.append(period, change);

  const bars = document.createElement("div");
  bars.className = "metric-bars";
  bars.setAttribute("role", "img");
  bars.setAttribute("aria-label", label + " daily totals: " + points.map((row) => {
    const value = row?.[key];
    return (row?.date || "Unknown") + " " + (Number.isFinite(value)
      ? (currency ? money(value) : String(value)) : "not recorded");
  }).join(", "));

  const observed = points.map((row) => row?.[key]).filter((value) => Number.isFinite(value));
  const maximum = Math.max(1, ...observed);
  for (const [index, point] of points.entries()) {
    const slot = document.createElement("div");
    slot.className = "metric-bar-slot";
    const bar = document.createElement("div");
    const value = point?.[key];
    const recorded = Number.isFinite(value);
    bar.className = "metric-bar" + (index === points.length - 1 ? " current" : "") + (!recorded ? " unrecorded" : "");
    if (recorded) {
      bar.style.height = Math.max(3, Math.round((Math.max(0, value) / maximum) * 100)) + "%";
    }
    slot.title = (point?.date || "Unknown") + ": " + (recorded
      ? currency ? money(value) : String(value)
      : "No recorded data");
    slot.append(bar);
    bars.append(slot);
  }

  const dates = document.createElement("div");
  dates.className = "metric-trend-dates";
  const first = document.createElement("span");
  first.textContent = points[0]?.date ? dateText(points[0].date) : "Start";
  const last = document.createElement("span");
  last.textContent = "Today";
  dates.append(first, last);
  section.append(heading, bars, dates);
  return section;
}

function renderDashboard() {
  const metrics = state.dashboard?.metrics || {};
  const points = state.dashboard?.trend || [];
  const definitions = [
    ["Active clients", metrics.clients || 0, "clients", false],
    ["Open jobs", metrics.openJobs || 0, "openJobs", false],
    ["Outstanding", money(metrics.outstandingCents), "outstandingCents", true],
    ["Income received", money(metrics.incomeCents), "incomeCents", true],
    ["Expenses", money(metrics.expenseCents), "expenseCents", true]
  ];

  const grid = $("#metric-grid");
  grid.replaceChildren(...definitions.map(([label, value, key, currency]) => {
    const card = document.createElement("article");
    card.className = "metric";
    const name = document.createElement("span");
    name.textContent = label;
    const strong = document.createElement("strong");
    strong.textContent = String(value);
    card.append(name, strong);
    if (points.length) card.append(renderMetricTrend(points, key, currency, label));
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
  const selects = [
    $("#job-form select[name='clientId']"),
    $("#quote-form select[name='clientId']"),
    $("#invoice-form select[name='clientId']"),
    $("#reminder-form select[name='clientId']")
  ].filter(Boolean);
  selects.forEach((select, index) => {
    const first = (index === 0 || index === 3) ? [["", "No client"]] : [["", "Select a client"]];
    select.replaceChildren(...[...first, ...state.clients.map((client) => [client.id, client.name])].map(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      return option;
    }));
  });
}

function visibleRecords(section, rows, searchable) {
  const query = ($("#" + section + "-search")?.value || "").trim().toLocaleLowerCase();
  const status = $("#" + section + "-status")?.value || "";
  const sort = $("#" + section + "-sort")?.value || "recent";
  const visible = rows.filter((record) =>
    (!status || record.status === status) &&
    (!query || searchable(record).toLocaleLowerCase().includes(query))
  );
  if (sort === "name") visible.sort((a, b) =>
    searchable(a).localeCompare(searchable(b), "en-AU", { numeric: true })
  );
  return visible;
}

for (const section of ["clients", "jobs", "quotes", "invoices"]) {
  for (const field of ["search", "status", "sort"]) {
    $("#" + section + "-" + field)?.addEventListener(
      field === "search" ? "input" : "change",
      () => ({ clients: renderClients, jobs: renderJobs, quotes: renderQuotes, invoices: renderInvoices })[section]()
    );
  }
}

function renderClients() {
  const body = $("#clients-body");
  const visible = visibleRecords("clients", state.clients, (client) => [client.name, client.company, client.email, client.phone].filter(Boolean).join(" "));
  $("#clients-empty").classList.toggle("hidden", visible.length > 0);

  body.replaceChildren(...visible.map((client) => {
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
  const visible = visibleRecords("jobs", state.jobs, (job) => [job.title, job.client_name, job.status].filter(Boolean).join(" "));
  $("#jobs-empty").classList.toggle("hidden", visible.length > 0);

  body.replaceChildren(...visible.map((job) => {
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
    actions.append(button("Edit", () => openJobDialog(job)));
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

function openJobDialog(job = null) {
  const form = $("#job-form");
  form.reset();
  fillClientSelects();
  form.elements.id.value = job?.id || "";
  form.elements.title.value = job?.title || "";
  form.elements.clientId.value = job?.client_id || "";
  form.elements.scheduledFor.value = job?.scheduled_for ? String(job.scheduled_for).slice(0, 16) : "";
  form.elements.description.value = job?.description || "";
  $("#job-dialog-title").textContent = job ? "Edit job" : "Add job";
  $("#save-job-button").textContent = job ? "Save changes" : "Add job";
  $("#job-dialog").showModal();
}
$("#add-job").addEventListener("click", () => openJobDialog());

$("#job-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const id = String(form.get("id") || "");
  try {
    await api(id ? "/api/jobs/" + encodeURIComponent(id) : "/api/jobs", {
      method: id ? "PATCH" : "POST",
      body: JSON.stringify({
        title: form.get("title"),
        clientId: form.get("clientId"),
        scheduledFor: form.get("scheduledFor"),
        description: form.get("description")
      })
    });
    $("#job-dialog").close();
    await Promise.all([loadJobs(), loadDashboard(), loadToday()]);
    toast(id ? "Job changes saved." : "Job added.");
  } catch (error) { toast(error.message, true); }
});



function canEmailDocuments() {
  return Boolean(
    state.me?.business?.plan === "pro" &&
    state.me?.emailConfigured &&
    state.me?.user?.emailVerified
  );
}

async function emailDocument(type, id) {
  try {
    const result = await api("/api/" + (type === "quote" ? "quotes" : "invoices") + "/" + encodeURIComponent(id) + "/send-email", {
      method: "POST"
    });
    toast((type === "quote" ? "Quote" : "Invoice") + " emailed to " + result.recipient + ".");
    if (type === "quote") await loadQuotes();
    else await Promise.all([loadInvoices(), loadDashboard()]);
  } catch (error) {
    toast(error.message, true);
  }
}

function documentTaxDefault() {
  return state.settings?.gst_registered ? "gst10" : "none";
}

function documentLineRow(item = {}) {
  const row = document.createElement("div");
  row.className = "document-item-row";

  const description = document.createElement("input");
  description.name = "lineDescription";
  description.placeholder = "Description";
  description.maxLength = 500;
  description.required = true;
  description.value = item.description || "";

  const quantity = document.createElement("input");
  quantity.name = "lineQuantity";
  quantity.type = "number";
  quantity.min = "0.01";
  quantity.step = "0.01";
  quantity.required = true;
  quantity.value = String(item.quantity ?? 1);

  const price = document.createElement("input");
  price.name = "linePrice";
  price.type = "number";
  price.min = "0";
  price.step = "0.01";
  price.required = true;
  price.placeholder = "0.00";
  price.value = item.unit_price_cents != null
    ? (Number(item.unit_price_cents) / 100).toFixed(2)
    : (item.unitPriceCents != null ? (Number(item.unitPriceCents) / 100).toFixed(2) : "");

  const remove = button("Remove", () => {
    const container = row.parentElement;
    if (!container) return;
    if (container.children.length <= 1) {
      description.value = "";
      quantity.value = "1";
      price.value = "";
      description.focus();
      return;
    }
    row.remove();
  }, true);

  const descLabel = document.createElement("label");
  descLabel.className = "document-description";
  descLabel.textContent = "Description";
  descLabel.append(description);

  const qtyLabel = document.createElement("label");
  qtyLabel.textContent = "Qty";
  qtyLabel.append(quantity);

  const priceLabel = document.createElement("label");
  priceLabel.textContent = "Unit price";
  priceLabel.append(price);

  const action = document.createElement("div");
  action.className = "document-item-action";
  action.append(remove);

  row.append(descLabel, qtyLabel, priceLabel, action);
  return row;
}

function setDocumentItems(container, items = []) {
  const safeItems = items.length ? items : [{}];
  container.replaceChildren(...safeItems.map((item) => documentLineRow(item)));
}

function collectDocumentItems(container) {
  return [...container.querySelectorAll(".document-item-row")].map((row) => ({
    description: row.querySelector("[name='lineDescription']").value,
    quantity: Number(row.querySelector("[name='lineQuantity']").value),
    unitPriceCents: Math.round(Number(row.querySelector("[name='linePrice']").value) * 100)
  }));
}

function inputDate(value) {
  return value ? String(value).slice(0, 10) : "";
}

async function loadQuotes() {
  try {
    const data = await api("/api/quotes");
    state.quotes = data.quotes || [];
    renderQuotes();
  } catch (error) { toast(error.message, true); }
}

function renderQuotes() {
  const body = $("#quotes-body");
  const visible = visibleRecords("quotes", state.quotes, (quote) => [quote.number, quote.client_name, quote.status].filter(Boolean).join(" "));
  $("#quotes-empty").classList.toggle("hidden", visible.length > 0);

  body.replaceChildren(...visible.map((quote) => {
    const row = document.createElement("tr");
    row.append(td(quote.number), td(quote.client_name), td(money(quote.total_cents)));

    const statusCell = document.createElement("td");
    statusCell.append(statusBadge(quote.status));
    row.append(statusCell);

    const actions = document.createElement("td");
    actions.className = "row-actions";

    if (quote.status === "draft") actions.append(button("Edit", () => openQuoteDialog(quote.id)));
    actions.append(button("Print", () => {
      window.open("/print.html?type=quote&id=" + encodeURIComponent(quote.id), "_blank", "noopener");
    }));
    if (canEmailDocuments()) actions.append(button("Email", () => emailDocument("quote", quote.id)));

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

    if (!["declined", "expired"].includes(quote.status)) {
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

async function openQuoteDialog(id = null) {
  if (!state.clients.length) {
    toast("Add a client before creating a quote.", true);
    setView("clients");
    return;
  }

  const form = $("#quote-form");
  form.reset();
  fillClientSelects();
  form.elements.id.value = "";
  form.elements.taxMode.value = documentTaxDefault();
  setDocumentItems($("#quote-items"));

  if (id) {
    try {
      const data = await api("/api/quotes/" + encodeURIComponent(id));
      form.elements.id.value = data.quote.id;
      form.elements.clientId.value = data.quote.client_id;
      form.elements.expiresAt.value = inputDate(data.quote.expires_at);
      form.elements.notes.value = data.quote.notes || "";
      form.elements.taxMode.value = Number(data.quote.tax_cents) > 0 ? "gst10" : "none";
      setDocumentItems($("#quote-items"), data.items || []);
      $("#quote-dialog-title").textContent = "Edit " + data.quote.number;
    } catch (error) {
      toast(error.message, true);
      return;
    }
  } else {
    $("#quote-dialog-title").textContent = "Create quote";
  }

  $("#quote-dialog").showModal();
}

$("#add-quote").addEventListener("click", () => openQuoteDialog());
$("#add-quote-item").addEventListener("click", () => $("#quote-items").append(documentLineRow()));

$("#quote-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.elements.id.value;
  const payload = {
    clientId: form.elements.clientId.value,
    expiresAt: form.elements.expiresAt.value,
    notes: form.elements.notes.value,
    taxMode: form.elements.taxMode.value,
    items: collectDocumentItems($("#quote-items"))
  };

  try {
    await api(id ? "/api/quotes/" + encodeURIComponent(id) : "/api/quotes", {
      method: id ? "PATCH" : "POST",
      body: JSON.stringify(payload)
    });
    $("#quote-dialog").close();
    await loadQuotes();
    toast(id ? "Quote updated." : "Quote created.");
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
  const visible = visibleRecords("invoices", state.invoices, (invoice) => [invoice.number, invoice.client_name, invoice.status].filter(Boolean).join(" "));
  $("#invoices-empty").classList.toggle("hidden", visible.length > 0);

  body.replaceChildren(...visible.map((invoice) => {
    const outstanding = Math.max(0, invoice.total_cents - invoice.amount_paid_cents);
    const row = document.createElement("tr");
    row.append(td(invoice.number), td(invoice.client_name), td(money(invoice.total_cents)), td(money(outstanding)));

    const statusCell = document.createElement("td");
    statusCell.append(statusBadge(invoice.status));
    row.append(statusCell);

    const actions = document.createElement("td");
    actions.className = "row-actions";

    if (invoice.status === "draft") actions.append(button("Edit", () => openInvoiceDialog(invoice.id)));
    actions.append(button("Print", () => {
      window.open("/print.html?type=invoice&id=" + encodeURIComponent(invoice.id), "_blank", "noopener");
    }));
    if (canEmailDocuments()) actions.append(button("Email", () => emailDocument("invoice", invoice.id)));

    if (invoice.status === "draft") {
      actions.append(button("Mark sent", async () => {
        try {
          await api("/api/invoices/" + encodeURIComponent(invoice.id), {
            method: "PATCH",
            body: JSON.stringify({ status: "sent" })
          });
          await Promise.all([loadInvoices(), loadDashboard(), loadToday()]);
          toast("Invoice marked sent.");
        } catch (error) { toast(error.message, true); }
      }));
    }

    if (outstanding > 0 && !["draft", "void"].includes(invoice.status)) {
      actions.append(button("Payment", () => openPaymentDialog(invoice)));
    }

    if (!["paid", "void"].includes(invoice.status) && invoice.amount_paid_cents === 0) {
      actions.append(button("Void", async () => {
        if (!confirm("Void " + invoice.number + "?")) return;
        try {
          await api("/api/invoices/" + encodeURIComponent(invoice.id), {
            method: "PATCH",
            body: JSON.stringify({ status: "void" })
          });
          await Promise.all([loadInvoices(), loadDashboard(), loadToday()]);
          toast("Invoice voided.");
        } catch (error) { toast(error.message, true); }
      }, true));
    }

    row.append(actions);
    return row;
  }));
}

async function openInvoiceDialog(id = null) {
  if (!state.clients.length) {
    toast("Add a client before creating an invoice.", true);
    setView("clients");
    return;
  }

  const form = $("#invoice-form");
  form.reset();
  fillClientSelects();
  form.elements.id.value = "";
  form.elements.taxMode.value = documentTaxDefault();
  setDocumentItems($("#invoice-items"));

  if (id) {
    try {
      const data = await api("/api/invoices/" + encodeURIComponent(id));
      form.elements.id.value = data.invoice.id;
      form.elements.clientId.value = data.invoice.client_id;
      form.elements.dueAt.value = inputDate(data.invoice.due_at);
      form.elements.notes.value = data.invoice.notes || "";
      form.elements.taxMode.value = Number(data.invoice.tax_cents) > 0 ? "gst10" : "none";
      setDocumentItems($("#invoice-items"), data.items || []);
      $("#invoice-dialog-title").textContent = "Edit " + data.invoice.number;
    } catch (error) {
      toast(error.message, true);
      return;
    }
  } else {
    $("#invoice-dialog-title").textContent = "Create invoice";
  }

  $("#invoice-dialog").showModal();
}

$("#add-invoice").addEventListener("click", () => openInvoiceDialog());
$("#add-invoice-item").addEventListener("click", () => $("#invoice-items").append(documentLineRow()));

$("#invoice-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.elements.id.value;
  const payload = {
    clientId: form.elements.clientId.value,
    dueAt: form.elements.dueAt.value,
    notes: form.elements.notes.value,
    taxMode: form.elements.taxMode.value,
    items: collectDocumentItems($("#invoice-items"))
  };

  try {
    await api(id ? "/api/invoices/" + encodeURIComponent(id) : "/api/invoices", {
      method: id ? "PATCH" : "POST",
      body: JSON.stringify(payload)
    });
    $("#invoice-dialog").close();
    await Promise.all([loadInvoices(), loadDashboard(), loadToday()]);
    toast(id ? "Invoice updated." : "Invoice created.");
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
    await Promise.all([loadInvoices(), loadIncome(), loadDashboard(), loadReport(), loadToday()]);
    toast("Payment recorded.");
  } catch (error) { toast(error.message, true); }
});

async function loadIncome() {
  try {
    const data = await api("/api/income");
    state.income = data.income || [];
    renderIncome();
  } catch (error) { toast(error.message, true); }
}

let incomeInvoiceResults = [];
let incomeInvoicePreviouslySelected = "";
let incomeInvoiceRequest = 0;
let incomeInvoiceSearchTimer = null;

function hideIncomeInvoiceResults() {
  $("#income-invoice-results").classList.add("hidden");
  $("#income-invoice-search").setAttribute("aria-expanded", "false");
}

function showIncomeInvoiceResults() {
  $("#income-invoice-results").classList.remove("hidden");
  $("#income-invoice-search").setAttribute("aria-expanded", "true");
}

function renderIncomeInvoiceResults() {
  const list = $("#income-invoice-results");
  const query = $("#income-invoice-search").value.trim();
  const nodes = [];
  const other = document.createElement("button");
  other.type = "button";
  other.className = "income-invoice-option";
  other.setAttribute("role", "option");
  other.textContent = "Other income — not linked to an invoice";
  other.addEventListener("click", () => {
    $("#income-invoice-id").value = "";
    $("#income-invoice-search").value = "";
    updateIncomeInvoiceSelection();
    hideIncomeInvoiceResults();
  });
  nodes.push(other);
  for (const invoice of incomeInvoiceResults) {
    const row = document.createElement("div");
    row.className = "income-invoice-result";
    const title = document.createElement("span");
    title.textContent = invoice.number + " · " + invoice.client_name + " · " +
      money(invoice.outstanding_cents) + " outstanding";
    if (invoice.status === "draft") {
      row.classList.add("income-invoice-draft");
      const explanation = document.createElement("small");
      explanation.textContent = "Draft — mark sent before assigning income";
      const mark = document.createElement("button");
      mark.type = "button";
      mark.className = "secondary small";
      mark.textContent = "Mark sent";
      mark.addEventListener("click", async () => {
        mark.disabled = true;
        try {
          await api("/api/invoices/" + encodeURIComponent(invoice.id), {
            method: "PATCH", body: JSON.stringify({ status: "sent" })
          });
          await Promise.all([loadInvoices(), loadDashboard(), loadToday()]);
          await refreshIncomeInvoiceChoices();
          toast(invoice.number + " marked sent. Select it to record income.");
        } catch (error) {
          mark.disabled = false;
          toast(error.message, true);
        }
      });
      row.append(title, explanation, mark);
    } else {
      const select = document.createElement("button");
      select.type = "button";
      select.className = "income-invoice-option";
      select.setAttribute("role", "option");
      select.append(title);
      select.addEventListener("click", () => {
        $("#income-invoice-id").value = invoice.id;
        $("#income-invoice-search").value = invoice.number + " · " + invoice.client_name;
        updateIncomeInvoiceSelection();
        hideIncomeInvoiceResults();
      });
      row.append(select);
    }
    nodes.push(row);
  }
  if (incomeInvoiceResults.length === 0) {
    const empty = document.createElement("div");
    empty.className = "income-invoice-empty";
    empty.textContent = query
      ? "No invoices match that search. Try a client name or invoice number."
      : "No unpaid invoices. Create an invoice first or record other income.";
    nodes.push(empty);
  }
  list.replaceChildren(...nodes);
  showIncomeInvoiceResults();
}

async function refreshIncomeInvoiceChoices() {
  const query = $("#income-invoice-search").value.trim();
  const requestId = ++incomeInvoiceRequest;
  $("#income-invoice-balance").textContent = "Searching invoices…";
  try {
    const data = await api("/api/income/available-invoices?q=" + encodeURIComponent(query));
    if (requestId !== incomeInvoiceRequest || !$("#income-dialog").open) return;
    incomeInvoiceResults = data.invoices || [];
    renderIncomeInvoiceResults();
    updateIncomeInvoiceSelection();
  } catch (error) {
    if (requestId === incomeInvoiceRequest && $("#income-dialog").open) {
      incomeInvoiceResults = [];
      const list = $("#income-invoice-results");
      const message = document.createElement("div");
      message.className = "income-invoice-empty";
      message.textContent = "Unable to load invoices: " + error.message;
      list.replaceChildren(message);
      showIncomeInvoiceResults();
      $("#income-invoice-balance").textContent = "Invoice search is unavailable. Try again.";
    }
  }
}

function updateIncomeInvoiceSelection() {
  const form = $("#income-form");
  const invoice = incomeInvoiceResults.find((entry) => entry.id === form.elements.invoiceId.value && entry.status !== "draft");
  const selected = Boolean(invoice);
  if (!selected && incomeInvoicePreviouslySelected) form.elements.amount.value = "";
  incomeInvoicePreviouslySelected = invoice?.id || "";
  $("#income-partial-group").classList.toggle("hidden", !selected);
  $("#income-description-group").classList.toggle("hidden", selected);
  $("#income-selected").classList.toggle("hidden", !selected);
  form.elements.description.required = !selected;
  form.elements.description.disabled = selected;
  if (!selected) {
    form.elements.partialPayment.checked = false;
    form.elements.amount.readOnly = false;
    form.elements.amount.removeAttribute("max");
    $("#income-selected").textContent = "";
    $("#income-invoice-balance").textContent = incomeInvoiceResults.length
      ? "Choose an invoice from the results, or record other income."
      : "No unpaid invoices found. Other income is still available.";
    return;
  }
  const outstanding = Number(invoice.outstanding_cents);
  form.elements.partialPayment.checked = false;
  form.elements.amount.readOnly = true;
  form.elements.amount.max = (outstanding / 100).toFixed(2);
  form.elements.amount.value = (outstanding / 100).toFixed(2);
  $("#income-selected").textContent = "Selected: " + invoice.number + " · " + invoice.client_name;
  $("#income-invoice-balance").textContent =
    money(outstanding) + " outstanding. Full payment settles this invoice.";
}

function updateIncomePartialPayment() {
  const form = $("#income-form");
  const invoice = incomeInvoiceResults.find((entry) => entry.id === form.elements.invoiceId.value);
  if (!invoice) return;
  const partial = form.elements.partialPayment.checked;
  const outstanding = Number(invoice.outstanding_cents);
  form.elements.amount.readOnly = !partial;
  form.elements.amount.max = ((partial ? Math.max(0, outstanding - 1) : outstanding) / 100).toFixed(2);
  form.elements.amount.value = partial ? "" : (outstanding / 100).toFixed(2);
  form.elements.amount.placeholder = partial ? "Less than " + money(outstanding) : "";
  $("#income-invoice-balance").textContent = partial
    ? "Enter less than " + money(outstanding) + ". The remainder stays searchable."
    : "Full payment: " + money(outstanding) + ". The invoice leaves search when paid.";
}

function openIncomeDialog(item = null) {
  const form = $("#income-form");
  clearTimeout(incomeInvoiceSearchTimer);
  ++incomeInvoiceRequest;
  incomeInvoiceResults = [];
  incomeInvoicePreviouslySelected = "";
  form.reset();
  form.elements.id.value = item?.id || "";
  form.elements.invoiceId.value = "";
  form.elements.description.value = item?.description || "";
  form.elements.description.disabled = false;
  form.elements.description.required = true;
  form.elements.amount.readOnly = false;
  form.elements.amount.removeAttribute("max");
  form.elements.amount.value = item ? (item.amount_cents / 100).toFixed(2) : "";
  form.elements.receivedAt.value = item?.paid_at?.slice(0,10) || localDateTimeInput(new Date()).slice(0,10);
  form.elements.notes.value = item?.notes || "";
  $("#income-dialog-title").textContent = item ? "Edit income" : "Add income";
  $("#save-income-button").textContent = item ? "Save changes" : "Add income";
  $("#income-invoice-picker").classList.toggle("hidden", Boolean(item));
  $("#income-entry-hint").classList.toggle("hidden", Boolean(item));
  $("#income-invoice-search").value = "";
  $("#income-invoice-results").replaceChildren();
  hideIncomeInvoiceResults();
  $("#income-partial-group").classList.add("hidden");
  $("#income-selected").classList.add("hidden");
  $("#income-dialog").showModal();
  if (!item) void refreshIncomeInvoiceChoices();
}

$("#income-invoice-search").addEventListener("input", () => {
  clearTimeout(incomeInvoiceSearchTimer);
  ++incomeInvoiceRequest; // invalidate any in-flight request immediately
  $("#income-invoice-id").value = "";
  updateIncomeInvoiceSelection();
  $("#income-invoice-balance").textContent = "Searching invoices…";
  incomeInvoiceSearchTimer = setTimeout(refreshIncomeInvoiceChoices, 160);
});
$("#income-invoice-search").addEventListener("focus", () => {
  if ($("#income-dialog").open && !$("#income-invoice-results").children.length)
    void refreshIncomeInvoiceChoices();
  else showIncomeInvoiceResults();
});
$("#income-invoice-search").addEventListener("keydown", (event) => {
  if (event.key === "Escape") { hideIncomeInvoiceResults(); return; }
  if (event.key === "ArrowDown") {
    const first = $("#income-invoice-results").querySelector(".income-invoice-option");
    if (first) { event.preventDefault(); first.focus(); }
  }
});
$("#income-show-invoices").addEventListener("click", () => {
  $("#income-invoice-search").value = "";
  $("#income-invoice-id").value = "";
  updateIncomeInvoiceSelection();
  void refreshIncomeInvoiceChoices();
  $("#income-invoice-search").focus();
});

function renderIncome() {
  $("#income-empty").classList.toggle("hidden", state.income.length > 0);
  $("#income-body").replaceChildren(...state.income.map((item) => {
    const row = document.createElement("tr");
    const isInvoice = Boolean(item.invoice_id);
    row.append(
      td(isInvoice ? "Invoice payment" : (item.description || "Other income")),
      td(isInvoice ? [item.invoice_number, item.client_name].filter(Boolean).join(" · ") : "Other income"),
      td(dateText(item.paid_at)), td(money(item.amount_cents))
    );
    const actions = document.createElement("td");
    actions.className = "row-actions";
    if (isInvoice) {
      actions.append(button("Invoice", () => setView("invoices")));
    } else {
      actions.append(button("Edit", () => openIncomeDialog(item)));
      actions.append(button("Delete", async () => {
        if (!confirm("Delete this income entry? The report totals will be recalculated.")) return;
        try {
          await api("/api/income/" + encodeURIComponent(item.id), { method: "DELETE" });
          await Promise.all([loadIncome(), loadDashboard(), loadReport()]);
          toast("Income entry deleted.");
        } catch (error) { toast(error.message, true); }
      }, true));
    }
    row.append(actions);
    return row;
  }));
}

$("#add-income").addEventListener("click", () => openIncomeDialog());
$("#income-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const id = String(form.get("id") || "");
  const invoiceId = !id ? String(form.get("invoiceId") || "") : "";
  const amountCents = Math.round(Number(form.get("amount")) * 100);
  const selected = incomeInvoiceResults.find((invoice) => invoice.id === invoiceId);
  const partialPayment = Boolean(form.get("partialPayment"));
  try {
    if (invoiceId) {
      if (!selected) throw new Error("Select an outstanding invoice from the current search results.");
      if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error("Enter a valid payment amount.");
      if (partialPayment && amountCents >= selected.outstanding_cents)
        throw new Error("Partial payment must be below the remaining invoice balance.");
      if (!partialPayment && amountCents !== selected.outstanding_cents)
        throw new Error("Untick Partial payment to settle the full balance, or tick it to enter a smaller amount.");
      await api("/api/invoices/" + encodeURIComponent(invoiceId) + "/payments", {
        method: "POST",
        body: JSON.stringify({
          amountCents,
          partialPayment,
          receivedAt: form.get("receivedAt"),
          notes: form.get("notes")
        })
      });
    } else {
      await api(id ? "/api/income/" + encodeURIComponent(id) : "/api/income", {
        method: id ? "PATCH" : "POST",
        body: JSON.stringify({
          description: form.get("description"),
          amountCents,
          receivedAt: form.get("receivedAt"),
          notes: form.get("notes")
        })
      });
    }
    $("#income-dialog").close();
    ++incomeInvoiceRequest;
    await Promise.all([loadIncome(), loadInvoices(), loadDashboard(), loadReport(), loadToday()]);
    toast(invoiceId ? (partialPayment ? "Partial payment recorded. Invoice remains outstanding." : "Invoice paid in full and removed from the available list.") :
      (id ? "Income updated." : "Income recorded."));
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
  $("#expenses-empty").classList.toggle("hidden", state.expenses.length > 0);
  $("#expenses-body").replaceChildren(...state.expenses.map((expense) => {
    const row = document.createElement("tr");
    row.append(td(expense.description), td(expense.category), td(dateText(expense.incurred_at)), td(money(expense.amount_cents)));
    const actions = document.createElement("td");
    actions.className = "row-actions";
    actions.append(button("Edit", () => openExpenseDialog(expense)));
    actions.append(button("Delete", async () => {
      if (!confirm("Delete this expense?")) return;
      try {
        await api("/api/expenses/" + encodeURIComponent(expense.id), { method: "DELETE" });
        await Promise.all([loadExpenses(), loadDashboard(), loadReport()]);
        toast("Expense deleted.");
      } catch (error) { toast(error.message, true); }
    }, true));
    row.append(actions);
    return row;
  }));
}

function openExpenseDialog(expense = null) {
  const form = $("#expense-form");
  form.reset();
  form.elements.id.value = expense?.id || "";
  form.elements.description.value = expense?.description || "";
  form.elements.category.value = expense?.category || "";
  form.elements.amount.value = expense ? (expense.amount_cents / 100).toFixed(2) : "";
  form.elements.incurredAt.value = expense?.incurred_at?.slice(0,10) || new Date().toISOString().slice(0,10);
  form.elements.notes.value = expense?.notes || "";
  $("#expense-dialog-title").textContent = expense ? "Edit expense" : "Add expense";
  $("#save-expense-button").textContent = expense ? "Save changes" : "Add expense";
  $("#expense-dialog").showModal();
}

$("#add-expense").addEventListener("click", () => openExpenseDialog());
$("#expense-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const id = String(form.get("id") || "");
  try {
    await api(id ? "/api/expenses/" + encodeURIComponent(id) : "/api/expenses", {
      method: id ? "PATCH" : "POST",
      body: JSON.stringify({
        description: form.get("description"),
        category: form.get("category"),
        amountCents: Math.round(Number(form.get("amount")) * 100),
        incurredAt: form.get("incurredAt"),
        notes: form.get("notes")
      })
    });
    $("#expense-dialog").close();
    await Promise.all([loadExpenses(), loadDashboard(), loadReport()]);
    toast(id ? "Expense updated." : "Expense added.");
  } catch (error) { toast(error.message, true); }
});

// Dialogs close only using their explicit Cancel/Close controls or after a
// successful form submission. A drag-select gesture can finish over the
// backdrop, which used to discard unsaved input when treated as a click.
$(".close-dialog").forEach((button) => {
  button.addEventListener("click", () => button.closest("dialog").close());
});

boot();
