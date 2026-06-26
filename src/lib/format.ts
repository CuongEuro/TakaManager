// Formatting helpers. Default currency = JPY (no decimals).

export function formatJPY(value: number): string {
  return new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: 0,
  }).format(Math.round(value || 0));
}

export function formatNumber(value: number, digits = 0): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  }).format(value || 0);
}

export function formatPercent(fraction: number, digits = 1): string {
  return `${((fraction || 0) * 100).toFixed(digits)}%`;
}

export function formatMultiplier(value: number, digits = 2): string {
  if (!isFinite(value)) return "∞";
  return `${(value || 0).toFixed(digits)}x`;
}
