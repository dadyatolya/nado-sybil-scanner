// Glue layer: pulls raw events from Ink Explorer + Nado's Archive API for a
// given lookback window and turns them into the flat shapes lib/clusters.js
// expects. Every "scan" here is bounded (max pages + wall-clock budget) so a
// single request can't run forever on a serverless platform — if the budget
// runs out first, the response says so (`truncated: true`) rather than
// silently returning an incomplete-looking result.

import { NADO_CONTRACTS, walkTokenTransfers, fetchFirstFunder, fetchAddressInfo, isLikelyInfrastructure } from "./inkExplorer.js";
import { fetchOrders, fetchSymbols, discoverProductIds } from "./nadoClient.js";
import { normalizeOrdersResponse, findFundingFanOutClusters } from "./clusters.js";
import { rawToNumber } from "./fixedpoint.js";
import { addressFromSubaccount } from "./subaccount.js";
import { KNOWN_EXCHANGE_WALLETS } from "./exchangeWallets.js";

const DEFAULT_BUDGET_MS = 20_000;

// Used when the caller asks for "all time" (hours: null) instead of a fixed
// window. A genuinely complete scan of a DEX's entire history can mean
// walking thousands of paginated pages — far more than fits in a single HTTP
// request/response cycle. These calls are only ever made from a background
// job now (see lib/jobs.js + server.js's /api/scan/* routes) rather than
// directly inside a request handler, so the ceiling here only needs to guard
// against a genuinely runaway scan (a pagination bug, or Nado's history
// turning out to be far larger than expected) — not a platform request
// timeout. Still bounded, still reports `truncated: true` + how far it
// actually got if it runs out before reaching genesis, so the UI can say
// "partial" instead of silently under-reporting. Both env-overridable.
const ALL_TIME_BUDGET_MS = Number(process.env.ALL_TIME_BUDGET_MS) || 10 * 60_000; // 10 minutes
const ALL_TIME_MAX_PAGES = Number(process.env.ALL_TIME_MAX_PAGES) || 3000;

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
    // "All time" scans only ever run as background jobs now (lib/jobs.js) —
    // nothing is holding an HTTP request open waiting on them — so they can
    // afford to patiently retry through Ink Explorer's rate limiting
    // (confirmed live: a genesis-to-now walk of a busy contract runs into
    // it) instead of aborting the whole scan on the first 429. Bounded
    // windows stay on the quick/limited retry policy so a rate-limit blip
    // can't blow the budgets that keep them inside a platform request
    // timeout.
    patient: hours == null,
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
  // Real "list all markets" endpoint first (v2 REST /symbols, confirmed via
  // docs.nado.xyz); only fall back to the old brute-force oracle-price probe
  // if that ever fails or comes back empty (API change, transient outage).
  let ids = [];
  try {
    const symbols = await fetchSymbols();
    ids = symbols.map((s) => s.productId).filter(Number.isFinite);
  } catch {
    ids = [];
  }
  if (!ids.length) {
    ids = await discoverProductIds({ maxId: 40 });
  }
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
  // Distinguish "the /orders endpoint answered but had nothing" from "the
  // /orders endpoint never answered at all" — the two look identical from
  // `allFills.length === 0` alone, but only the first one is a genuine
  // "no mirror-trading activity found" result. As of the first production
  // run against real Nado infra, /orders 404s at every documented base URL
  // (see README's "Debugging live API assumptions" section), so this branch
  // is not theoretical — it is the observed current state.
  let requestsAttempted = 0;
  let requestsFailed = 0;
  let lastError = null;

  // Fail-fast canary: /orders being down is an endpoint-wide outage, not a
  // per-product quirk (confirmed by the matrix probe — it 404s identically
  // regardless of product_id). Looping through all ~90 known markets before
  // discovering that wastes ~90 sequential HTTP round trips and is slow
  // enough to blow past request timeouts on both the browser and this app's
  // own hosting — exactly what happened the first time this ran against
  // real infra. One probe call settles it up front.
  if (ids.length) {
    requestsAttempted++;
    try {
      await fetchOrders({ productIds: [ids[0]], limit: 1 });
    } catch (err) {
      requestsFailed++;
      lastError = err.message;
      return {
        fills: [],
        scanned: 0,
        truncated: false,
        sinceTs,
        productIds: ids,
        ordersUnavailable: true,
        error: `Nado's /orders endpoint is currently unreachable (${lastError}). Mirror-trading detection cannot run right now — this is not the same as "no matches found".`,
      };
    }
  }

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
      requestsAttempted++;
      try {
        raw = await fetchOrders({ productIds: [productId], idx, limit: 500 });
      } catch (err) {
        requestsFailed++;
        lastError = err.message;
        break; // product probably doesn't exist / endpoint hiccup — move on
      }
      const orders = raw?.orders || [];
      scanned += orders.length;
      if (orders.length === 0) break;

      const fills = normalizeOrdersResponse(raw, { productLabel: productId });
      const inWindow = fills.filter((f) => f.timestamp >= sinceTs);
      allFills.push(...inWindow);

      const oldestTs = Math.min(
        ...orders.map((o) => Number(o.last_fill_timestamp ?? o.first_fill_timestamp)).filter(Number.isFinite)
      );
      const oldestIdx = Math.min(...orders.map((o) => Number(o.submission_idx)).filter(Number.isFinite));
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

  // Every single request to /orders failed (not "came back empty" — actually
  // errored, e.g. 404) → the endpoint itself is unreachable right now. Say so
  // explicitly instead of returning a result indistinguishable from "clean
  // scan, nothing suspicious found".
  const ordersUnavailable = requestsAttempted > 0 && requestsFailed === requestsAttempted;

  return {
    fills: allFills,
    scanned,
    truncated,
    sinceTs,
    productIds: ids,
    ordersUnavailable,
    error: ordersUnavailable
      ? `Nado's /orders endpoint is currently unreachable (${lastError || "no successful response"}). Mirror-trading detection cannot run right now — this is not the same as "no matches found".`
      : null,
  };
}

