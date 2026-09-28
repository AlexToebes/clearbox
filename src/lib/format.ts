/**
 * Small, dependency-free formatters shared by the dashboard (issue #6).
 * Kept framework-free so they're trivially unit-testable.
 */

const BYTE_UNITS = ["B", "KB", "MB", "GB"] as const;

/**
 * `1,024`-based byte formatting. Whole bytes are shown as an integer (a
 * fraction of a byte is never meaningful); KB/MB/GB round to one decimal.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) {
    return `${Math.round(bytes).toLocaleString()} B`;
  }

  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  return `${value.toFixed(1)} ${BYTE_UNITS[unitIndex]}`;
}

const compactFormatter = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** e.g. `12900` -> `"12.9K"`. */
export function formatCompact(value: number): string {
  return compactFormatter.format(value);
}

/**
 * `fraction` is a `0..1` share. Rounds to the nearest whole percent, but
 * never claims `0%` for a genuinely non-zero share — those round down to
 * `"<1%"` instead.
 */
export function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction) || fraction <= 0) {
    return "0%";
  }
  const rounded = Math.round(fraction * 100);
  if (rounded === 0) {
    return "<1%";
  }
  return `${rounded}%`;
}

const MONTH_NAMES_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const MONTH_NAMES_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/**
 * `month` is a `YYYY-MM` string (UTC, as `getMonthlyVolume` returns).
 * Short form: `"Mar '25"`. Long form (`long: true`): `"March 2025"`.
 * Parsed by splitting the string rather than `new Date(...)` so there's no
 * dependency on the host's local time zone.
 */
export function formatMonthLabel(month: string, long = false): string {
  const [yearStr = "", monthStr = ""] = month.split("-");
  const year = Number(yearStr);
  const monthIndex0 = Number(monthStr) - 1;

  if (long) {
    return `${MONTH_NAMES_LONG[monthIndex0]} ${year}`;
  }

  const shortYear = String(year % 100).padStart(2, "0");
  return `${MONTH_NAMES_SHORT[monthIndex0]} '${shortYear}`;
}
