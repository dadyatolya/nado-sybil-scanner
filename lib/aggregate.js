// Glue layer: pulls raw events from Ink Explorer + Nado's Archive API for a
// given lookback window and turns them into the flat shapes lib/clusters.js
// expects. Every "scan" here is bounded (max pages + wall-clock budget) so a
// single request can't run forever on a serverless platform — if the budget
// runs out first, the response says so (`truncated: true`) rather than
// silently returning an incomplete-looking result.

import { NADO_CONTRACTS, walkTokenTransfers } from "./inkExplorer.js";
import { fetchMatches, discoverProductIds } from "./nadoClient.js";
import { normalizeMatchesResponse } from "./clusters.js";
import { rawToNumber } from "./fixedpoint.js";
import { addressFromSubaccount } from "./subaccount.js";

const DEFAULT_BUDGET_MS = 20_000;

// Used when the caller asks for "all time" (hours: null) instead of a fixed
// window. A genuinely complete scan of a DEX's entire history can mean
// walking thousands of paginated pages — more than fits in one HTTP
// request/response cycle. Rather than pretend that's instant, an all-time
// scan gets a bigger (but still bounded) budget and reports `truncated:
// true` + how far it actually got if it runs out before reaching genesis,
// so the UI can say "partial" instead of silently under-reporting. Both are
// env-overridable so this can be tuned after deploying without a code change.
const ALL_TIME_BUDGET_MS = Number(process.env.ALL_TIME_BUDGET_MS) || 50_000;
const ALL_TIME_MAX_PAGES = Number(process.env.ALL_TIME_MAX_PAGES) || 500;

function budgetGuard(startedAt, budgetMs) {
  return Date.now() - startedAt < budgetMs;
}

/** hours === null means "no lower time bound" (all time). */
function sinceTsFor(hours) {
  return hours == null ? 0 : Math.floor(Date.now() / 1000) - hours * 3600;
}

/** All incoming USDT0 transfers to Nado's Clearinghouse contract since
 * `hours` ago (or since genesis if `hours` is null), i.e. the global deposit
 * feed cluster #1 needs. */
export async function fetchGlobalDeposits({
  hours = 24,
  maxPages = hours == null ? ALL_TIME_MAX_PAGES : 25,
  budgetMs = hours == null ? ALL_TIME_BUDGET_MS : DEFAULT_BUDGET_MS,
} = {}) {
  const startedAt = Date.now();
  const sinceTs = sinceTsFor(hours);
  let truncated = false;

  const items = await walkTokenTransfers(NADO_CONTRACTS.clearinghouse, {
    maxPages,
    stopWhen: (item) => {
      if (!budgetGuard(startedAt, budgetMs)) {
        truncated = true;
        return true;
      }
      const ts = item.timestamp ? Math.floor(new Date(item.timestamp).getTime() / 1000) : null;
      return ts !== null && ts < sinceTs;
    },
  });
  if (items.hitMaxPages) truncated = true;

  const deposits = [];
  for (const item of items) {
    const tokenAddr = (item.token?.address || "").toLowerCase();
    if (tokenAddr && tokenAddr !== NADO_CONTRACTS.quoteToken) continue; // only the Nado quote asset
    const toAddr = (item.to?.hash || "").toLowerCase();
    if (toAddr !== NADO_CONTRACTS.clearinghouse) continue; // incoming only
    const ts = item.timestamp ? Math.floor(new Date(item.timestamp).getTime() / 1000) : null;
    if (ts === null || ts < sinceTs) continue;
    const decimals = Number(item.total?.decimals ?? item.token?.decimals ?? 6);
    const amount = rawToNumber(item.total?.value, decimals);
    const wallet = (item.from?.hash || "").toLowerCase();
    if (!wallet || !amount) continue;
    deposits.push({
      wallet,
      amount,
      timestamp: ts,
      evidence: { txHash: item.tx_hash, decimals },
    });
  }

  return { deposits, scanned: items.length, truncated, sinceTs };
}

/** Deposits for one specific wallet (still via the same global Clearinghouse
 * feed, just filtered — Blockscout doesn't let us ask "transfers from X to Y"
 * directly in one call without walking X's own history, which is what we do
 * here for the Checker/Dashboard per-wallet views). */
