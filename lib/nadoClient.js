// Client for Nado's own Archive (indexer) and V2 REST APIs.
//
// UPDATE (first real production run): the base URL below used to be
// "https://archive.prod.nado.xyz/v1" — that domain/path combination 404s.
// Confirmed against the live docs at docs.nado.xyz once this was actually
// deployed somewhere with open internet access: the correct unified base for
// the archive-indexer (POST, oracle-price/portfolio/events/orders) is
// "https://api.prod.nado.xyz/archive/v1", and there's a *separate* V2 REST
// API (GET, symbols/tickers/trades/contracts) at ".../archive/v2". Nado's
// on-chain contract naming (Endpoint / Clearinghouse / OffchainExchange, X18
// fixed point, bytes32 subaccounts) does match Vertex Protocol's
// architecture, which is how the original request/response shapes here were
// guessed — but Nado's actual indexer uses an "/orders" query (per-subaccount
// order+fill records), not a separate "/matches"+"/txs" pair the way some
// Vertex-family forks do. See lib/clusters.js's normalizeOrdersResponse for
// how that shape is turned into the flat fills the cluster detectors expect.

import { toSubaccount } from "./subaccount.js";

const ARCHIVE_BASE = process.env.NADO_ARCHIVE_BASE || "https://api.prod.nado.xyz/archive/v1";
const ARCHIVE_V2_BASE = process.env.NADO_ARCHIVE_V2_BASE || "https://api.prod.nado.xyz/archive/v2";
const GATEWAY_BASE = process.env.NADO_GATEWAY_BASE || "https://api.prod.nado.xyz/gateway/v2";

const DEFAULT_TIMEOUT_MS = 12_000;

async function postArchive(path, body, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${ARCHIVE_BASE}${path}`, {
      method: "POST",
      // Nado's archive-indexer docs require an Accept-Encoding header
      // naming at least one of gzip/br/deflate — Node's built-in fetch
      // doesn't always set one on its own, so it's set explicitly here.
      headers: { "Content-Type": "application/json", "Accept-Encoding": "gzip" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Nado archive ${path} returned non-JSON (status ${res.status}): ${text.slice(0, 300)}`);
    }
    if (!res.ok) {
      throw new Error(`Nado archive ${path} HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}

async function getArchiveV2(path, params = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  const url = `${ARCHIVE_V2_BASE}${path}${qs.toString() ? `?${qs}` : ""}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "Accept-Encoding": "gzip" }, signal: controller.signal });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Nado archive v2 ${path} returned non-JSON (status ${res.status}): ${text.slice(0, 300)}`);
    }
    if (!res.ok) {
      throw new Error(`Nado archive v2 ${path} HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}

