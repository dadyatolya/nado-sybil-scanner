// Client for Ink chain's block explorer (Blockscout, https://explorer.inkonchain.com).
// Blockscout instances all run the same well-documented "v2" REST API, so
// these endpoint shapes are standard Blockscout, not Nado-specific guesses.
//
// Used for the on-chain half of the picture: USDT0 deposits into Nado's
// Clearinghouse contract (cluster #1, "same-amount funding pattern") and a
// wallet's raw on-chain transfer history.

const EXPLORER_BASE = process.env.INK_EXPLORER_BASE || "https://explorer.inkonchain.com";
const DEFAULT_TIMEOUT_MS = 12_000;

// From docs.nado.xyz/more/contracts — on-chain mainnet contracts on Ink L2.
export const NADO_CONTRACTS = {
  clearinghouse: "0xD218103918C19D0A10cf35300E4CfAfbD444c5fE".toLowerCase(),
  endpoint: "0x05ec92D78ED421f3D3Ada77FFdE167106565974E".toLowerCase(),
  withdrawPool: "0x09fb495AA7859635f755E827d64c4C9A2e5b9651".toLowerCase(),
  quoteToken: "0x0200C29006150606B650577BBE7B6248F58470c1".toLowerCase(), // USDT0
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Confirmed live (first real "all time" background-job run): Blockscout's
// public instance rate-limits (HTTP 429, "Too many requests. Increase
// limits now at https://dev.blockscout.com") once a scan walks enough pages
// in a row — an all-time history walk of a busy contract, or several
// concurrent per-wallet lookups, gets there easily. This used to just throw
// and kill the whole scan outright.
//
// How much to retry depends on who's calling, though: a background "all
// time" job (lib/jobs.js) has no reason to give up quickly — nothing is
// holding an HTTP request open waiting on it — so it gets long, patient
// backoff. A bounded-window scan (the synchronous /api/clusters/* routes,
// answered inside one request/response cycle) is exactly what the earlier
// tight time budgets (FUNDING_BUDGET_MS etc. in lib/aggregate.js) exist to
// protect — unlimited retry-with-backoff there would just reintroduce the
// same platform-timeout problem those budgets were added to fix. So it gets
// only a couple of short retries: enough to smooth over a one-off blip,
// not enough to blow the request budget. Callers opt into the patient mode
// via `patient: true`, threaded down from lib/aggregate.js only for
// hours === null (all-time) calls.
const PATIENT_MAX_RETRIES = Number(process.env.EXPLORER_RATE_LIMIT_RETRIES) || 6;
const PATIENT_BASE_BACKOFF_MS = Number(process.env.EXPLORER_RATE_LIMIT_BACKOFF_MS) || 1500;
const QUICK_MAX_RETRIES = 2;
const QUICK_BASE_BACKOFF_MS = 400;

async function get(path, { timeoutMs = DEFAULT_TIMEOUT_MS, patient = false } = {}) {
  const maxRetries = patient ? PATIENT_MAX_RETRIES : QUICK_MAX_RETRIES;
  const baseBackoffMs = patient ? PATIENT_BASE_BACKOFF_MS : QUICK_BASE_BACKOFF_MS;
  const maxBackoffMs = patient ? 20_000 : 2_000;

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    let res, text;
    try {
      res = await fetch(`${EXPLORER_BASE}${path}`, { signal: controller.signal });
      text = await res.text();
    } finally {
      clearTimeout(t);
    }

    if (res.status === 429 && attempt < maxRetries) {
      const retryAfterHeader = res.headers.get("retry-after");
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : NaN;
      const backoffMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0
        ? Math.min(retryAfterMs, maxBackoffMs)
        : Math.min(baseBackoffMs * 2 ** attempt, maxBackoffMs);
      await sleep(backoffMs);
      continue;
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Ink Explorer ${path} returned non-JSON (status ${res.status}): ${text.slice(0, 300)}`);
    }
    if (!res.ok) {
      throw new Error(`Ink Explorer ${path} HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    }
    return json;
  }
}

/** One page of ERC-20 token transfers for an address (incoming+outgoing).
 * Blockscout paginates via `next_page_params` echoed back in the response;
 * pass it back in as `pageParams` to continue. */
export async function fetchTokenTransfers(address, { pageParams, type = "ERC-20", timeoutMs, patient } = {}) {
  const qs = new URLSearchParams();
  if (type) qs.set("type", type);
  if (pageParams) {
    for (const [k, v] of Object.entries(pageParams)) {
      if (v !== null && v !== undefined) qs.set(k, String(v));
    }
  }
  return get(`/api/v2/addresses/${address}/token-transfers?${qs.toString()}`, { timeoutMs, patient });
}