function getExcludedFunders() {
  const extra = (process.env.EXCLUDED_FUNDERS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...KNOWN_EXCHANGE_WALLETS, ...extra]);
}

const FUNDER_LOOKUP_CONCURRENCY = 6;
const FUNDER_LOOKUP_MAX_PAGES = 8;
// Each Ink Explorer lookup gets its own tighter timeout here (default
// elsewhere is 12s) — this scan makes many of them, so one slow/rate-limited
// call shouldn't be able to single-handedly blow the whole route's time
// budget by up to 12s. A lookup that aborts on this timeout is treated the
// same as any other failed lookup (counted "unresolved"), not as a crash.
const FUNDER_LOOKUP_TIMEOUT_MS = Number(process.env.FUNDER_LOOKUP_TIMEOUT_MS) || 4_000;

// This scan chains a Blockscout deposit walk + up to two Explorer lookups
// *per depositor* + a live infra check per surviving cluster — by far the
// most network-call-heavy of the three, and empirically (first production
// run) slow enough on a real, busy window to blow past Railway's own request
// timeout and come back as a bare 502 — no partial result, nothing useful to
// show. A single first-funder lookup measured ~2s live; with dozens of real
// depositors that adds up fast. Rather than let the platform kill the whole
// request, this scan gets its own, tighter budget ceiling than the other two
// (deposits, mirror) so it reliably returns *something* — even if
// `truncated: true` — well inside whatever the real platform limit is.
// Overridable via env if the real limit turns out to allow more headroom.
const FUNDING_BUDGET_MS = Number(process.env.FUNDING_BUDGET_MS) || 8_000;
const FUNDING_DEPOSIT_BUDGET_MS = Number(process.env.FUNDING_DEPOSIT_BUDGET_MS) || 3_500;

/** Cluster #3: "common funding source" — scans Nado's depositor set for one
 * wallet that was the *first-ever funder* of more than `minFanOut` of them,
 * excluding known exchange/infra wallets (see lib/exchangeWallets.js and the
 * EXCLUDED_FUNDERS env var). This is the most network-call-heavy of the
 * three scans: finding each depositor's first funder takes up to two Ink
 * Explorer lookups *per depositor*, so on a wide window it's the most
 * likely to come back `truncated: true` — that's the budget guard, not a
 * bug; narrow the window or re-run to cover more ground incrementally. */
