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

async function get(path, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${EXPLORER_BASE}${path}`, { signal: controller.signal });
    const text = await res.text();
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
  } finally {
    clearTimeout(t);
  }
}

/** One page of ERC-20 token transfers for an address (incoming+outgoing).
 * Blockscout paginates via `next_page_params` echoed back in the response;
 * pass it back in as `pageParams` to continue. */
export async function fetchTokenTransfers(address, { pageParams, type = "ERC-20" } = {}) {
  const qs = new URLSearchParams();
  if (type) qs.set("type", type);
  if (pageParams) {
    for (const [k, v] of Object.entries(pageParams)) {
      if (v !== null && v !== undefined) qs.set(k, String(v));
    }
  }
  return get(`/api/v2/addresses/${address}/token-transfers?${qs.toString()}`);
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
export async function walkTokenTransfers(address, { stopWhen, maxPages = 20, type = "ERC-20" } = {}) {
  const all = [];
  let pageParams;
  let hitMaxPages = false;
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchTokenTransfers(address, { pageParams, type });
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

/** Regular (non-token) transactions for an address, one page. */
export async function fetchTransactions(address, { pageParams, filter } = {}) {
  const qs = new URLSearchParams();
  if (filter) qs.set("filter", filter); // "to" | "from"
  if (pageParams) {
    for (const [k, v] of Object.entries(pageParams)) {
      if (v !== null && v !== undefined) qs.set(k, String(v));
    }
  }
  return get(`/api/v2/addresses/${address}/transactions?${qs.toString()}`);
}

export async function fetchAddressInfo(address) {
  return get(`/api/v2/addresses/${address}`);
}

export async function fetchTokenInfo(tokenAddress) {
  return get(`/api/v2/tokens/${tokenAddress}`);
}

export function explorerAddressUrl(address) {
  return `${EXPLORER_BASE}/address/${address}`;
}

export function explorerTxUrl(hash) {
  return `${EXPLORER_BASE}/tx/${hash}`;
}
