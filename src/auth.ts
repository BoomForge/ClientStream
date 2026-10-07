import type { AuthContext, BusinessContext, Env, PlanId } from "./types";
import {
  constantTimeEqual,
  fromBase64,
  json,
  mutationOriginIsAllowed,
  normaliseEmail,
  parseCookies,
  randomToken,
  readJson,
  sha256Hex,
  slugify,
  toBase64,
  validEmail
} from "./http";

const SESSION_COOKIE = "cs_session";
const SESSION_SECONDS = 60 * 60 * 24 * 30;
const PASSWORD_ITERATIONS = 120_000;

function sessionCookie(token: string, maxAge = SESSION_SECONDS): string {
  return [
    SESSION_COOKIE + "=" + encodeURIComponent(token),
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Max-Age=" + maxAge
  ].join("; ");
}

async function derivePassword(
  password: string,
  salt: Uint8Array,
  iterations: number
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations
    },
    key,
    256
  );
  return new Uint8Array(bits);
}

async function createSession(env: Env, userId: string): Promise<{ token: string; expiresAt: string }> {
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000).toISOString();
  const now = new Date().toISOString();

  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, user_id, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(tokenHash, userId, expiresAt, now, now).run();

  return { token, expiresAt };
}

export async function getAuthContext(request: Request, env: Env): Promise<AuthContext | null> {
  const rawToken = parseCookies(request)[SESSION_COOKIE];
  if (!rawToken || rawToken.length < 32) return null;

  const tokenHash = await sha256Hex(rawToken);
  const now = new Date().toISOString();

  const userRow = await env.DB.prepare(
    "SELECT u.id, u.email, u.display_name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? LIMIT 1"
  ).bind(tokenHash, now).first<{ id: string; email: string; display_name: string | null }>();

  if (!userRow) return null;

  const businessRow = await env.DB.prepare(
    "SELECT b.id, b.name, b.slug, b.plan, m.role FROM memberships m JOIN businesses b ON b.id = m.business_id WHERE m.user_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, b.created_at ASC LIMIT 1"
  ).bind(userRow.id).first<{
    id: string;
    name: string;
    slug: string;
    plan: PlanId;
    role: "owner" | "admin" | "member";
  }>();

  return {
    user: {
      id: userRow.id,
      email: normaliseEmail(userRow.email),
      displayName: userRow.display_name
    },
    business: businessRow
      ? {
          id: businessRow.id,
          name: businessRow.name,
          slug: businessRow.slug,
          plan: businessRow.plan,
          role: businessRow.role
        }
      : null
  };
}

export async function requireAuth(request: Request, env: Env): Promise<AuthContext | Response> {
  const context = await getAuthContext(request, env);
  return context ?? json({ error: "Authentication required." }, { status: 401 });
}

export function requireBusiness(context: AuthContext): BusinessContext | Response {
  return context.business ?? json(
    { error: "Business onboarding is required.", code: "BUSINESS_REQUIRED" },
    { status: 409 }
  );
}

export async function register(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) {
    return json({ error: "Origin not allowed." }, { status: 403 });
  }

  const body = await readJson<{
    email?: unknown;
    password?: unknown;
    displayName?: unknown;
    businessName?: unknown;
  }>(request);

  const email = typeof body?.email === "string" ? normaliseEmail(body.email) : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const displayName = typeof body?.displayName === "string" ? body.displayName.trim() : "";
  const businessName = typeof body?.businessName === "string" ? body.businessName.trim() : "";

  if (!validEmail(email)) return json({ error: "Enter a valid email address." }, { status: 400 });
  if (password.length < 10 || password.length > 128) {
    return json({ error: "Password must be between 10 and 128 characters." }, { status: 400 });
  }
  if (displayName.length < 1 || displayName.length > 80) {
    return json({ error: "Your name must be between 1 and 80 characters." }, { status: 400 });
  }
  if (businessName.length < 2 || businessName.length > 120) {
    return json({ error: "Business name must be between 2 and 120 characters." }, { status: 400 });
  }

  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ? COLLATE NOCASE LIMIT 1")
    .bind(email)
    .first<{ id: string }>();
  if (existing) return json({ error: "An account already exists for that email." }, { status: 409 });

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const passwordHash = await derivePassword(password, salt, PASSWORD_ITERATIONS);
  const userId = crypto.randomUUID();
  const businessId = crypto.randomUUID();
  const slug = slugify(businessName) + "-" + businessId.slice(0, 8);
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, email, display_name, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)"
    ).bind(userId, email, displayName, now, now),
    env.DB.prepare(
      "INSERT INTO password_credentials (user_id, password_hash, salt, iterations, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(userId, toBase64(passwordHash), toBase64(salt), PASSWORD_ITERATIONS, now, now),
    env.DB.prepare(
      "INSERT INTO businesses (id, name, slug, owner_user_id, plan, timezone, currency, created_at, updated_at) VALUES (?, ?, ?, ?, 'free', 'Australia/Hobart', 'AUD', ?, ?)"
    ).bind(businessId, businessName, slug, userId, now, now),
    env.DB.prepare(
      "INSERT INTO memberships (business_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)"
    ).bind(businessId, userId, now)
  ]);

  const session = await createSession(env, userId);

  return json(
    {
      user: { id: userId, email, displayName },
      business: { id: businessId, name: businessName, slug, plan: "free", role: "owner" }
    },
    {
      status: 201,
      headers: { "set-cookie": sessionCookie(session.token) }
    }
  );
}

export async function login(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) {
    return json({ error: "Origin not allowed." }, { status: 403 });
  }

  const body = await readJson<{ email?: unknown; password?: unknown }>(request);
  const email = typeof body?.email === "string" ? normaliseEmail(body.email) : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!validEmail(email) || !password) {
    return json({ error: "Invalid email or password." }, { status: 401 });
  }

  const row = await env.DB.prepare(
    "SELECT u.id, pc.password_hash, pc.salt, pc.iterations FROM users u JOIN password_credentials pc ON pc.user_id = u.id WHERE u.email = ? COLLATE NOCASE LIMIT 1"
  ).bind(email).first<{
    id: string;
    password_hash: string;
    salt: string;
    iterations: number;
  }>();

  if (!row) {
    return json({ error: "Invalid email or password." }, { status: 401 });
  }

  const salt = fromBase64(row.salt);
  const expected = fromBase64(row.password_hash);
  if (!salt || !expected) {
    return json({ error: "Invalid email or password." }, { status: 401 });
  }

  const actual = await derivePassword(password, salt, row.iterations);
  if (!constantTimeEqual(actual, expected)) {
    return json({ error: "Invalid email or password." }, { status: 401 });
  }

  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?")
    .bind(row.id, new Date().toISOString())
    .run();

  const session = await createSession(env, row.id);
  return json(
    { authenticated: true },
    { headers: { "set-cookie": sessionCookie(session.token) } }
  );
}

export async function logout(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) {
    return json({ error: "Origin not allowed." }, { status: 403 });
  }

  const rawToken = parseCookies(request)[SESSION_COOKIE];
  if (rawToken) {
    const tokenHash = await sha256Hex(rawToken);
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
  }

  return json(
    { authenticated: false },
    { headers: { "set-cookie": sessionCookie("", 0) } }
  );
}
