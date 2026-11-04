import type { Env } from "./types";
import { json, mutationOriginIsAllowed, sha256Hex, validEmail } from "./http";
import { emailConfigured, escapeHtml, sendEmail } from "./email";

const CATEGORIES = new Set(["Something not working", "Error message", "Login or account", "Billing", "Other"]);
const textField = (data: Record<string, unknown>, key: string): string =>
  typeof data[key] === "string" ? (data[key] as string).trim() : "";
const fail = (message: string, status: number): Response => json({ error: message }, { status });

/** Public: works for users who cannot sign in, with Cloudflare rate limiting. */
export async function submitErrorReport(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) return fail("Invalid request origin.", 403);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return fail("Expected a JSON report.", 415);
  if (Number(request.headers.get("content-length") || "0") > 12000) return fail("Report is too long.", 413);

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

  if (textField(data, "website")) {
    return json({ success: true, message: "Report received." }, { status: 202 });
  }
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

  // Send directly from the ClientStream Cloudflare Worker via its existing
  // transactional email integration. This avoids the SiteGuard/Pi bridge.
  // Never claim delivery if the seller's support mailbox is not configured.
  const recipient = (env.SUPPORT_EMAIL || "").trim();
  if (!emailConfigured(env) || !validEmail(recipient)) {
    console.error("ClientStream report delivery is not configured");
    return fail("Error reporting is temporarily unavailable. Please try again later.", 503);
  }
  const browser = (request.headers.get("user-agent") || "Unknown").slice(0, 300);
  const text = [
    "ClientStream error report",
    "Category: " + issueType,
    "Summary: " + summary,
    "Description: " + details,
    "Steps: " + (steps || "(none)"),
    "Reply email: " + (email || "(not provided)"),
    "Page URL: " + (pageUrl || "(not provided)"),
    "Browser: " + browser
  ].join("\n\n");
  try {
    await sendEmail(env, {
      to: recipient,
      subject: "[ClientStream] Error report: " + summary.slice(0, 90),
      text,
      html: "<h2>ClientStream error report</h2><pre style=\"white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.5 monospace\">"
        + escapeHtml(text) + "</pre>"
    });
  } catch (error) {
    console.error("ClientStream direct error-report email failed", {
      error: error instanceof Error ? error.name : "transport_failure"
    });
    return fail("Error reporting is temporarily unavailable. Please try again later.", 503);
  }
  return json({ success: true, message: "Thanks. Your report has been sent to the ClientStream team." }, { status: 201 });
}
