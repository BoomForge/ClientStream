import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const start = app.lastIndexOf('$$(".close-dialog").forEach');
const finish = app.indexOf("\nboot();", start);
assert.ok(start >= 0 && finish > start, "Explicit dialog close controls must be wired");

function dialog(name) {
  const listeners = new Map();
  return {
    name, open: true, closeCount: 0, input: "Selected invoice payment 1234.56",
    addEventListener(type, cb) { listeners.set(type, cb); },
    dispatch(type, event) { listeners.get(type)?.(event); },
    close() { this.open = false; this.closeCount++; }
  };
}
function closeButton(parent) {
  const listeners = new Map();
  return {
    addEventListener(type, cb) { listeners.set(type, cb); },
    closest(selector) { assert.equal(selector, "dialog"); return parent; },
    click() { listeners.get("click")?.(); }
  };
}

const income = dialog("income");
const expense = dialog("expense");
const incomeCancel = closeButton(income);
const expenseClose = closeButton(expense);
const context = {
  $$: (selector) => {
    if (selector === ".close-dialog") return [incomeCancel, expenseClose];
    if (selector === "dialog") return [income, expense];
    throw Error("Unexpected selector " + selector);
  }
};
runInNewContext(app.slice(start, finish), context);

// A mouse drag that begins over an input and ends on the dialog's backdrop
// must not close or wipe the form. Previously this closed both dialogs.
for (const d of [income, expense]) {
  d.dispatch("click", { target: d });
  assert.equal(d.open, true, d.name + " closed after backdrop drag/release");
  assert.equal(d.closeCount, 0);
  assert.equal(d.input, "Selected invoice payment 1234.56", "Entered data was lost");
}
// Closing is still available by explicit Cancel or the × button.
incomeCancel.click();
expenseClose.click();
assert.equal(income.open, false);
assert.equal(expense.open, false);
assert.equal(income.closeCount, 1);
assert.equal(expense.closeCount, 1);
console.log("Dialogs preserve unsaved edits on backdrop clicks and retain explicit close controls.");
