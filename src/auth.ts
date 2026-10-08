import { derivePassword } from "./password-crypto";
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
import { brandedEmail, emailConfigured, sendEmail } from "./email";

const SESSION_COOKIE = "cs_session";
const SESSION_SECONDS = 60 * 60 * 24 * 30;
// The live Cloudflare PBKDF2 implementation rejects iteration counts above 100,000.
// Keep per-row counts for backward-compatible verification and upgrade-on-login.
const PASSWORD_ITERATIONS = 100_000;
const RESET_TOKEN_SECONDS = 60 * 30;
const VERIFY_TOKEN_SECONDS = 60 * 60 * 24;
const TOKEN_RESEND_SECONDS = 120;

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

export async function verifyUserPassword(env: Env, userId: string, password: string): Promise<boolean> {
  if (!password || password.length > 128) return false;

  const row = await env.DB.prepare(
    "SELECT password_hash, salt, iterations FROM password_credentials WHERE user_id = ? LIMIT 1"
  ).bind(userId).first<{ password_hash: string; salt: string; iterations: number }>();

  if (!row) return false;
  const salt = fromBase64(row.salt);
  const expected = fromBase64(row.password_hash);
  if (!salt || !expected) return false;

  const actual = await derivePassword(password, salt, row.iterations);
  if (!constantTimeEqual(actual, expected)) return false;
  await upgradePasswordHash(env, userId, password, row);
  return true;
}

// Upgrade only older credentials after successful authentication. The stored iteration
// count remains authoritative for verification; existing credentials stay compatible.
async function upgradePasswordHash(
  env: Env,
  userId: string,
  password: string,
  row: { password_hash: string; salt: string; iterations: number }
): Promise<void> {
  if (row.iterations >= PASSWORD_ITERATIONS) return;
  try {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await derivePassword(password, salt, PASSWORD_ITERATIONS);
    await env.DB.prepare(
      "UPDATE password_credentials SET password_hash = ?, salt = ?, iterations = ?, updated_at = ? WHERE user_id = ? AND password_hash = ? AND iterations = ?"
    ).bind(toBase64(hash), toBase64(salt), PASSWORD_ITERATIONS, new Date().toISOString(),
      userId, row.password_hash, row.iterations).run();
  } catch (error) {
    // A transient upgrade failure must not lock out a user with valid credentials.
    console.error("ClientStream password hash upgrade failed", error);
  }
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

async function tokenRecentlyIssued(env: Env, userId: string, tokenType: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - TOKEN_RESEND_SECONDS * 1000).toISOString();
  const row = await env.DB.prepare(
    "SELECT token_hash FROM login_tokens WHERE user_id = ? AND token_type = ? AND created_at > ? AND consumed_at IS NULL LIMIT 1"
  ).bind(userId, tokenType, cutoff).first<{ token_hash: string }>();
  return Boolean(row);
}

async function issueToken(
  env: Env,
  userId: string,
  tokenType: "password_reset" | "email_verification",
  lifetimeSeconds: number
): Promise<string | null> {
  if (await tokenRecentlyIssued(env, userId, tokenType)) return null;

  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + lifetimeSeconds * 1000).toISOString();

  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM login_tokens WHERE user_id = ? AND token_type = ? AND (consumed_at IS NOT NULL OR expires_at <= ?)"
    ).bind(userId, tokenType, now),
    env.DB.prepare(
      "INSERT INTO login_tokens (token_hash, user_id, expires_at, consumed_at, created_at, token_type) VALUES (?, ?, ?, NULL, ?, ?)"
    ).bind(tokenHash, userId, expiresAt, now, tokenType)
  ]);

  return token;
}

function publicAppOrigin(request: Request, env: Env): string {
  const configured = env.PUBLIC_APP_URL?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === "https:") return url.origin;
    } catch {}
  }
  return new URL(request.url).origin;
}

async function sendVerificationEmail(
  env: Env,
  userId: string,
  email: string,
  origin: string
): Promise<boolean> {
  if (!emailConfigured(env)) return false;
  const token = await issueToken(env, userId, "email_verification", VERIFY_TOKEN_SECONDS);
  if (!token) return false;

  const url = origin + "/?verify=" + encodeURIComponent(token);
  await sendEmail(env, {
    to: email,
    subject: "Verify your ClientStream email",
    html: brandedEmail(
      "Verify your email",
      "Confirm this email address for your ClientStream account. This verification link expires in 24 hours.",
      "Verify email",
      url
    ),
    text: "Verify your ClientStream email: " + url
  });
  return true;
}

