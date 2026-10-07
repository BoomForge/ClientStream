import type { Env } from "./types";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export function emailConfigured(env: Env): boolean {
  return Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export async function sendEmail(env: Env, message: EmailMessage): Promise<{ id?: string }> {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
    throw new Error("Transactional email is not configured.");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: "Bearer " + env.RESEND_API_KEY,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text
    })
  });

  const body = await response.json() as {
    id?: string;
    message?: string;
    name?: string;
  };

  if (!response.ok) {
    throw new Error(body.message || body.name || "Email delivery failed.");
  }

  return { id: body.id };
}

export function brandedEmail(title: string, intro: string, actionLabel?: string, actionUrl?: string): string {
  const action = actionLabel && actionUrl
    ? `<p style="margin:28px 0"><a href="${escapeHtml(actionUrl)}" style="display:inline-block;background:#1e3a8a;color:#fff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:700">${escapeHtml(actionLabel)}</a></p>`
    : "";

  return `<!doctype html>
<html>
<body style="margin:0;background:#f7f9fc;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
  <div style="max-width:620px;margin:0 auto;padding:32px 18px">
    <div style="background:#fff;border:1px solid #dbe4ef;border-radius:18px;padding:30px">
      <div style="font-size:20px;font-weight:800;color:#1e3a8a;margin-bottom:26px">ClientStream</div>
      <h1 style="font-size:25px;line-height:1.2;margin:0 0 14px">${escapeHtml(title)}</h1>
      <p style="color:#5b677a;line-height:1.65;margin:0">${escapeHtml(intro)}</p>
      ${action}
      <p style="color:#94a3b8;font-size:12px;line-height:1.5;margin:28px 0 0">If you did not request this, you can ignore this email.</p>
    </div>
  </div>
</body>
</html>`;
}

export function moneyEmail(cents: number): string {
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD"
  }).format((Number(cents) || 0) / 100);
}
