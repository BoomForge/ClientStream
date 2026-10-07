import type { Env } from "./types";
import { requireAuth, requireBusiness } from "./auth";
import { escapeHtml, emailConfigured, moneyEmail, sendEmail } from "./email";
import { json, mutationOriginIsAllowed, validEmail } from "./http";

type DocumentType = "quote" | "invoice";

interface DocumentRow {
  id: string;
  number: string;
  status: string;
  client_name: string;
  client_email: string | null;
  business_name: string;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  amount_paid_cents?: number;
  due_at?: string | null;
  expires_at?: string | null;
  notes?: string | null;
}

function documentId(pathname: string, type: DocumentType): string | null {
  const plural = type === "quote" ? "quotes" : "invoices";
  const match = pathname.match(new RegExp("^/api/" + plural + "/([^/]+)/send-email$"));
  return match ? decodeURIComponent(match[1]) : null;
}

function dateText(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value.length <= 10 ? value + "T00:00:00" : value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric"
  }).format(date);
}

function emailHtml(
  type: DocumentType,
  document: DocumentRow,
  items: Array<{ description: string; quantity: number; unit_price_cents: number }>
): string {
  const title = type === "quote" ? "Quote" : "Invoice";
  const dateLabel = type === "quote" ? "Expires" : "Due";
  const dateValue = type === "quote" ? document.expires_at : document.due_at;
  const rows = items.map((item) => {
    const lineTotal = Math.round(item.quantity * item.unit_price_cents);
    return `<tr>
      <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb">${escapeHtml(item.description)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;text-align:right">${escapeHtml(item.quantity)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;text-align:right">${escapeHtml(moneyEmail(item.unit_price_cents))}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:700">${escapeHtml(moneyEmail(lineTotal))}</td>
    </tr>`;
  }).join("");

  const paid = type === "invoice" && Number(document.amount_paid_cents) > 0
    ? `<div style="display:flex;justify-content:space-between;padding:5px 0"><span>Paid</span><strong>${escapeHtml(moneyEmail(document.amount_paid_cents ?? 0))}</strong></div>
       <div style="display:flex;justify-content:space-between;padding:9px 0;border-top:2px solid #1e3a8a;color:#1e3a8a"><span>Balance</span><strong>${escapeHtml(moneyEmail(Math.max(0, document.total_cents - (document.amount_paid_cents ?? 0))))}</strong></div>`
    : "";

  const notes = document.notes
    ? `<div style="margin-top:28px;padding-top:18px;border-top:1px solid #dbe4ef"><div style="font-size:12px;text-transform:uppercase;color:#64748b;letter-spacing:.06em">Notes</div><p style="white-space:pre-wrap;color:#5b677a;line-height:1.6">${escapeHtml(document.notes)}</p></div>`
    : "";

  return `<!doctype html>
<html>
<body style="margin:0;background:#f7f9fc;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
  <div style="max-width:720px;margin:0 auto;padding:28px 14px">
    <div style="background:#fff;border:1px solid #dbe4ef;border-radius:18px;padding:28px">
      <div style="display:flex;justify-content:space-between;gap:20px;align-items:flex-start;padding-bottom:22px;border-bottom:3px solid #1e3a8a">
        <div><strong style="font-size:20px;color:#1e3a8a">${escapeHtml(document.business_name)}</strong></div>
        <div style="text-align:right"><div style="color:#64748b;text-transform:uppercase;font-size:12px">${title}</div><strong style="color:#1e3a8a">${escapeHtml(document.number)}</strong></div>
      </div>
      <div style="display:flex;justify-content:space-between;gap:20px;margin:24px 0">
        <div><div style="font-size:12px;color:#64748b;text-transform:uppercase">For</div><strong>${escapeHtml(document.client_name)}</strong></div>
        <div style="text-align:right"><div style="font-size:12px;color:#64748b;text-transform:uppercase">${dateLabel}</div><strong>${escapeHtml(dateText(dateValue))}</strong></div>
      </div>
      <table style="width:100%;border-collapse:collapse">
        <thead><tr style="background:#e0f2fe;color:#1e3a8a">
          <th style="padding:10px 8px;text-align:left">Description</th>
          <th style="padding:10px 8px;text-align:right">Qty</th>
          <th style="padding:10px 8px;text-align:right">Unit</th>
          <th style="padding:10px 8px;text-align:right">Total</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div style="max-width:300px;margin:24px 0 0 auto">
        <div style="display:flex;justify-content:space-between;padding:5px 0"><span>Subtotal</span><strong>${escapeHtml(moneyEmail(document.subtotal_cents))}</strong></div>
        <div style="display:flex;justify-content:space-between;padding:5px 0"><span>Tax</span><strong>${escapeHtml(moneyEmail(document.tax_cents))}</strong></div>
        <div style="display:flex;justify-content:space-between;padding:9px 0;border-top:2px solid #1e3a8a;color:#1e3a8a"><span>Total</span><strong>${escapeHtml(moneyEmail(document.total_cents))}</strong></div>
        ${paid}
      </div>
      ${notes}
      <p style="margin-top:30px;color:#94a3b8;font-size:12px">Sent with ClientStream.</p>
    </div>
  </div>
</body>
</html>`;
}

