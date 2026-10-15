import type { Env } from "./types";
import { json, mutationOriginIsAllowed, sha256Hex, validEmail } from "./http";

const SITEGUARD_MAIL_BRIDGE = "https://siteguard.clientstream.io/clientstream/error-report";
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

  // Resend credentials never leave SkyPi. The Cloudflare Worker calls only
  // SiteGuard's fixed-recipient, rate-limited mail bridge over HTTPS.
  let response: Response;
  try {
    response = await fetch(SITEGUARD_MAIL_BRIDGE, {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json" },
      body: JSON.stringify({
        issueType, summary, details, steps, email, pageUrl,
        browser: (request.headers.get("user-agent") || "Unknown").slice(0, 300)
      }),
      signal: AbortSignal.timeout(18000)
    });
  } catch (error) {
    console.error("SiteGuard error-report bridge unreachable", { error: error instanceof Error ? error.name : "network_failure" });
    return fail("Error reporting is temporarily unavailable. Please try again later.", 503);
  }
  if (response.status === 429) return fail("Too many reports. Please try again later.", 429);
  if (response.status !== 201) {
    // A bridge that failed to send must never appear successful to the user.
    console.error("SiteGuard mail bridge rejected report", { status: response.status });
    return fail("Error reporting is temporarily unavailable. Please try again later.", 503);
  }
  return json({ success: true, message: "Thanks. Your report has been sent to the ClientStream team." }, { status: 201 });
}
