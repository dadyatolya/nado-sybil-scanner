// Global protocol TVL. DefiLlama already tracks Nado (https://defillama.com/protocol/nado)
// and exposes a free, no-key public API — more reliable for a whole-protocol
// TVL figure/history than trying to re-derive it ourselves from on-chain vault
// balances, which would need every collateral asset's price feed.

const DEFAULT_TIMEOUT_MS = 10_000;

async function getJson(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`DefiLlama ${url} HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** Full protocol record: { tvl: [{date, totalLiquidityUSD}], currentChainTvls, ... } */
export async function fetchNadoTvlHistory() {
  return getJson("https://api.llama.fi/protocol/nado");
}

export async function fetchNadoTvlCurrent() {
  const data = await fetchNadoTvlHistory();
  const series = data?.tvl || [];
  const last = series[series.length - 1];
  return {
    tvlUsd: last?.totalLiquidityUSD ?? null,
    asOf: last?.date ?? null,
    history: series,
  };
}
