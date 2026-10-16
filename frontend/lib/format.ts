import type { OrderStatus, StepKey } from "./types";

export const STEP_LABELS: Record<StepKey, string> = {
  design_review: "Design Review",
  printing: "3D Printing",
  post_processing: "Post-processing",
  quality_inspection: "Quality Inspection",
  final_release: "Final Release",
};
export const STEP_ORDER: StepKey[] = [
  "design_review", "printing", "post_processing", "quality_inspection", "final_release",
];

export const STATUS_LABELS: Record<OrderStatus, string> = {
  new: "New",
  in_production: "In production",
  awaiting_qc: "Awaiting QC",
  qc_failed: "QC failed",
  ready_for_release: "Ready for release",
  released: "Released",
};

// Times come from the API in UTC. They are shown in the time zone the administrator configured (APP_TIMEZONE).
let displayTimeZone: string | undefined;
export function setDisplayTimeZone(timeZone: string) {
  displayTimeZone = timeZone;
}
export function getDisplayTimeZone(): string {
  return displayTimeZone ?? "UTC";
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: displayTimeZone,
  });
}

/** "Fri 17 Oct, 09:00" in the configured time zone. */
export function formatPlanTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: getDisplayTimeZone(),
  });
}

function zoneParts(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** How far ahead of UTC the time zone is at this moment, in minutes. */
function offsetMinutes(instant: Date, timeZone: string): number {
  const p = zoneParts(instant, timeZone);
  return (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant.getTime()) / 60000;
}

/** "2026-10-20T09:00" typed as local time in `timeZone` -> the matching UTC instant as an ISO string. */
export function zonedInputToUtcIso(local: string, timeZone: string): string {
  const [date, time] = local.split("T");
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const wallClockAsUtc = Date.UTC(y, mo - 1, d, h, mi);
  let utc = wallClockAsUtc - offsetMinutes(new Date(wallClockAsUtc), timeZone) * 60000;
  utc = wallClockAsUtc - offsetMinutes(new Date(utc), timeZone) * 60000; // once more, for daylight-saving changes
  return new Date(utc).toISOString();
}

/** A UTC instant -> "2026-10-20T09:00" in `timeZone`, for a datetime-local input. */
export function utcToZonedInput(iso: string, timeZone: string): string {
  const p = zoneParts(new Date(iso), timeZone);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${two(p.month)}-${two(p.day)}T${two(p.hour)}:${two(p.minute)}`;
}

export function formatNumber(value: number): string {
  return value.toLocaleString();
}

/** "1,200 g": a quantity with its unit, always written the same way. */
export function formatQty(value: number, unit: string): string {
  return `${value.toLocaleString()} ${unit}`;
}
