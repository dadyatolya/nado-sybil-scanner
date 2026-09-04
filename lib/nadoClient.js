// Client for Nado's own Archive (indexer) API. Nado's on-chain contract
// naming (Endpoint / Clearinghouse / OffchainExchange, X18 fixed point,
// bytes32 subaccounts) matches the Vertex Protocol architecture it's built
// on, which is how several of the request/response shapes below were
// cross-checked. Endpoints and field names come from https://docs.nado.xyz —
// this network sandbox cannot reach archive.prod.nado.xyz to test live calls
// (only a short egress allowlist is reachable here), so treat this file as
// "best effort from documentation" and see README.md's "Verify after
// deploying" checklist for the couple of things worth double-checking once
// this is actually running somewhere with open internet access.

import { toSubaccount } from "./subaccount.js";

const ARCHIVE_BASE = process.env.NADO_ARCHIVE_BASE || "https://archive.prod.nado.xyz/v1";
const GATEWAY_BASE = process.env.NADO_GATEWAY_BASE || "https://gateway.prod.nado.xyz/v1";

const DEFAULT_TIMEOUT_MS = 12_000;

async function postArchive(path, body, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${ARCHIVE_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

async function postGateway(path, body, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${GATEWAY_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

/** Historical fills ("matches") for one or more subaccounts, or for a whole
 * product (omit `subaccounts` to get the global tape for that market —
 * that's what the Clusters page uses). Paginates backward in time using
 * `idx` (submission_idx cursor) since the API returns newest-first. */
export async function fetchMatches({ subaccounts, productIds, maxTime, idx, limit = 500, isolated } = {}) {
  const body = { matches: { limit } };
  if (subaccounts?.length) body.matches.subaccounts = subaccounts;
  if (productIds?.length) body.matches.product_ids = productIds;
  if (maxTime !== undefined) body.matches.max_time = maxTime;
  if (idx !== undefined) body.matches.idx = idx;
  if (isolated !== undefined) body.matches.isolated = isolated;
  return postArchive("/matches", body);
}

/** Protocol events: deposit_collateral / withdraw_collateral / liquidate_subaccount /
 * settle_pnl / match_orders / mint_lp / burn_lp, filtered by subaccount and/or type. */
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
 * time" view and the Checker's volume figure. */
export async function fetchPortfolio(subaccount) {
  return postArchive("/portfolio", { portfolio: { subaccount } });
}

export async function fetchContracts() {
  return postGateway("/query", { type: "contracts" });
}

/** There's no confirmed "list all markets" endpoint in the docs we could
 * reach from here (see README). This probes small product_id integers via
 * the cheap oracle-price query and keeps whichever respond — good enough to
 * populate a market picker without hand-maintaining a possibly-stale list.
 * Failures are swallowed; caller gets whatever it found (maybe nothing). */
export async function discoverProductIds({ maxId = 40 } = {}) {
  const found = [];
  const probes = [];
  for (let id = 0; id <= maxId; id++) {
    probes.push(
      postArchive("/oracle-price", { oracle_price: { product_ids: [id] } }, { timeoutMs: 5000 })
        .then((res) => {
          const hasData =
            res && (Array.isArray(res.oracle_prices) ? res.oracle_prices.length > 0 : Object.keys(res).length > 0);
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
