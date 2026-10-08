import type { Env } from "./types";
import { brandedEmail, emailConfigured, sendEmail } from "./email";

function weekStart(value = new Date()): string {
  const date = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
}

function reminderPayload(title: string, note: string): string {
  return JSON.stringify({ title, note });
}

async function cleanupExpiredSecurityRecords(env: Env, now: string): Promise<void> {
  const tokenCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const webhookCutoff = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();

  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
    env.DB.prepare(
      "DELETE FROM login_tokens WHERE (expires_at <= ? OR consumed_at IS NOT NULL) AND created_at < ?"
    ).bind(now, tokenCutoff),
    env.DB.prepare(
      "DELETE FROM square_webhook_events WHERE received_at < ? AND status IN ('processed','ignored')"
    ).bind(webhookCutoff)
  ]);
}

async function refreshDocumentStates(env: Env, now: string): Promise<void> {
  const today = now.slice(0, 10);
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE invoices SET status = 'overdue', updated_at = ? WHERE status IN ('sent','part_paid') AND due_at IS NOT NULL AND substr(due_at,1,10) < ? AND amount_paid_cents < total_cents"
    ).bind(now, today),
    env.DB.prepare(
      "UPDATE quotes SET status = 'expired', updated_at = ? WHERE status = 'sent' AND expires_at IS NOT NULL AND substr(expires_at,1,10) < ?"
    ).bind(now, today)
  ]);
}

async function createAutomaticReminders(env: Env, now: string): Promise<void> {
  const today = now.slice(0, 10);
  const week = weekStart(new Date(now));
  const in24Hours = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const reviewFrom = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const reviewTo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();

  const overdue = await env.DB.prepare(
    "SELECT i.id, i.business_id, i.client_id, i.number, i.due_at, i.total_cents, i.amount_paid_cents, c.name AS client_name FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.status = 'overdue' AND i.amount_paid_cents < i.total_cents LIMIT 200"
  ).all<{
    id: string;
    business_id: string;
    client_id: string;
    number: string;
    due_at: string | null;
    total_cents: number;
    amount_paid_cents: number;
    client_name: string;
  }>();

  const upcomingJobs = await env.DB.prepare(
    "SELECT j.id, j.business_id, j.client_id, j.title, j.scheduled_for, c.name AS client_name FROM jobs j LEFT JOIN clients c ON c.id = j.client_id WHERE j.status IN ('planned','active') AND j.scheduled_for > ? AND j.scheduled_for <= ? LIMIT 200"
  ).bind(now, in24Hours).all<{
    id: string;
    business_id: string;
    client_id: string | null;
    title: string;
    scheduled_for: string;
    client_name: string | null;
  }>();

  const reviewJobs = await env.DB.prepare(
    "SELECT j.id, j.business_id, j.client_id, j.title, j.completed_at, c.name AS client_name FROM jobs j JOIN businesses b ON b.id = j.business_id LEFT JOIN clients c ON c.id = j.client_id WHERE j.status = 'completed' AND j.completed_at >= ? AND j.completed_at <= ? AND b.google_review_url IS NOT NULL LIMIT 200"
  ).bind(reviewFrom, reviewTo).all<{
    id: string;
    business_id: string;
    client_id: string | null;
    title: string;
    completed_at: string | null;
    client_name: string | null;
  }>();

  const statements: D1PreparedStatement[] = [];

  for (const invoice of overdue.results ?? []) {
    const outstanding = Math.max(0, invoice.total_cents - invoice.amount_paid_cents);
    statements.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO reminders (id, business_id, client_id, invoice_id, kind, status, scheduled_for, payload_json, created_at, dedupe_key) VALUES (?, ?, ?, ?, 'payment', 'pending', ?, ?, ?, ?)"
      ).bind(
        crypto.randomUUID(),
        invoice.business_id,
        invoice.client_id,
        invoice.id,
        now,
        reminderPayload(
          "Follow up " + invoice.number,
          invoice.client_name + " has " + (outstanding / 100).toFixed(2) + " AUD outstanding" + (invoice.due_at ? " (due " + invoice.due_at.slice(0, 10) + ")" : "") + "."
        ),
        now,
        "overdue:" + invoice.id + ":" + week
      )
    );
  }

  for (const job of upcomingJobs.results ?? []) {
    statements.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO reminders (id, business_id, client_id, kind, status, scheduled_for, payload_json, created_at, dedupe_key) VALUES (?, ?, ?, 'job', 'pending', ?, ?, ?, ?)"
      ).bind(
        crypto.randomUUID(),
        job.business_id,
        job.client_id,
        now,
        reminderPayload(
          "Upcoming job: " + job.title,
          (job.client_name ? job.client_name + " · " : "") + "Scheduled " + job.scheduled_for
        ),
        now,
        "job:" + job.id + ":" + job.scheduled_for.slice(0, 10)
      )
    );
  }

  for (const job of reviewJobs.results ?? []) {
    statements.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO reminders (id, business_id, client_id, kind, status, scheduled_for, payload_json, created_at, dedupe_key) VALUES (?, ?, ?, 'review', 'pending', ?, ?, ?, ?)"
      ).bind(
        crypto.randomUUID(),
        job.business_id,
        job.client_id,
        now,
        reminderPayload(
          "Ask for a review",
          (job.client_name ? "Follow up with " + job.client_name + " after " : "Follow up after ") + job.title + "."
        ),
        now,
        "review:" + job.id
      )
    );
  }

  if (statements.length) await env.DB.batch(statements);

  // Avoid an unused-variable lint/type issue while keeping the date visible in logs.
  console.log("ClientStream automatic reminder sweep", { today, overdue: overdue.results?.length ?? 0, jobs: upcomingJobs.results?.length ?? 0, reviews: reviewJobs.results?.length ?? 0 });
}

