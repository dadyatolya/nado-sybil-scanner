// Nado's engine (Vertex-style Clearinghouse/Endpoint architecture) reports
// balances/prices/fills internally as X18 fixed point strings, regardless of
// the underlying token's real decimals. This converts those signed decimal
// strings to JS numbers safely (values fit well within Number precision once
// scaled down from 1e18 — we only lose sub-cent precision, which is fine for
// clustering heuristics, never used for anything financial/authoritative).

const SCALE = 1_000_000_000_000_000_000n; // 1e18

export function x18ToNumber(value) {
  if (value === null || value === undefined) return 0;
  const s = String(value).trim();
  if (s === "" || s === "0") return 0;
  try {
    const neg = s.startsWith("-");
    const digits = neg ? s.slice(1) : s;
    if (!/^\d+$/.test(digits)) return Number(s) / 1e18; // fallback for non-bigint-safe input
    const big = BigInt(digits);
    const whole = big / SCALE;
    const frac = big % SCALE;
    const num = Number(whole) + Number(frac) / 1e18;
    return neg ? -num : num;
  } catch {
    const n = Number(s);
    return Number.isFinite(n) ? n / 1e18 : 0;
  }
}

// Blockscout token amounts come as raw integer strings scaled by the token's
// on-chain `decimals` (USDT0 is 6 decimals, like USDT).
export function rawToNumber(value, decimals) {
  if (value === null || value === undefined) return 0;
  try {
    const big = BigInt(String(value));
    const scale = 10n ** BigInt(decimals);
    const whole = big / scale;
    const frac = big % scale;
    return Number(whole) + Number(frac) / Number(scale);
  } catch {
    const n = Number(value);
    return Number.isFinite(n) ? n / 10 ** decimals : 0;
  }
}

export function sign(n) {
  if (n > 0) return 1;
  if (n < 0) return -1;
  return 0;
}

// Relative difference used everywhere for the "±5%" tolerance checks:
// symmetric, always in [0, ...], comparing against the larger magnitude.
export function relDiff(a, b) {
  const ma = Math.abs(a);
  const mb = Math.abs(b);
  const denom = Math.max(ma, mb);
  if (denom === 0) return 0;
  return Math.abs(ma - mb) / denom;
}
