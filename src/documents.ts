import type { Env } from "./types";
import { cents } from "./http";

export type DocumentType = "quote" | "invoice";
export type TaxMode = "none" | "gst10";

export interface ParsedDocumentItem {
  id: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

export function parseDocumentItems(rawItems: unknown): { items?: ParsedDocumentItem[]; error?: string } {
  if (!Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > 50) {
    return { error: "Add between 1 and 50 line items." };
  }

  const items: ParsedDocumentItem[] = [];
  for (const raw of rawItems) {
    if (!raw || typeof raw !== "object") return { error: "A line item is invalid." };
    const item = raw as Record<string, unknown>;
    const description = typeof item.description === "string" ? item.description.trim().slice(0, 500) : "";
    const quantity = typeof item.quantity === "number" && Number.isFinite(item.quantity) ? item.quantity : 0;
    const unitPriceCents = cents(item.unitPriceCents);

    if (!description || quantity <= 0 || quantity > 100000 || unitPriceCents === null) {
      return { error: "Each line item needs a description, quantity and valid price." };
    }

    items.push({
      id: crypto.randomUUID(),
      description,
      quantity,
      unitPriceCents,
      lineTotalCents: Math.round(quantity * unitPriceCents)
    });
  }

  return { items };
}

export function documentTotals(items: ParsedDocumentItem[], taxMode: TaxMode): {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
} {
  const subtotalCents = items.reduce((sum, item) => sum + item.lineTotalCents, 0);
  const taxCents = taxMode === "gst10" ? Math.round(subtotalCents * 0.1) : 0;
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}

export function taxModeFrom(value: unknown, gstRegistered = false): TaxMode {
  if (value === "gst10") return "gst10";
  if (value === "none") return "none";
  return gstRegistered ? "gst10" : "none";
}

export async function nextDocumentNumber(
  env: Env,
  businessId: string,
  type: DocumentType
): Promise<string> {
  const year = new Date().getUTCFullYear();

  await env.DB.prepare(
    "INSERT OR IGNORE INTO document_sequences (business_id, document_type, calendar_year, next_number) VALUES (?, ?, ?, 1)"
  ).bind(businessId, type, year).run();

  const row = await env.DB.prepare(
    "UPDATE document_sequences SET next_number = next_number + 1 WHERE business_id = ? AND document_type = ? AND calendar_year = ? RETURNING next_number - 1 AS number"
  ).bind(businessId, type, year).first<{ number: number }>();

  if (!row?.number) throw new Error("Unable to allocate document number.");

  const prefix = type === "invoice" ? "INV" : "QTE";
  return prefix + "-" + year + "-" + String(row.number).padStart(4, "0");
}