export async function getAuthContext(request: Request, env: Env): Promise<AuthContext | null> {
  const rawToken = parseCookies(request)[SESSION_COOKIE];
  if (!rawToken || rawToken.length < 32) return null;

  const tokenHash = await sha256Hex(rawToken);
  const now = new Date().toISOString();

  const userRow = await env.DB.prepare(
    "SELECT u.id, u.email, u.display_name, u.email_verified_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? LIMIT 1"
  ).bind(tokenHash, now).first<{
    id: string;
    email: string;
    display_name: string | null;
    email_verified_at: string | null;
  }>();

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
      displayName: userRow.display_name,
      emailVerified: Boolean(userRow.email_verified_at)
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

function registrationFailure(code: string): Response {
  return json(
    { error: "We couldn't create the account. Please try again.", code },
    { status: 500 }
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

  let existing: { id: string } | null = null;
  try {
    existing = await env.DB.prepare("SELECT id FROM users WHERE email = ? COLLATE NOCASE LIMIT 1")
      .bind(email)
      .first<{ id: string }>();
  } catch (error) {
    console.error("ClientStream registration lookup failed", error);
    return registrationFailure("REGISTER_LOOKUP_FAILED");
  }
  if (existing) return json({ error: "An account already exists for that email." }, { status: 409 });

  const salt = crypto.getRandomValues(new Uint8Array(16));
  let passwordHash: Uint8Array;
  try {
    passwordHash = await derivePassword(password, salt, PASSWORD_ITERATIONS);
  } catch (error) {
    console.error("ClientStream registration password derivation failed", error);
    return registrationFailure("REGISTER_HASH_FAILED");
  }
  const userId = crypto.randomUUID();
  const businessId = crypto.randomUUID();
  const slug = slugify(businessName) + "-" + businessId.slice(0, 8);
  const now = new Date().toISOString();

  try {
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
  } catch (error) {
    console.error("ClientStream registration account write failed", error);
    return registrationFailure("REGISTER_WRITE_FAILED");
  }

  let session: { token: string; expiresAt: string };
  try {
    session = await createSession(env, userId);
  } catch (error) {
    console.error("ClientStream registration session creation failed", error);
    return registrationFailure("REGISTER_SESSION_FAILED");
  }
  let verificationSent = false;
  if (emailConfigured(env)) {
    try {
      verificationSent = await sendVerificationEmail(env, userId, email, publicAppOrigin(request, env));
    } catch (error) {
      console.error("ClientStream verification email failed", error);
    }
  }

  return json(
    {
      user: { id: userId, email, displayName, emailVerified: false },
      business: { id: businessId, name: businessName, slug, plan: "free", role: "owner" },
      verificationSent
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
  await upgradePasswordHash(env, row.id, password, row);

  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?")
    .bind(row.id, new Date().toISOString())
    .run();

  const session = await createSession(env, row.id);
  return json(
    { authenticated: true },
    { headers: { "set-cookie": sessionCookie(session.token) } }
  );
}

export async function changePassword(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) return json({ error: "Origin not allowed." }, { status: 403 });
  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const body = await readJson<{ currentPassword?: unknown; newPassword?: unknown }>(request);
  const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";
  if (newPassword.length < 10 || newPassword.length > 128)
    return json({ error: "New password must be between 10 and 128 characters." }, { status: 400 });
  if (!await verifyUserPassword(env, context.user.id, currentPassword))
    return json({ error: "Current password is incorrect." }, { status: 401 });
  if (currentPassword === newPassword)
    return json({ error: "Choose a different password." }, { status: 400 });

  const currentSession = parseCookies(request)[SESSION_COOKIE];
  if (!currentSession) return json({ error: "Sign in again and retry." }, { status: 401 });
  const tokenHash = await sha256Hex(currentSession);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePassword(newPassword, salt, PASSWORD_ITERATIONS);
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE password_credentials SET password_hash = ?, salt = ?, iterations = ?, updated_at = ? WHERE user_id = ?"
    ).bind(toBase64(hash), toBase64(salt), PASSWORD_ITERATIONS, new Date().toISOString(), context.user.id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?")
      .bind(context.user.id, tokenHash),
    env.DB.prepare("DELETE FROM login_tokens WHERE user_id = ? AND token_type = 'password_reset'")
      .bind(context.user.id)
  ]);
  return json({ changed: true, otherSessionsRevoked: true });
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

export async function requestPasswordReset(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) return json({ error: "Origin not allowed." }, { status: 403 });
  if (!emailConfigured(env)) {
    return json({ error: "Password recovery email is not configured yet." }, { status: 503 });
  }

  const body = await readJson<{ email?: unknown }>(request);
  const email = typeof body?.email === "string" ? normaliseEmail(body.email) : "";

  if (validEmail(email)) {
    const user = await env.DB.prepare(
      "SELECT id FROM users WHERE email = ? COLLATE NOCASE LIMIT 1"
    ).bind(email).first<{ id: string }>();

    if (user) {
      const token = await issueToken(env, user.id, "password_reset", RESET_TOKEN_SECONDS);
      if (token) {
        const url = publicAppOrigin(request, env) + "/?reset=" + encodeURIComponent(token);
        try {
          await sendEmail(env, {
            to: email,
            subject: "Reset your ClientStream password",
            html: brandedEmail(
              "Reset your password",
              "Use the button below to choose a new ClientStream password. This link expires in 30 minutes and can only be used once.",
              "Reset password",
              url
            ),
            text: "Reset your ClientStream password: " + url
          });
        } catch (error) {
          console.error("ClientStream reset email failed", error);
        }
      }
    }
  }

  return json({
    accepted: true,
    message: "If that email belongs to a ClientStream account, a reset link will be sent."
  }, { status: 202 });
}

export async function resetPassword(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) return json({ error: "Origin not allowed." }, { status: 403 });

  const body = await readJson<{ token?: unknown; password?: unknown }>(request);
  const token = typeof body?.token === "string" ? body.token : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (token.length < 32) return json({ error: "This reset link is invalid." }, { status: 400 });
  if (password.length < 10 || password.length > 128) {
    return json({ error: "Password must be between 10 and 128 characters." }, { status: 400 });
  }

  const tokenHash = await sha256Hex(token);
  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    "SELECT user_id FROM login_tokens WHERE token_hash = ? AND token_type = 'password_reset' AND consumed_at IS NULL AND expires_at > ? LIMIT 1"
  ).bind(tokenHash, now).first<{ user_id: string }>();

  if (!row) return json({ error: "This reset link is invalid or has expired." }, { status: 400 });

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const passwordHash = await derivePassword(password, salt, PASSWORD_ITERATIONS);

  await env.DB.batch([
    env.DB.prepare(
      "UPDATE password_credentials SET password_hash = ?, salt = ?, iterations = ?, updated_at = ? WHERE user_id = ?"
    ).bind(toBase64(passwordHash), toBase64(salt), PASSWORD_ITERATIONS, now, row.user_id),
    env.DB.prepare(
      "UPDATE login_tokens SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL"
    ).bind(now, tokenHash),
    env.DB.prepare(
      "DELETE FROM sessions WHERE user_id = ?"
    ).bind(row.user_id)
  ]);

  const session = await createSession(env, row.user_id);
  return json(
    { reset: true },
    { headers: { "set-cookie": sessionCookie(session.token) } }
  );
}

