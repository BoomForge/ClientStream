"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const form = $("member-login");
  const controls = $("member-controls");
  const feedback = $("member-feedback");
  const say = message => { feedback.hidden = false; feedback.textContent = message; };
  const request = async (path, method = "GET", data) => {
    const res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: { "accept": "application/json", ...(data ? { "content-type": "application/json" } : {}) },
      ...(data ? { body: JSON.stringify(data) } : {})
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Error(json.error || "Request could not be completed.");
    return json;
  };
  async function refresh() {
    const result = await request("/api/billing/status");
    const bill = result.subscription;
    $("member-plan").textContent = bill
      ? "Current subscription: " + bill.status + "; renewal-end date: " + (bill.currentPeriodEnd || "not supplied") + (bill.cancelAtPeriodEnd ? "; cancellation scheduled." : "")
      : "No linked PayPal subscription is recorded for your current business.";
    $("member-cancel").disabled = !bill || bill.status === "cancelled";
  }
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const button = form.querySelector("button");
    button.disabled = true;
    try {
      await request("/api/auth/login", "POST", {
        email: $("member-email").value, password: $("member-password").value
      });
      $("member-password").value = "";
      await refresh();
      form.hidden = true;
      controls.hidden = false;
      say("Signed in to limited billing and export access.");
    } catch (error) { say(error.message); }
    finally { button.disabled = false; }
  });
  $("member-cancel").addEventListener("click", async () => {
    const button = $("member-cancel");
    button.disabled = true;
    try {
      const result = await request("/api/billing/cancel", "POST");
      say(result.message || "Cancellation request submitted. Check PayPal to verify future billing is stopped.");
      await refresh();
    } catch (error) { say(error.message + " You can also manage recurring payments directly in PayPal."); }
    finally { if (!controls.hidden) button.disabled = false; }
  });
  $("member-export").addEventListener("click", async () => {
    const button = $("member-export");
    button.disabled = true;
    try {
      const res = await fetch("/api/account/export", { credentials: "same-origin", headers: {accept:"application/json"} });
      if (!res.ok) throw Error("Data export is currently unavailable.");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "clientstream-account-export.json";
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      say("Your account export was generated.");
    } catch(error) { say(error.message); }
    finally { button.disabled = false; }
  });
  $("member-logout").addEventListener("click", async () => {
    await request("/api/auth/logout", "POST").catch(() => {});
    controls.hidden = true; form.hidden = false;
    $("member-password").value = "";
    say("Signed out.");
  });
})();
