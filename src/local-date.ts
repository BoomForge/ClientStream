import type { Env } from "./types";

// Business date boundaries must not use UTC midnight (11am in Hobart during DST).
export function calendarDateInZone(now: Date, zone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone || "Australia/Hobart", year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(now);
    const read = (type: string) => parts.find((part) => part.type === type)?.value;
    const year = read("year"), month = read("month"), day = read("day");
    if (year && month && day) return year + "-" + month + "-" + day;
  } catch (error) {
    console.error("ClientStream invalid business timezone; using Australia/Hobart", error);
  }
  return calendarDateInZoneDefault(now);
}

function calendarDateInZoneDefault(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Australia/Hobart", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(now);
  const read = (type: string) => parts.find((part) => part.type === type)?.value;
  return read("year") + "-" + read("month") + "-" + read("day");
}

export async function businessToday(env: Env, businessId: string, now = new Date()): Promise<string> {
  const result = await env.DB.prepare("SELECT timezone FROM businesses WHERE id = ? LIMIT 1")
    .bind(businessId).first<{ timezone: string }>();
  return calendarDateInZone(now, result?.timezone || "Australia/Hobart");
}