/** Walks token-transfer pages for `address` until `stopWhen(transfer)` returns
 * true, `maxPages` is hit, or transfers run out. Returns the flat list
 * collected (excluding the one that triggered the stop, which is still
 * included — caller filters). Used to pull "all incoming USDT0 transfers to
 * the Clearinghouse in the last N hours" without walking the entire history.
 *
 * The returned array also carries a non-enumerable-looking-but-plain
 * `.hitMaxPages` flag (true if the walk stopped because `maxPages` ran out
 * rather than because the history was exhausted or `stopWhen` fired) so
 * callers doing a time-windowed scan can tell "reached genesis" apart from
 * "ran out of page budget mid-window" and report the latter as truncated. */
export async function walkTokenTransfers(address, { stopWhen, maxPages = 20, type = "ERC-20", timeoutMs, patient, onPage } = {}) {
  const all = [];
  let pageParams;
  let hitMaxPages = false;
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchTokenTransfers(address, { pageParams, type, timeoutMs, patient });
    const items = res.items || [];
    for (const item of items) {
      all.push(item);
      if (stopWhen && stopWhen(item)) {
        all.hitMaxPages = false;
        if (onPage) onPage(all, page);
        return all;
      }
    }
    // Fired after every page (not just at the end) so a long "all time" walk
    // can checkpoint its progress to disk periodically — see lib/checkpoint.js
    // for why. Deliberately not awaited here: a slow disk write should never
    // slow down the actual pagination.
    if (onPage) onPage(all, page);
    if (!res.next_page_params || items.length === 0) {
      all.hitMaxPages = false;
      return all;
    }
    pageParams = res.next_page_params;
    if (page === maxPages - 1) hitMaxPages = true;
  }
  all.hitMaxPages = hitMaxPages;
  return all;
}

/** Regular (non-token) transactions for an address, one page. */
export async function fetchTransactions(address, { pageParams, filter, timeoutMs, patient } = {}) {
  const qs = new URLSearchParams();
  if (filter) qs.set("filter", filter); // "to" | "from"
  if (pageParams) {
    for (const [k, v] of Object.entries(pageParams)) {
      if (v !== null && v !== undefined) qs.set(k, String(v));
    }
  }
  return get(`/api/v2/addresses/${address}/transactions?${qs.toString()}`, { timeoutMs, patient });
}

/** Same shape/contract as walkTokenTransfers, but over the plain-transaction
 * endpoint (native ETH transfers, contract calls, etc.) instead of ERC-20
 * transfers — used by fetchFirstFunder() below to also catch "funder sent
 * gas money" as well as "funder sent the token itself." */
export async function walkTransactions(address, { stopWhen, maxPages = 20, filter, timeoutMs, patient } = {}) {
  const all = [];
  let pageParams;
  let hitMaxPages = false;
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchTransactions(address, { pageParams, filter, timeoutMs, patient });
    const items = res.items || [];
    for (const item of items) {
      all.push(item);
      if (stopWhen && stopWhen(item)) {
        all.hitMaxPages = false;
        return all;
      }
    }
    if (!res.next_page_params || items.length === 0) {
      all.hitMaxPages = false;
      return all;
    }
    pageParams = res.next_page_params;
    if (page === maxPages - 1) hitMaxPages = true;
  }
  all.hitMaxPages = hitMaxPages;
  return all;
}

export async function fetchAddressInfo(address) {
  return get(`/api/v2/addresses/${address}`);
}

/** "First funder" of `address`: whoever sent it the very first incoming
 * native-ETH transaction or ERC-20 token transfer, whichever came first.
 * This is the standard "funding wallet" heuristic used across most on-chain
 * Sybil-clustering tools — a freshly created farm wallet's first-ever
 * inbound transfer is almost always the hub that bankrolled it.
 *
 * Walks backward in time (Blockscout returns newest-first) up to `maxPages`
 * pages on *each* of the two feeds. If either feed hits that cap before
 * reaching the address's genesis, we can't be sure we've actually found the
 * true first transfer — so this returns `resolved: false` rather than risk
 * reporting the wrong wallet as "the funder". Callers should skip wallets
 * that come back unresolved instead of guessing. */