async function emailDueReminders(env: Env, now: string): Promise<void> {
  if (!emailConfigured(env)) return;

  const result = await env.DB.prepare(
    "SELECT r.id, r.payload_json, r.kind, r.scheduled_for, u.email, u.email_verified_at, b.name AS business_name FROM reminders r JOIN businesses b ON b.id = r.business_id JOIN users u ON u.id = b.owner_user_id WHERE b.owner_reminder_email_enabled = 1 AND r.status = 'pending' AND r.scheduled_for <= ? AND r.notified_at IS NULL ORDER BY r.scheduled_for ASC LIMIT 50"
  ).bind(now).all<{
    id: string;
    payload_json: string | null;
    kind: string;
    scheduled_for: string;
    email: string;
    email_verified_at: string | null;
    business_name: string;
  }>();

  for (const row of result.results ?? []) {
    if (!row.email_verified_at) continue;

    let title = "ClientStream reminder";
    let note = "You have something that needs attention in ClientStream.";
    try {
      const payload = JSON.parse(row.payload_json ?? "{}") as { title?: unknown; note?: unknown };
      if (typeof payload.title === "string" && payload.title) title = payload.title;
      if (typeof payload.note === "string" && payload.note) note = payload.note;
    } catch {}

    try {
      await sendEmail(env, {
        to: row.email,
        subject: title + " · " + row.business_name,
        html: brandedEmail(title, note, env.PUBLIC_APP_URL ? "Open ClientStream" : undefined, env.PUBLIC_APP_URL),
        text: title + "\n\n" + note + (env.PUBLIC_APP_URL ? "\n\n" + env.PUBLIC_APP_URL : "")
      });
      await env.DB.prepare(
        "UPDATE reminders SET notified_at = ? WHERE id = ? AND notified_at IS NULL"
      ).bind(now, row.id).run();
    } catch (error) {
      console.error("ClientStream reminder email failed", row.id, error);
    }
  }
}

export async function runMaintenance(env: Env): Promise<void> {
  const now = new Date().toISOString();
  await cleanupExpiredSecurityRecords(env, now);
  await refreshDocumentStates(env, now);
  await createAutomaticReminders(env, now);
  await emailDueReminders(env, now);
}
