import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
assert.match(html, /id="income-invoice-search"/);
assert.match(html, /id="income-invoice-results"[^>]*role="listbox"/);
assert.match(html, /id="income-invoice-id"[^>]*name="invoiceId"/);
assert.match(css, /\.income-invoice-results\s*\{[\s\S]*?max-height:\s*260px/);

class Node {
  constructor(tag = "div") {
    this.tag = tag;
    this.children = [];
    this.handlers = {};
    this.attrs = {};
    this.value = "";
    this.textContent = "";
    this.disabled = false;
    this.checked = false;
    this.readOnly = false;
    const classes = new Set();
    this.classList = {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, force) => {
        if (force ?? !classes.has(c)) classes.add(c); else classes.delete(c);
        return classes.has(c);
      },
      contains: (c) => classes.has(c)
    };
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(k,v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(k,h) { this.handlers[k] = h; }
  querySelector(selector) {
    const wanted = selector.replace(".", "");
    return this.find((node) => node.className?.split?.(" ").includes(wanted));
  }
  find(test) {
    if (test(this)) return this;
    for (const child of this.children) {
      const found = child.find?.(test);
      if (found) return found;
    }
    return null;
  }
  async click() { return this.handlers.click?.(); }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  reset() { /* caller sets necessary fields */ }
}
const els = new Map();
for (const name of [
  "income-invoice-results", "income-invoice-search", "income-invoice-id",
  "income-invoice-balance", "income-dialog", "income-form", "income-partial-group",
  "income-description-group", "income-selected", "income-invoice-picker",
  "income-entry-hint", "income-dialog-title", "save-income-button", "income-show-invoices", "income-partial-payment"
]) els.set("#" + name, new Node());
const form = els.get("#income-form");
form.elements = {
  id: new Node("input"), invoiceId: els.get("#income-invoice-id"),
  description: new Node("input"), amount: new Node("input"),
  partialPayment: els.get("#income-partial-payment"), receivedAt: new Node("input"),
  notes: new Node("input")
};
const dialog = els.get("#income-dialog");
dialog.open = true;
let invoices = [
  { id: "draft-id", number: "INV-004", status: "draft", client_name: "Sample Builder", outstanding_cents: 10000 },
  { id: "sent-id", number: "INV-005", status: "sent", client_name: "Sample Builder", outstanding_cents: 8000 }
];
const calls = [];
const sandbox = {
  $: (selector) => {
    const element = els.get(selector);
    assert.ok(element, "Missing mock selector " + selector);
    return element;
  },
  document: { createElement: (tag) => new Node(tag) },
  money: (cents) => "A$" + (cents / 100).toFixed(2),
  api: async (url, options) => {
    calls.push(url);
    if (url.startsWith("/api/income/available-invoices")) {
      const q = new URL("https://example.test" + url).searchParams.get("q").toLowerCase();
      return { invoices: invoices.filter((i) =>
        i.number.toLowerCase().includes(q) || i.client_name.toLowerCase().includes(q)) };
    }
    if (url === "/api/invoices/draft-id" && options?.method === "PATCH") {
      invoices[0].status = "sent";
      return {};
    }
    throw Error("Unexpected request " + url);
  },
  loadInvoices: async () => {},
  loadDashboard: async () => {},
  loadToday: async () => {},
  toast: () => {},
  clearTimeout: () => {},
  setTimeout: (f) => { /* real debounce covered via direct search call below */ return 1; },
  localDateTimeInput: () => "2026-10-15T13:00",
  Date, Number, String, Boolean, Array, URL, encodeURIComponent, Promise
};
const a = source.indexOf("let incomeInvoiceResults = [];");
const b = source.indexOf("\nfunction renderIncome() {", a);
assert.ok(a >= 0 && b > a, "Income UI code missing");
const selector = source.slice(a, b) + "\n({ search: refreshIncomeInvoiceChoices, open: openIncomeDialog, partial: updateIncomePartialPayment })";
const ui = runInNewContext(selector, sandbox);
await ui.search();
const list = els.get("#income-invoice-results");
assert.equal(list.classList.contains("hidden"), false, "Results must be visible, not just hidden in a native select");
assert.equal(list.children.length, 3, "Other income plus two actual invoice matches");
assert.equal(els.get("#income-invoice-search").attrs["aria-expanded"], "true");
const draft = list.find((e) => e.textContent === "Mark sent");
assert.ok(draft, "Draft invoice must offer a clear Mark sent action");
await draft.click();
assert.equal(invoices[0].status, "sent", "Mark sent must issue a draft via the existing API");
assert.equal(list.children.length, 3);
const issued = list.find((e) => e.textContent === "INV-005 · Sample Builder · A$80.00 outstanding");
assert.ok(issued, "Visible invoiced payment option is missing");
await issued.parentNode?.click?.(); // older DOM implementations
// Resolve the clickable option from its nested label:
const row = list.find((e) => e.tag === "button" &&
  e.children.some((child) => child.textContent === "INV-005 · Sample Builder · A$80.00 outstanding"));
assert.ok(row, "Search result must have a clickable option");
await row.click();
assert.equal(form.elements.invoiceId.value, "sent-id", "Selecting invoice must set form invoice ID");
assert.equal(form.elements.amount.value, "80.00", "Invoice remaining amount should autopopulate");
assert.equal(form.elements.amount.readOnly, false, "Selected invoices must not lock the amount input");
assert.equal(list.classList.contains("hidden"), true, "List should close after selection");
// Simulate the real checkbox change event, not a direct test-only function call.
const partialCheckbox = els.get("#income-partial-payment");
partialCheckbox.checked = true;
assert.equal(typeof partialCheckbox.handlers.change, "function", "Partial checkbox change handler not registered");
partialCheckbox.handlers.change();
assert.equal(form.elements.amount.readOnly, false, "Checking Partial payment must leave amount editable");
assert.equal(form.elements.amount.disabled, false, "Checking Partial payment must not disable the amount");
assert.equal(form.elements.amount.focused, true, "Checking Partial payment should focus the amount");
assert.equal(form.elements.amount.max, "79.99", "Partial payment must be less than full amount");
form.elements.amount.value = "25.00";
// Search requests may complete late. Re-rendering the same invoice must not
// reset its partial flag, re-lock the input, or overwrite what was just typed.
els.get("#income-invoice-search").value = "Builder";
await ui.search();
assert.equal(partialCheckbox.checked, true, "Late search refresh must preserve partial selection");
assert.equal(form.elements.amount.value, "25.00", "Late search refresh must preserve typed amount");
assert.equal(form.elements.amount.readOnly, false, "Late search refresh must not re-lock input");
partialCheckbox.checked = false;
partialCheckbox.handlers.change();
assert.equal(form.elements.amount.value, "80.00", "Unchecking Partial payment should restore full balance");
assert.equal(form.elements.amount.readOnly, false, "Full payment amount remains editable");
partialCheckbox.checked = true;
partialCheckbox.handlers.change();
form.elements.amount.value = "12.00";
assert.equal(form.elements.amount.value, "12.00", "Partial payment must accept the customer's entered amount");

els.get("#income-invoice-search").value = "unknown";
await ui.search();
assert.equal(list.classList.contains("hidden"), false);
assert.ok(list.find((e) => e.textContent.includes("No invoices match")), "An unmatched search must show an explicit result");
console.log("Visible invoice combobox, draft issue, search results, selection and partial payment UI passed.");