export async function fetchFirstFunder(address, { maxPages = 8, timeoutMs, patient } = {}) {
  const lower = address.toLowerCase();

  const [nativeItems, tokenItems] = await Promise.all([
    walkTransactions(address, { maxPages, filter: "to", timeoutMs, patient }),
    walkTokenTransfers(address, { maxPages, timeoutMs, patient }),
  ]);

  const resolved = !nativeItems.hitMaxPages && !tokenItems.hitMaxPages;

  const candidates = [];
  for (const item of nativeItems) {
    const to = (item.to?.hash || "").toLowerCase();
    const from = (item.from?.hash || "").toLowerCase();
    if (to !== lower || !from) continue;
    const ts = item.timestamp ? Math.floor(new Date(item.timestamp).getTime() / 1000) : null;
    if (ts === null) continue;
    candidates.push({ from, timestamp: ts, txHash: item.hash, kind: "native" });
  }
  for (const item of tokenItems) {
    const to = (item.to?.hash || "").toLowerCase();
    const from = (item.from?.hash || "").toLowerCase();
    if (to !== lower || !from) continue;
    const ts = item.timestamp ? Math.floor(new Date(item.timestamp).getTime() / 1000) : null;
    if (ts === null) continue;
    candidates.push({ from, timestamp: ts, txHash: item.tx_hash, kind: "erc20" });
  }

  if (!candidates.length) return { funder: null, timestamp: null, resolved, evidence: null };

  candidates.sort((a, b) => a.timestamp - b.timestamp);
  const first = candidates[0];
  return { funder: first.from, timestamp: first.timestamp, resolved, evidence: { txHash: first.txHash, kind: first.kind } };
}

/** Best-effort "this is probably infrastructure, not a personal wallet"
 * check using whatever Blockscout itself already knows about an address —
 * contract code, and any public/verified tags it carries (exchange hot
 * wallets are sometimes labeled, but coverage varies a lot instance to
 * instance, so this is a supplement to the manual exclude-list in
 * lib/exchangeWallets.js, not a replacement for it). */
export function isLikelyInfrastructure(addressInfo) {
  if (!addressInfo) return false;
  if (addressInfo.is_contract) return true;
  const tagBlobs = [
    ...(Array.isArray(addressInfo.public_tags) ? addressInfo.public_tags : []),
    ...(Array.isArray(addressInfo.metadata?.tags) ? addressInfo.metadata.tags : []),
  ];
  const tagText = tagBlobs
    .map((t) => (typeof t === "string" ? t : t?.name || t?.label || ""))
    .join(" ")
    .toLowerCase();
  return /exchange|hot wallet|cex|custodian|bridge|market maker/.test(tagText);
}

export async function fetchTokenInfo(tokenAddress) {
  return get(`/api/v2/tokens/${tokenAddress}`);
}

/** Diagnostic-only: the "all time" deposit scan came back with exactly one
 * unique depositor wallet across 26,000+ real deposits — and that one
 * "wallet" turned out to be Nado's own Endpoint contract address, not a
 * user. That's consistent with Nado's on-chain flow (matching Vertex
 * Protocol's architecture) routing a deposit through the Endpoint contract
 * before it reaches the Clearinghouse: the Transfer event landing *in* the
 * Clearinghouse would then always show `from = Endpoint`, regardless of
 * which real user initiated it — the actual depositor only appears on the
 * earlier hop, the Transfer *into* the Endpoint contract.
 *
 * This fetches a handful of incoming-transfer pages for whichever contract
 * address is passed in and reports how many distinct `from` addresses show
 * up, so that hypothesis can be checked against live data before rewriting
 * fetchGlobalDeposits() to point at a different contract. */
export async function debugTransferSourceProbe(contractAddress, { pages = 2 } = {}) {
  try {
    const items = await walkTokenTransfers(contractAddress, { maxPages: pages });
    const incoming = items.filter((item) => (item.to?.hash || "").toLowerCase() === contractAddress.toLowerCase());
    const fromCounts = new Map();
    for (const item of incoming) {
      const from = (item.from?.hash || "").toLowerCase();
      fromCounts.set(from, (fromCounts.get(from) || 0) + 1);
    }
    const distinctFrom = [...fromCounts.entries()].sort((a, b) => b[1] - a[1]);
    return {
      ok: true,
      contractAddress: contractAddress.toLowerCase(),
      pagesWalked: pages,
      totalItems: items.length,
      incomingCount: incoming.length,
      distinctFromAddresses: distinctFrom.length,
      topFromAddresses: distinctFrom.slice(0, 5).map(([addr, count]) => ({ addr, count })),
    };
  } catch (err) {
    return { ok: false, contractAddress: contractAddress.toLowerCase(), error: err.message };
  }
}

export function explorerAddressUrl(address) {
  return `${EXPLORER_BASE}/address/${address}`;
}

export function explorerTxUrl(hash) {
  return `${EXPLORER_BASE}/tx/${hash}`;
}
