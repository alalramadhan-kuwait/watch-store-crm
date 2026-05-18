/**
 * Format a KD amount, trimming insignificant trailing zeros.
 * 980.000 → "980"   45.500 → "45.5"   35.755 → "35.755"
 */
export function formatKD(amount: number): string {
  return amount.toFixed(3).replace(/(\.\d*[1-9])0+$/, '$1').replace(/\.0+$/, '');
}

/**
 * Compact format for tight KPI tiles.
 * Rounds to whole KD once the total hits 100 so the number always fits.
 * 1165.5 → "1,166"   980.0 → "980"   45.5 → "45.5"
 */
export function formatKDCompact(amount: number): string {
  if (amount >= 1000) {
    return Math.round(amount).toLocaleString('en-US');
  }
  if (amount >= 100) {
    return String(Math.round(amount));
  }
  return formatKD(amount);
}