async function sendDocument(request: Request, env: Env, type: DocumentType): Promise<Response> {
  if (!mutationOriginIsAllowed(request)) return json({ error: "Origin not allowed." }, { status: 403 });
  if (!emailConfigured(env)) return json({ error: "Email delivery is not configured yet." }, { status: 503 });

  const context = await requireAuth(request, env);
  if (context instanceof Response) return context;
  const business = requireBusiness(context);
  if (business instanceof Response) return business;

  if (business.plan !== "pro") {
    return json({ error: "Email delivery is a ClientStream Pro feature.", code: "PRO_REQUIRED" }, { status: 402 });
  }
  if (!context.user.emailVerified) {
    return json({ error: "Verify your account email before sending customer documents.", code: "EMAIL_VERIFICATION_REQUIRED" }, { status: 403 });
  }

  const id = documentId(new URL(request.url).pathname, type);
  if (!id) return json({ error: "Invalid document id." }, { status: 400 });

  const table = type === "quote" ? "quotes" : "invoices";
  const itemTable = type === "quote" ? "quote_items" : "invoice_items";
  const document = await env.DB.prepare(
    `SELECT d.id, d.number, d.status, c.name AS client_name, c.email AS client_email, b.name AS business_name,
            d.subtotal_cents, d.tax_cents, d.total_cents,
            ${type === "invoice" ? "d.amount_paid_cents" : "0 AS amount_paid_cents"},
            ${type === "invoice" ? "d.due_at" : "NULL AS due_at"},
            ${type === "quote" ? "d.expires_at" : "NULL AS expires_at"},
            d.notes
       FROM ${table} d
       JOIN clients c ON c.id = d.client_id
       JOIN businesses b ON b.id = d.business_id
      WHERE d.id = ? AND d.business_id = ?
      LIMIT 1`
  ).bind(id, business.id).first<DocumentRow>();

  if (!document) return json({ error: type === "quote" ? "Quote not found." : "Invoice not found." }, { status: 404 });
  if (!document.client_email || !validEmail(document.client_email)) {
    return json({ error: "Add a valid email address to this client before sending." }, { status: 400 });
  }

  const items = await env.DB.prepare(
    `SELECT description, quantity, unit_price_cents FROM ${itemTable} WHERE ${type === "quote" ? "quote_id" : "invoice_id"} = ? ORDER BY sort_order ASC`
  ).bind(id).all<{ description: string; quantity: number; unit_price_cents: number }>();

  const title = type === "quote" ? "Quote" : "Invoice";
  const result = await sendEmail(env, {
    to: document.client_email,
    subject: `${title} ${document.number} from ${document.business_name}`,
    html: emailHtml(type, document, items.results ?? []),
    text: `${title} ${document.number} from ${document.business_name}. Total: ${moneyEmail(document.total_cents)}.`
  });

  const now = new Date().toISOString();
  if (type === "quote") {
    await env.DB.prepare(
      "UPDATE quotes SET status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END, issued_at = COALESCE(issued_at, ?), updated_at = ? WHERE id = ? AND business_id = ?"
    ).bind(now, now, id, business.id).run();
  } else {
    await env.DB.prepare(
      "UPDATE invoices SET status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END, issued_at = COALESCE(issued_at, ?), updated_at = ? WHERE id = ? AND business_id = ?"
    ).bind(now, now, id, business.id).run();
  }

  await env.DB.prepare(
    "INSERT INTO audit_log (id, business_id, user_id, action, entity_type, entity_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    crypto.randomUUID(),
    business.id,
    context.user.id,
    "email.sent",
    type,
    id,
    JSON.stringify({ recipient: document.client_email, provider: "resend", messageId: result.id ?? null }),
    now
  ).run();

  return json({ sent: true, recipient: document.client_email });
}

export function sendQuoteEmail(request: Request, env: Env): Promise<Response> {
  return sendDocument(request, env, "quote");
}

export function sendInvoiceEmail(request: Request, env: Env): Promise<Response> {
  return sendDocument(request, env, "invoice");
}