export async function sendVerification(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) return json({ error: "Origin not allowed." }, { status: 403 });
  if (!emailConfigured(env)) return json({ error: "Verification email is not configured yet." }, { status: 503 });

  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  if (context.user.emailVerified) return json({ verified: true, sent: false });

  const sent = await sendVerificationEmail(env, context.user.id, context.user.email, publicAppOrigin(request, env));
  return json({ verified: false, sent });
}

export async function verifyEmail(request: Request, env: Env): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) return json({ error: "Origin not allowed." }, { status: 403 });

  const body = await readJson<{ token?: unknown }>(request);
  const token = typeof body?.token === "string" ? body.token : "";
  if (token.length < 32) return json({ error: "This verification link is invalid." }, { status: 400 });

  const tokenHash = await sha256Hex(token);
  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    "SELECT user_id FROM login_tokens WHERE token_hash = ? AND token_type = 'email_verification' AND consumed_at IS NULL AND expires_at > ? LIMIT 1"
  ).bind(tokenHash, now).first<{ user_id: string }>();

  if (!row) return json({ error: "This verification link is invalid or has expired." }, { status: 400 });

  await env.DB.batch([
    env.DB.prepare(
      "UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?), updated_at = ? WHERE id = ?"
    ).bind(now, now, row.user_id),
    env.DB.prepare(
      "UPDATE login_tokens SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL"
    ).bind(now, tokenHash)
  ]);

  return json({ verified: true });
}
