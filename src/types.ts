export type PlanId = "free" | "pro";

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  APP_ENV?: string;
  SQUARE_WEBHOOK_SIGNATURE_KEY?: string;
  SQUARE_WEBHOOK_URL?: string;
  SQUARE_ACCESS_TOKEN?: string;
  SQUARE_LOCATION_ID?: string;
  SQUARE_PRO_PLAN_VARIATION_ID?: string;
  SQUARE_ENVIRONMENT?: "sandbox" | "production";
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  AI?: Ai;
  AUTH_RATE_LIMITER?: RateLimit;
  MUTATION_RATE_LIMITER?: RateLimit;
  AI_RATE_LIMITER?: RateLimit;
  PUBLIC_APP_URL?: string;
  SUPPORT_EMAIL?: string;
}

export interface SessionUser {
  id: string;
  email: string;
  displayName: string | null;
  emailVerified: boolean;
}

export interface BusinessContext {
  id: string;
  name: string;
  slug: string;
  plan: PlanId;
  role: "owner" | "admin" | "member";
}

export interface AuthContext {
  user: SessionUser;
  business: BusinessContext | null;
}

export const PLAN_CATALOG = {
  free: {
    id: "free",
    name: "Free",
    monthlyAudCents: 0,
    limits: {
      clients: 10,
      invoices: 10,
      smartWriteGenerationsPerMonth: 5
    }
  },
  pro: {
    id: "pro",
    name: "Pro",
    monthlyAudCents: 999,
    limits: {
      clients: null,
      invoices: null,
      smartWriteGenerationsPerMonth: 100
    }
  }
} as const;
