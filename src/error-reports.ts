import type { Env } from "./types";
import { emailConfigured, escapeHtml, sendEmail } from "./email";
import { json, mutationOriginIsAllowed, sha256Hex, validEmail } from "./http";

// This recipient is fixed server-side: form submissions cannot redirect mail.
const REPORT_INBOX = "thevansorrell@gmail.com";
const CATEGORIES = new Set(["Something not working", "Error message", "Login or account", "Billing", "Other"]);
const textField = (data: Record<string, unknown>, key: string): string =>
  typeof data[key] === "string" ? (data[key] as string).trim() : "";
const fail = (message: string, status: number): Response => json({ error: message }, { status });

/** Public so that sign-in and registration errors can also be reported. */
export async function submitErrorReport(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) return fail("Invalid request origin.", 403);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return fail("Expected a JSON report.", 415);
  if (Number(request.headers.get("content-length") || "0") > 12000) return fail("Report is too long.", 413);

  // Dedicated limiter is deliberately fail-closed if missing or unavailable.
  if (!env.REPORT_RATE_LIMITER) return fail("Error reporting is temporarily unavailable.", 503);
  try {
    const key = await sha256Hex(request.headers.get("cf-connecting-ip") || "unknown");
    const result = await env.REPORT_RATE_LIMITER.limit({ key });
    if (!result.success) return json({ error: "Too many reports. Please try again in a minute." }, {
      status: 429, headers: { "retry-after": "60" }
    });
  } catch (error) {
    console.error("Report rate limit failed", error);
    return fail("Error reporting is temporarily unavailable.", 503);
  }

  let data: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > 12000) return fail("Report is too long.", 413);
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw Error("Malformed report");
    data = parsed as Record<string, unknown>;
  } catch { return fail("Please submit a valid error report.", 400); }

  // Honeypot: accept without sending anything.
  if (textField(data, "website")) return json({ success: true, message: "Report received." }, { status: 202 });

  const issueType = textField(data, "issueType");
  const summary = textField(data, "summary");
  const details = textField(data, "details");
  const steps = textField(data, "steps");
  const email = textField(data, "email");
  const pageUrl = textField(data, "pageUrl");
  if (!CATEGORIES.has(issueType) || summary.length < 5 || summary.length > 140 ||
      details.length < 20 || details.length > 4000 || steps.length > 2000 ||
      pageUrl.length > 500 || (email !== "" && !validEmail(email))) {
    return fail("Please check the fields and try again.", 400);
  }
  if (!emailConfigured(env)) return fail("Email delivery is not available right now. Please try again later.", 503);

  const reportId = crypto.randomUUID();
  const rows = [
    ["Reference", reportId],
    ["Category", issueType],
    ["Summary", summary],
    ["Description", details],
    ["How to reproduce", steps || "Not provided"],
    ["Reply email", email || "Not provided"],
    ["Page", pageUrl || "Not provided"],
    ["Browser", (request.headers.get("user-agent") || "Unknown").slice(0, 300)],
    ["Submitted", new Date().toISOString()]
  ];
  const plain = rows.map(([key, value]) => key + ":\n" + value).join("\n\n");
  const html = '<!doctype html><html><body style="font:15px Arial,sans-serif;background:#f7f9fc;padding:24px">' +
    '<div style="max-width:680px;margin:auto;padding:26px;background:white;border:1px solid #dbe4ef;border-radius:14px">' +
    '<h1>ClientStream error report</h1>' +
    rows.map(([key, value]) => '<p style="padding:10px 0;border-bottom:1px solid #e2e8f0"><strong>' +
      escapeHtml(key) + '</strong><br><span style="white-space:pre-wrap;overflow-wrap:anywhere">' +
      escapeHtml(value) + '</span></p>').join("") + '</div></body></html>';
  try {
    await sendEmail(env, { to: REPORT_INBOX, subject: "ClientStream issue: " + summary, html, text: plain });
  } catch (error) {
    // Never return provider details or personal report contents to the browser.
    console.error("ClientStream report email not accepted", { reportId, error: error instanceof Error ? error.message : String(error) });
    return fail("We couldn't send your report. Please try again later.", 502);
  }
  return json({ success: true, message: "Thanks. Your report has been sent to the ClientStream team." }, { status: 201 });
}