async function postGateway(path, body, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${GATEWAY_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept-Encoding": "gzip" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Nado gateway ${path} returned non-JSON (status ${res.status}): ${text.slice(0, 300)}`);
    }
    if (!res.ok) {
      throw new Error(`Nado gateway ${path} HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}

/** Historical order+fill records ("orders") for one or more subaccounts, or
 * for a whole product (omit `subaccounts` to try for the market-wide feed —
 * that's what the Clusters page's mirror-trading scan needs; unconfirmed
 * whether the API actually allows this without a subaccount filter, see
 * lib/aggregate.js's fetchGlobalFills for the fallback behavior if not).
 * Paginates backward in time using `idx` (submission_idx cursor) since the
 * API returns newest-first. Replaces the old (nonexistent) "/matches"
 * endpoint this file used to call before the archive-indexer docs were
 * actually reachable. */
export async function fetchOrders({ subaccounts, productIds, maxTime, idx, limit = 500, isolated } = {}) {
  const body = { orders: { limit } };
  if (subaccounts?.length) body.orders.subaccounts = subaccounts;
  if (productIds?.length) body.orders.product_ids = productIds;
  if (maxTime !== undefined) body.orders.max_time = maxTime;
  if (idx !== undefined) body.orders.idx = idx;
  if (isolated !== undefined) body.orders.isolated = isolated;
  return postArchive("/orders", body);
}

/** Protocol events: deposit_collateral / withdraw_collateral / liquidate_subaccount /
 * settle_pnl / match_orders / mint_lp / burn_lp, filtered by subaccount and/or type.
 * Defined for completeness (matches docs.nado.xyz's archive-indexer/events
 * endpoint) but not currently used by any route in this app. */
export async function fetchEvents({ subaccounts, productIds, eventTypes, maxTime, idx, limit = 500 } = {}) {
  const body = { events: { limit: { raw: limit } } };
  if (subaccounts?.length) body.events.subaccounts = subaccounts;
  if (productIds?.length) body.events.product_ids = productIds;
  if (eventTypes?.length) body.events.event_types = eventTypes;
  if (maxTime !== undefined) body.events.max_time = maxTime;
  if (idx !== undefined) body.events.idx = idx;
  return postArchive("/events", body);
}

/** Per-wallet portfolio time series: account value, pnl, volume, trade size,
 * distinct-market count — used for the Dashboard "this wallet's value over
 * time" view and the Checker's volume figure. Response is an array of
 * [period, historySeries] pairs (NOT an object keyed by period) — see
 * pickPortfolioSeries() below for how callers should read it. */
export async function fetchPortfolio(subaccount) {
  return postArchive("/portfolio", { portfolio: { subaccount } });
}

/** Pulls one named period's series out of the /portfolio response's
 * [period, seriesObject][] array shape (confirmed via docs.nado.xyz —
 * earlier code guessed this was an object like `{accountValueHistory:[...]}`
 * or `{"1d": {...}}`, which is wrong). `period` is matched case-insensitively
 * against whatever the API actually calls it (docs show "day" for the
 * shortest window); falls back to the first entry if no exact match. */
export function pickPortfolioSeries(portfolioRaw, period = "day") {
  if (!Array.isArray(portfolioRaw)) return null;
  const wanted = period.toLowerCase();
  const hit = portfolioRaw.find((pair) => Array.isArray(pair) && String(pair[0]).toLowerCase() === wanted);
  return (hit || portfolioRaw[0])?.[1] || null;
}

export async function fetchContracts() {
  return postGateway("/query", { type: "contracts" });
}

/** Real "list all markets" endpoint (v2 REST, GET .../symbols) — confirmed
 * via docs.nado.xyz. Returns a map keyed by ticker symbol, e.g.
 * {"BTC-PERP": {product_id: 2, symbol: "BTC-PERP", type: "perp", ...}}.
 * Replaces the old discoverProductIds() brute-force probe below, and gives
 * readable ticker names as a bonus (discoverProductIds only ever returned
 * bare numeric IDs). */
export async function fetchSymbols({ productType } = {}) {
  const raw = await getArchiveV2("/symbols", { product_type: productType });
  const entries = Object.entries(raw || {}).map(([symbol, info]) => ({
    symbol,
    productId: Number(info?.product_id),
    type: info?.type,
    tradingStatus: info?.trading_status,
  }));
  return entries.filter((e) => Number.isFinite(e.productId));
}

/** Fallback-only: brute-force probe of small product_id integers via the
 * cheap oracle-price query, kept in case fetchSymbols() above ever fails
 * (wrong product_type filter, API change, etc.) — see getKnownProductIds()
 * in lib/aggregate.js for how the two are combined. Failures are swallowed;
 * caller gets whatever it found (maybe nothing). */
export async function discoverProductIds({ maxId = 40 } = {}) {
  const found = [];
  const probes = [];
  for (let id = 0; id <= maxId; id++) {
    probes.push(
      postArchive("/oracle-price", { oracle_price: { product_ids: [id] } }, { timeoutMs: 5000 })
        .then((res) => {
          const hasData = Array.isArray(res?.prices) && res.prices.length > 0;
          if (hasData) found.push(id);
        })
        .catch(() => {})
    );
  }
  await Promise.all(probes);
  return found.sort((a, b) => a - b);
}

export function walletSubaccount(address) {
  return toSubaccount(address, "default");
}

/** Diagnostic-only: a single oracle-price probe with the real error surfaced
 * instead of swallowed (discoverProductIds() above swallows every probe's
 * error so a caller just sees "no products found" with no clue why). Used
 * by the /api/debug/probe route in server.js. Safe to leave deployed:
 * read-only, no side effects, no secrets touched. */
export async function debugOraclePing(id = 0) {
  try {
    const data = await postArchive("/oracle-price", { oracle_price: { product_ids: [id] } }, { timeoutMs: 8000 });
    return { ok: true, archiveBase: ARCHIVE_BASE, data };
  } catch (err) {
    return { ok: false, archiveBase: ARCHIVE_BASE, error: err.message };
  }
}

/** Diagnostic-only: tests whether /orders returns a market-wide feed when
 * called with a product_id but no subaccounts filter (undocumented — the
 * one example in docs.nado.xyz always includes a subaccounts filter). Used
 * by /api/debug/probe to decide whether fetchGlobalFills's "global tape"
 * approach is viable as-is or needs a different strategy (e.g. only ever
 * scanning specific wallets, never a whole market). */
export async function debugOrdersProbe(productId = 1) {
  try {
    const data = await postArchive("/orders", { orders: { product_ids: [productId], limit: 5 } }, { timeoutMs: 8000 });
    const orders = Array.isArray(data?.orders) ? data.orders : [];
    return {
      ok: true,
      archiveBase: ARCHIVE_BASE,
      count: orders.length,
      distinctSubaccounts: [...new Set(orders.map((o) => o.subaccount))].length,
      sample: orders[0] || null,
    };
  } catch (err) {
    return { ok: false, archiveBase: ARCHIVE_BASE, error: err.message };
  }
}

/** Real v2 REST symbols endpoint, surfaced raw for diagnostics. */
export async function debugSymbolsProbe() {
  try {
    const symbols = await fetchSymbols();
    return { ok: true, archiveV2Base: ARCHIVE_V2_BASE, count: symbols.length, sample: symbols.slice(0, 5) };
  } catch (err) {
    return { ok: false, archiveV2Base: ARCHIVE_V2_BASE, error: err.message };
  }
}