export async function fetchWalletDeposits(address, {
  hours = 24 * 30,
  maxPages = hours == null ? ALL_TIME_MAX_PAGES : 10,
} = {}) {
  const sinceTs = sinceTsFor(hours);
  const items = await walkTokenTransfers(address, {
    maxPages,
    stopWhen: (item) => {
      const ts = item.timestamp ? Math.floor(new Date(item.timestamp).getTime() / 1000) : null;
      return ts !== null && ts < sinceTs;
    },
  });
  return items
    .filter((item) => (item.to?.hash || "").toLowerCase() === NADO_CONTRACTS.clearinghouse)
    .map((item) => ({
      amount: rawToNumber(item.total?.value, Number(item.total?.decimals ?? item.token?.decimals ?? 6)),
      timestamp: item.timestamp ? Math.floor(new Date(item.timestamp).getTime() / 1000) : null,
      txHash: item.tx_hash,
    }));
}

let productCache = { ids: null, at: 0 };
const PRODUCT_CACHE_TTL_MS = 10 * 60 * 1000;

export async function getKnownProductIds() {
  if (productCache.ids && Date.now() - productCache.at < PRODUCT_CACHE_TTL_MS) {
    return productCache.ids;
  }
  const ids = await discoverProductIds({ maxId: 40 });
  productCache = { ids, at: Date.now() };
  return ids;
}

/** Global trade tape (fills) across the given products since `hours` ago (or
 * since genesis if `hours` is null), i.e. what cluster #2 (mirror trading)
 * scans. An all-time scan walks every known product's match history in
 * turn, so with many active markets it's the slowest of the two scans to
 * actually finish — expect `truncated: true` more often here than on the
 * deposit scan; that's the budget guard doing its job, not a bug. */
export async function fetchGlobalFills({
  hours = 6,
  productIds,
  maxPagesPerProduct = hours == null ? ALL_TIME_MAX_PAGES : 15,
  budgetMs = hours == null ? ALL_TIME_BUDGET_MS : DEFAULT_BUDGET_MS,
} = {}) {
  const startedAt = Date.now();
  const sinceTs = sinceTsFor(hours);
  const ids = productIds && productIds.length ? productIds : await getKnownProductIds();

  let truncated = false;
  const allFills = [];
  let scanned = 0;

  for (const productId of ids) {
    if (!budgetGuard(startedAt, budgetMs)) {
      truncated = true;
      break;
    }
    let idx;
    for (let page = 0; page < maxPagesPerProduct; page++) {
      if (!budgetGuard(startedAt, budgetMs)) {
        truncated = true;
        break;
      }
      let raw;
      try {
        raw = await fetchMatches({ productIds: [productId], idx, limit: 500 });
      } catch (err) {
        break; // product probably doesn't exist / endpoint hiccup — move on
      }
      const txs = raw?.txs || [];
      const matches = raw?.matches || [];
      scanned += matches.length;
      if (matches.length === 0) break;

      const fills = normalizeMatchesResponse(raw, { productLabel: productId });
      const inWindow = fills.filter((f) => f.timestamp >= sinceTs);
      allFills.push(...inWindow);

      const oldestTs = Math.min(...txs.map((t) => Number(t.timestamp)).filter(Number.isFinite));
      const oldestIdx = Math.min(...matches.map((m) => Number(m.submission_idx)).filter(Number.isFinite));
      if (!Number.isFinite(oldestTs) || oldestTs < sinceTs) break; // walked past the window
      idx = oldestIdx - 1;
      if (!Number.isFinite(idx) || idx < 0) break;
      if (page === maxPagesPerProduct - 1) {
        // loop is about to end naturally because the counter ran out, not
        // because any of the above conditions fired — this product's older
        // history is still out there, unscanned.
        truncated = true;
      }
    }
  }

  return { fills: allFills, scanned, truncated, sinceTs, productIds: ids };
}

/** Everything the Checker page needs for one address in one call: its own
 * deposit/trade activity plus whether it lands inside either cluster type
 * computed over the given window. */
const EMPTY_DEPOSITS = { deposits: [], scanned: 0, truncated: false, sinceTs: null, error: null };
const EMPTY_FILLS = { fills: [], scanned: 0, truncated: false, sinceTs: null, productIds: [], error: null };

// One upstream (Ink Explorer or Nado Archive) being down shouldn't take the
// whole Checker response down with it — each half degrades independently
// and carries its own `error` field so the UI can say exactly what failed.
export async function checkAddress(address, { depositHours = 24, mirrorHours = 6, productIds } = {}) {
  const lower = address.toLowerCase();
  const [globalDeposits, globalFills] = await Promise.all([
    fetchGlobalDeposits({ hours: depositHours }).catch((err) => ({ ...EMPTY_DEPOSITS, error: err.message })),
    fetchGlobalFills({ hours: mirrorHours, productIds }).catch((err) => ({ ...EMPTY_FILLS, error: err.message })),
  ]);
  return { globalDeposits, globalFills, wallet: lower };
}

export { addressFromSubaccount };
