import type { Env } from "./types";
import { json, sha256Hex } from "./http";

function clientFingerprint(request: Request): string {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const ua = request.headers.get("user-agent") ?? "unknown";
  return ip + "|" + ua.slice(0, 160);
}

async function limiterKey(request: Request): Promise<string> {
  const url = new URL(request.url);
  return url.pathname + "|" + await sha256Hex(clientFingerprint(request));
}

export async function enforceAuthRateLimit(request: Request, env: Env): Promise<Response | null> {
  if (!env.AUTH_RATE_LIMITER) return null;
  try {
    const result = await env.AUTH_RATE_LIMITER.limit({ key: await limiterKey(request) });
    return result.success
      ? null
      : json({ error: "Too many authentication attempts. Please try again shortly." }, {
          status: 429,
          headers: { "retry-after": "60" }
        });
  } catch (error) {
    console.error("ClientStream auth rate limiter unavailable", error);
    return null;
  }
}

export async function enforceMutationRateLimit(request: Request, env: Env): Promise<Response | null> {
  if (!env.MUTATION_RATE_LIMITER) return null;
  try {
    const result = await env.MUTATION_RATE_LIMITER.limit({ key: await limiterKey(request) });
    return result.success
      ? null
      : json({ error: "Too many requests. Please slow down and try again." }, {
          status: 429,
          headers: { "retry-after": "60" }
        });
  } catch (error) {
    console.error("ClientStream mutation rate limiter unavailable", error);
    return null;
  }
}

export async function enforceAiRateLimit(key: string, env: Env): Promise<Response | null> {
  if (!env.AI_RATE_LIMITER) return null;
  try {
    const result = await env.AI_RATE_LIMITER.limit({ key });
    return result.success
      ? null
      : json({ error: "Smart Write is receiving too many requests. Please try again shortly." }, {
          status: 429,
          headers: { "retry-after": "60" }
        });
  } catch (error) {
    console.error("ClientStream AI rate limiter unavailable", error);
    return null;
  }
}

export function secureAssetResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");

  const contentType = headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    headers.set(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'"
    );
    headers.set("cache-control", "no-cache");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
