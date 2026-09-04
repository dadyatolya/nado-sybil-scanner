// Small pure query-param parsers. Kept separate from server.js (which calls
// server.listen() at module scope) so they can be unit-tested without
// spinning up an actual HTTP server.

/** Parses a "lookback window" query param. Accepts:
 *  - "all" (or "0") -> { hours: null, isAll: true }  meaning "no lower time
 *    bound at all — scan back as far as the time/page budget allows."
 *  - a positive integer string -> { hours: n, isAll: false }
 *  - anything else (missing, garbage) -> { hours: fallback, isAll: false }
 */
export function parseHoursParam(value, fallback) {
  if (value === "all" || value === "0") {
    return { hours: null, isAll: true };
  }
  const n = Number.parseInt(value, 10);
  if (Number.isFinite(n) && n > 0) {
    return { hours: n, isAll: false };
  }
  return { hours: fallback, isAll: false };
}

export function parseIntParam(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function parseProductIds(value) {
  if (!value) return undefined;
  const ids = value
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter(Number.isFinite);
  return ids.length ? ids : undefined;
}
