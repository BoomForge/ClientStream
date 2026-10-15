import type { Env } from "./types";

// Deliberately no third-party tracking scripts or customer identifiers.
// Incoming source tags are allowlisted and never reach the SiteGuard origin,
// whose live homepage returns 404 when normal UTM query strings are attached.
const SOURCES = new Set([
  "clientstream_website",
  "clientstream_marketing_guide",
  "clientstream_app",
  "clientstream_monitoring_guide",
  "siteguard_outage_guide",
  "siteguard_ssl_guide"
]);
const SITEGUARD_URL = "https://siteguard.clientstream.io/";

export async function siteguardReferral(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const source = url.searchParams.get("source") ?? "";
  if (request.method === "GET" && SOURCES.has(source) && url.searchParams.get("probe") !== "1") {
    const now = new Date().toISOString();
    try {
      await env.DB.prepare(
        "INSERT INTO siteguard_referral_clicks (source, day_utc, clicks, updated_at) " +
        "VALUES (?, ?, 1, ?) ON CONFLICT(source, day_utc) DO UPDATE SET " +
        "clicks = siteguard_referral_clicks.clicks + 1, updated_at = excluded.updated_at"
      ).bind(source, now.slice(0, 10), now).run();
    } catch {
      // Never hold up the customer's sales page due to telemetry failure.
      console.error("SiteGuard referral aggregate unavailable");
    }
  }
  return new Response(null, {
    status: 302,
    headers: {
      "Location": SITEGUARD_URL,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow"
    }
  });
}
