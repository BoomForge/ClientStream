import type { Env } from "./types";

/**
 * SiteGuard has been retired from sale. The historical redirect endpoint is
 * deliberately closed; old links must not expose a checkout or send buyers
 * to a monitoring service being taken offline.
 *
 * This path is side-effect-free: it never writes referral telemetry,
 * modifies subscriptions, processes payments or touches ClientStream D1.
 */
export async function siteguardReferral(request: Request, _env?: Env): Promise<Response> {
  const method = request.method.toUpperCase();
  return new Response(method === "HEAD" ? null : JSON.stringify({
    status: "retired",
    available_for_purchase: false,
    message: "SiteGuard is no longer accepting new subscriptions. Existing members should review billing in Whop."
  }), {
    status: 410,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      "referrer-policy": "no-referrer",
      "access-control-allow-origin": "*"
    }
  });
}
