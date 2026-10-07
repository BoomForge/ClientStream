import type { Env } from "./types";
import { PLAN_CATALOG } from "./types";
import { requireAuth, requireBusiness } from "./auth";
import { json, mutationOriginIsAllowed, readJson, textValue } from "./http";
import { enforceAiRateLimit } from "./security";

type SmartKind = "follow_up" | "payment_reminder" | "review_request" | "appointment" | "general";

const LABELS: Record<SmartKind, string> = {
  follow_up: "customer follow-up",
  payment_reminder: "payment reminder",
  review_request: "Google review request",
  appointment: "appointment message",
  general: "customer message"
};

function monthStartIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

async function usageForMonth(env: Env, businessId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(units),0) AS total FROM ai_usage WHERE business_id = ? AND feature LIKE 'smart_write:%' AND occurred_at >= ?"
  ).bind(businessId, monthStartIso()).first<{ total: number }>();
  return row?.total ?? 0;
}

function fallback(
  kind: SmartKind,
  roughNotes: string,
  businessName: string,
  clientName: string | null,
  reviewUrl: string | null
): string {
  const greeting = clientName ? "Hi " + clientName + "," : "Hi,";
  const notes = roughNotes.trim().replace(/\s+/g, " ");
  const detail = notes ? " " + notes : "";

  switch (kind) {
    case "payment_reminder":
      return `${greeting} just a quick reminder about the outstanding payment.${detail} When you get a chance, could you please let me know when I can expect it? Thanks, ${businessName}`;
    case "follow_up":
      return `${greeting} just following up.${detail} Let me know if you have any questions or if you'd like to go ahead. Thanks, ${businessName}`;
    case "review_request":
      return `${greeting} thanks again for choosing ${businessName}.${detail} If you were happy with the work, I'd really appreciate a quick Google review. ${reviewUrl ? reviewUrl : "[Add your Google review link]"} Thanks for your support.`;
    case "appointment":
      return `${greeting} just confirming your upcoming appointment.${detail} If anything changes, please let me know. Thanks, ${businessName}`;
    default:
      return `${greeting}${detail || " thanks for getting in touch."} If you have any questions, just let me know. Thanks, ${businessName}`;
  }
}

async function aiGenerate(
  env: Env,
  kind: SmartKind,
  roughNotes: string,
  businessName: string,
  clientName: string | null,
  reviewUrl: string | null
): Promise<string | null> {
  if (!env.AI) return null;

  const prompt = [
    "Write one concise customer-facing message for an Australian small business.",
    "Purpose: " + LABELS[kind] + ".",
    "Business: " + businessName + ".",
    clientName ? "Customer first name/name: " + clientName + "." : "",
    reviewUrl && kind === "review_request" ? "Google review link: " + reviewUrl + "." : "",
    "Rough notes: " + roughNotes,
    "Keep it warm, clear and practical. Do not invent facts, prices, dates, names or promises.",
    "Use Australian English. No subject line. No markdown. Return only the message."
  ].filter(Boolean).join("\n");

  try {
    const result = await env.AI.run(
      "@cf/zai-org/glm-4.7-flash",
      {
        messages: [
          { role: "system", content: "You rewrite rough small-business notes into short, natural customer messages." },
          { role: "user", content: prompt }
        ],
        max_tokens: 260,
        temperature: 0.35
      } as never
    ) as unknown;

    if (typeof result === "object" && result !== null && "response" in result) {
      const response = (result as { response?: unknown }).response;
      if (typeof response === "string" && response.trim()) return response.trim().slice(0, 4000);
    }
  } catch (error) {
    console.error("ClientStream Smart Write AI fallback", error);
  }

  return null;
}

export async function smartWriteUsage(request: Request, env: Env): Promise<Response> {
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;

  const used = await usageForMonth(env, business.id);
  const limit = PLAN_CATALOG[business.plan].limits.smartWriteGenerationsPerMonth;
  return json({ used, limit, remaining: Math.max(0, limit - used), aiAvailable: Boolean(env.AI) });
}

export async function smartWrite(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) return json({ error: "Origin not allowed." }, { status: 403 });

  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;

  const limited = await enforceAiRateLimit(business.id, env);
  if (limited) return limited;

  const body = await readJson<{
    kind?: unknown;
    roughNotes?: unknown;
    clientName?: unknown;
  }>(request);

  const allowed = new Set<SmartKind>(["follow_up", "payment_reminder", "review_request", "appointment", "general"]);
  const kind = typeof body?.kind === "string" && allowed.has(body.kind as SmartKind)
    ? body.kind as SmartKind
    : "general";
  const roughNotes = typeof body?.roughNotes === "string" ? body.roughNotes.trim().slice(0, 2000) : "";
  const clientName = textValue(body?.clientName, 160);

  if (!roughNotes && kind !== "review_request") {
    return json({ error: "Add a few rough notes so Smart Write knows what to say." }, { status: 400 });
  }

  const used = await usageForMonth(env, business.id);
  const limit = PLAN_CATALOG[business.plan].limits.smartWriteGenerationsPerMonth;
  if (used >= limit) {
    return json({ error: "Smart Write monthly limit reached.", code: "PLAN_LIMIT", limit }, { status: 402 });
  }

  const profile = await env.DB.prepare(
    "SELECT name, google_review_url FROM businesses WHERE id = ? LIMIT 1"
  ).bind(business.id).first<{ name: string; google_review_url: string | null }>();

  const businessName = profile?.name ?? business.name;
  const reviewUrl = profile?.google_review_url ?? null;
  const aiText = await aiGenerate(env, kind, roughNotes, businessName, clientName, reviewUrl);
  const message = aiText ?? fallback(kind, roughNotes, businessName, clientName, reviewUrl);
  const now = new Date().toISOString();

  await env.DB.prepare(
    "INSERT INTO ai_usage (id, business_id, user_id, feature, units, occurred_at) VALUES (?, ?, ?, ?, 1, ?)"
  ).bind(crypto.randomUUID(), business.id, context.user.id, "smart_write:" + kind, now).run();

  return json({
    message,
    usedAI: Boolean(aiText),
    usage: {
      used: used + 1,
      limit,
      remaining: Math.max(0, limit - used - 1)
    }
  });
}
