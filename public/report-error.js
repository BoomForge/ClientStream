const form = document.querySelector("#error-report-form");
const status = document.querySelector("#error-report-status");
const button = document.querySelector("#send-error-report");

// Keep the referring path for diagnostics, never a URL query with possible tokens.
try {
  const ref = new URL(document.referrer);
  if (["app.clientstream.io", "clientstream.io", "www.clientstream.io"].includes(ref.hostname)) {
    form.elements.pageUrl.value = ref.origin + ref.pathname;
  }
} catch { /* Direct visits may have no referrer. */ }

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  const payload = Object.fromEntries(["issueType", "summary", "details", "steps", "email", "pageUrl", "website"]
    .map((name) => [name, String(data.get(name) || "").trim()]));
  status.hidden = true;
  button.disabled = true;
  button.textContent = "Sending…";
  try {
    const response = await fetch("/api/error-reports", {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json" },
      body: JSON.stringify(payload)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Could not send your report. Please try again.");
    status.className = "support-status success";
    status.textContent = body.message || "Your report was sent.";
    status.hidden = false;
    form.reset();
  } catch (error) {
    // Preserve everything the reporter wrote after a failed request.
    status.className = "support-status error";
    status.textContent = error.message || "Unable to send the report. Try again.";
    status.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "Send error report";
    status.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
});