export async function fetchFundingFanOut({
  hours = 24,
  minFanOut = 6,
  depositMaxPages,
  budgetMs = hours == null ? ALL_TIME_BUDGET_MS : FUNDING_BUDGET_MS,
} = {}) {
  const startedAt = Date.now();
  const { deposits, scanned: depositsScanned, truncated: depositsTruncated, sinceTs } = await fetchGlobalDeposits({
    hours,
    maxPages: depositMaxPages,
    // A tighter, dedicated slice of the overall budget for just the deposit
    // walk, so it can't itself eat the whole request's time allowance before
    // a single funder lookup even starts (all-time scans keep the larger
    // shared budget — they're already expected to take longer and report
    // `truncated: true` rather than needing a hard platform-safe ceiling).
    budgetMs: hours == null ? ALL_TIME_BUDGET_MS : FUNDING_DEPOSIT_BUDGET_MS,
  });

  const wallets = [...new Set(deposits.map((d) => d.wallet))];

  const fundingEdges = [];
  let unresolved = 0;
  let unscanned = 0;

  for (let i = 0; i < wallets.length; i += FUNDER_LOOKUP_CONCURRENCY) {
    if (!budgetGuard(startedAt, budgetMs)) {
      unscanned += wallets.length - i;
      break;
    }
    const batch = wallets.slice(i, i + FUNDER_LOOKUP_CONCURRENCY);
    const results = await Promise.all(
      batch.map((w) =>
        fetchFirstFunder(w, {
          maxPages: FUNDER_LOOKUP_MAX_PAGES,
          // Bounded windows keep the tight per-request timeout (so one slow
          // call can't eat the whole platform-request-safe budget) and only
          // a couple of quick retries on rate-limiting. All-time runs as a
          // background job with no such deadline, so it gets the normal
          // timeout and patiently retries through Ink Explorer's rate limit
          // instead of writing off every wallet it hits mid-walk as
          // "unresolved".
          timeoutMs: hours == null ? undefined : FUNDER_LOOKUP_TIMEOUT_MS,
          patient: hours == null,
        }).catch(() => ({
          funder: null,
          resolved: false,
        }))
      )
    );
    results.forEach((r, j) => {
      if (!r.resolved || !r.funder) {
        unresolved++;
        return;
      }
      fundingEdges.push({ funder: r.funder, funded: batch[j], timestamp: r.timestamp, evidence: r.evidence });
    });
  }

  const excludedFunders = getExcludedFunders();
  const { clusters: rawClusters } = findFundingFanOutClusters(fundingEdges, { minFanOut, excludedFunders });

  // Live infra check only on funders that already cleared the fan-out bar —
  // cheap (one lookup per surviving cluster, not per depositor) — to catch
  // exchange/service wallets the static exclude-list doesn't know about yet.
  const clusters = [];
  let infraExcluded = 0;
  for (const cluster of rawClusters) {
    if (!budgetGuard(startedAt, budgetMs)) {
      clusters.push(cluster); // out of budget — report as-is rather than drop silently
      continue;
    }
    try {
      const info = await fetchAddressInfo(cluster.funder);
      if (isLikelyInfrastructure(info)) {
        infraExcluded++;
        continue;
      }
    } catch {
      // couldn't check (Explorer hiccup) — still show it rather than hide a
      // possible real finding over a transient lookup failure
    }
    clusters.push(cluster);
  }

  return {
    clusters,
    walletsConsidered: wallets.length,
    fundersResolved: fundingEdges.length,
    unresolvedFunders: unresolved,
    unscannedWallets: unscanned,
    infraExcluded,
    depositsScanned,
    truncated: depositsTruncated || unscanned > 0,
    sinceTs,
    // Diagnostic only: how long this whole scan actually took server-side.
    // Added after this route intermittently came back as a bare platform
    // timeout with zero information — if a future report says "it's slow"
    // this tells us whether the budget guards above are doing their job
    // (elapsedMs should stay close to FUNDING_BUDGET_MS) or whether
    // something is still overshooting them.
    elapsedMs: Date.now() - startedAt,
  };
}

/** Everything the Checker page needs for one address in one call: its own
 * deposit/trade activity plus whether it lands inside either cluster type
 * computed over the given window. */
const EMPTY_DEPOSITS = { deposits: [], scanned: 0, truncated: false, sinceTs: null, error: null };
const EMPTY_FILLS = { fills: [], scanned: 0, truncated: false, sinceTs: null, productIds: [], ordersUnavailable: false, error: null };
const EMPTY_FUNDING = {
  clusters: [],
  walletsConsidered: 0,
  fundersResolved: 0,
  unresolvedFunders: 0,
  unscannedWallets: 0,
  infraExcluded: 0,
  depositsScanned: 0,
  truncated: false,
  sinceTs: null,
  error: null,
};

// One upstream (Ink Explorer or Nado Archive) being down shouldn't take the
// whole Checker response down with it — each half degrades independently
// and carries its own `error` field so the UI can say exactly what failed.
export async function checkAddress(address, { depositHours = 24, mirrorHours = 6, minFanOut = 6, productIds } = {}) {
  const lower = address.toLowerCase();
  const [globalDeposits, globalFills, funding] = await Promise.all([
    fetchGlobalDeposits({ hours: depositHours }).catch((err) => ({ ...EMPTY_DEPOSITS, error: err.message })),
    fetchGlobalFills({ hours: mirrorHours, productIds }).catch((err) => ({ ...EMPTY_FILLS, error: err.message })),
    fetchFundingFanOut({ hours: depositHours, minFanOut }).catch((err) => ({ ...EMPTY_FUNDING, error: err.message })),
  ]);
  return { globalDeposits, globalFills, funding, wallet: lower };
}

export { addressFromSubaccount };
