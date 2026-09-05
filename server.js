import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchNadoTvlCurrent } from "./lib/defillama.js";
import { fetchPortfolio, walletSubaccount, pickPortfolioSeries, debugOraclePing, debugOrdersProbe, debugSymbolsProbe, debugMatrixProbe } from "./lib/nadoClient.js";
import { isAddress, normalizeAddress } from "./lib/subaccount.js";
import { fetchWalletDeposits, fetchGlobalDeposits, fetchGlobalFills, fetchFundingFanOut, getKnownProductIds, checkAddress, getExcludedFunders } from "./lib/aggregate.js";
import { findDepositClusters, findMirrorTradeClusters, findFundingFanOutClusters } from "./lib/clusters.js";
import { explorerAddressUrl, fetchFirstFunder, debugTransferSourceProbe, NADO_CONTRACTS } from "./lib/inkExplorer.js";
import { parseHoursParam, parseProductIds } from "./lib/params.js";
import { recordPageView, recordWalletCheck, getStats } from "./lib/stats.js";
import { recordCheckerIp, getClientIp, getSuspiciousIps } from "./lib/ipActivity.js";
import { startJob, getJob } from "./lib/jobs.js";
import { loadCheckpoint } from "./lib/checkpoint.js";

const ADMIN_KEY = process.env.ADMIN_KEY || null;

function isAdminAuthorized(req) {
  if (!ADMIN_KEY) return false; // feature disabled entirely if no key is configured
  const auth = req.headers.authorization || "";
  const [scheme, token] = auth.split(" ");
  return scheme === "Bearer" && token === ADMIN_KEY;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = process.env.PORT || 3000;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

async function sendStatic(res, filePath) {
  const ext = path.extname(filePath);
  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=3600",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

function requireAddress(query, res) {
  const address = (query.get("address") || "").trim();
  if (!isAddress(address)) {
    sendJson(res, 400, { error: "Query param 'address' must be a 0x-prefixed 20-byte EVM address." });
    return null;
  }
  return normalizeAddress(address);
}

// Builders shared between the synchronous /api/clusters/* routes (fast
// enough to answer within one request/response cycle) and the background-job
// routes below (/api/scan/*, for "all time" scans that legitimately can't).
// Same shape either way, so the frontend renders a job's `result` with
// exactly the same rendering code it already uses for a direct response.
async function buildDepositsResult({ hours, isAll }) {
  const { deposits, scanned, truncated, sinceTs } = await fetchGlobalDeposits({ hours });
  const result = findDepositClusters(deposits, { amountTolerance: 0.05, windowSeconds: 600 });
  // Nado doesn't expose a "list all accounts" endpoint anywhere in its public
  // API (see README's API-availability notes) — the closest thing that
  // actually exists is "every wallet that has ever deposited USDT0 into
  // Nado" (via the Endpoint contract — see fetchGlobalDeposits()'s doc
  // comment in lib/aggregate.js for why it's Endpoint and not Clearinghouse),
  // which is exactly what this scan already walks. Surfacing the
  // deduplicated list here (not just cluster groups) is what answers "how
  // many Nado wallets are there / what are they."
  const wallets = [...new Set(deposits.map((d) => d.wallet))];
  return {
    windowHours: hours,
    allTime: isAll,
    sinceTs,
    depositsScanned: scanned,
    depositsConsidered: deposits.length,
    uniqueWallets: wallets.length,
    wallets,
    truncated,
    clusters: result.clusters,
  };
}

async function buildMirrorResult({ hours, isAll, productIds }) {
  const { fills, scanned, truncated, sinceTs, productIds: usedIds, ordersUnavailable, error } = await fetchGlobalFills({
    hours,
    productIds,
  });
  const result = findMirrorTradeClusters(fills, { sizeTolerance: 0.05, windowSeconds: 15, minMatchedTrades: 10 });
  return {
    windowHours: hours,
    allTime: isAll,
    sinceTs,
    productIds: usedIds,
    fillsScanned: scanned,
    fillsConsidered: fills.length,
    truncated,
    ordersUnavailable,
    error,
    clusters: result.clusters,
  };
}

async function buildFundingResult({ hours, isAll, minFanOut }) {
  const result = await fetchFundingFanOut({ hours, minFanOut });
  return {
    windowHours: hours,
    allTime: isAll,
    minFanOut,
    sinceTs: result.sinceTs,
    walletsConsidered: result.walletsConsidered,
    fundersResolved: result.fundersResolved,
    unresolvedFunders: result.unresolvedFunders,
    unscannedWallets: result.unscannedWallets,
    infraExcluded: result.infraExcluded,
    truncated: result.truncated,
    elapsedMs: result.elapsedMs,
    clusters: result.clusters,
  };
}

const SCAN_BUILDERS = {
  deposits: ({ query }) => {
    const { hours, isAll } = parseHoursParam(query.get("hours"), 24);
    return buildDepositsResult({ hours, isAll });
  },
  mirror: ({ query }) => {
    const { hours, isAll } = parseHoursParam(query.get("hours"), 6);
    const productIds = parseProductIds(query.get("products"));
    return buildMirrorResult({ hours, isAll, productIds });
  },
  funding: ({ query }) => {
    const { hours, isAll } = parseHoursParam(query.get("hours"), 24);
    const minFanOut = Math.max(2, Number.parseInt(query.get("minFanOut"), 10) || 6);
    return buildFundingResult({ hours, isAll, minFanOut });
  },
};

const routes = {
  "GET /api/stats": async (_query, res) => {
    const stats = await getStats();
    sendJson(res, 200, stats);
  },

  "GET /api/dashboard/tvl": async (_query, res) => {
    const tvl = await fetchNadoTvlCurrent();
    sendJson(res, 200, tvl);
  },

  "GET /api/dashboard/wallet": async (query, res) => {
    const address = requireAddress(query, res);
    if (!address) return;
    const subaccount = walletSubaccount(address);
    const [portfolio, deposits] = await Promise.all([
      fetchPortfolio(subaccount).catch((err) => ({ error: err.message })),
      fetchWalletDeposits(address).catch(() => []),
    ]);
    sendJson(res, 200, {
      address,
      subaccount,
      explorerUrl: explorerAddressUrl(address),
      portfolio,
      onChainDeposits: deposits,
    });
  },

  "GET /api/products": async (_query, res) => {
    const ids = await getKnownProductIds();
    sendJson(res, 200, { productIds: ids });
  },

  "GET /api/clusters/deposits": async (query, res) => {
    const { hours, isAll } = parseHoursParam(query.get("hours"), 24);
    sendJson(res, 200, await buildDepositsResult({ hours, isAll }));
  },

  "GET /api/clusters/mirror": async (query, res) => {
    const { hours, isAll } = parseHoursParam(query.get("hours"), 6);
    const productIds = parseProductIds(query.get("products"));
    sendJson(res, 200, await buildMirrorResult({ hours, isAll, productIds }));
  },

  "GET /api/clusters/funding": async (query, res) => {
    const { hours, isAll } = parseHoursParam(query.get("hours"), 24);
    const minFanOut = Math.max(2, Number.parseInt(query.get("minFanOut"), 10) || 6);
    sendJson(res, 200, await buildFundingResult({ hours, isAll, minFanOut }));
  },

  // Background-job versions of the three scans above, for windows that can
  // legitimately take longer than any single HTTP request should stay open
  // (an "all time" scan especially — see lib/jobs.js for why). The browser
  // starts a job here, gets a jobId back immediately, then polls
  // /api/scan/status until it's done. The synchronous routes above are still
  // used for the normal bounded-window scans (fast enough as-is).
  "GET /api/scan/start": async (query, res) => {
    const kind = (query.get("kind") || "").trim();
    const builder = SCAN_BUILDERS[kind];
    if (!builder) {
      sendJson(res, 400, { error: `Unknown scan kind '${kind}'. Expected one of: ${Object.keys(SCAN_BUILDERS).join(", ")}.` });
      return;
    }
    const job = startJob(kind, Object.fromEntries(query.entries()), () => builder({ query }));
    sendJson(res, 202, { jobId: job.id, kind: job.kind, status: job.status, startedAt: job.startedAt });
  },

  "GET /api/scan/status": async (query, res) => {
    const jobId = (query.get("jobId") || "").trim();
    const job = jobId && getJob(jobId);
    if (!job) {
      sendJson(res, 404, { error: "Unknown job id — it may have finished long ago, or the server restarted since it was started." });
      return;
    }
    const elapsedMs = (job.finishedAt || Date.now()) - job.startedAt;
    if (job.status === "running") {
      sendJson(res, 200, { jobId: job.id, kind: job.kind, status: job.status, startedAt: job.startedAt, elapsedMs });
      return;
    }
    if (job.status === "error") {
      sendJson(res, 200, { jobId: job.id, kind: job.kind, status: job.status, startedAt: job.startedAt, elapsedMs, error: job.error });
      return;
    }
    sendJson(res, 200, {
      jobId: job.id,
      kind: job.kind,
      status: job.status,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      elapsedMs,
      result: job.result,
    });
  },

  // Crash-recovery read: the last progress an all-time scan of `kind`
  // ("deposits" | "funding") managed to save to disk before it either
  // finished normally or the process died mid-scan (see lib/checkpoint.js —
  // realistically an OOM kill from Railway's memory limit, given how long
  // and memory-hungry these scans are). Unlike /api/scan/status, this reads
  // straight from disk rather than the in-memory jobs Map, so it still
  // answers even after a restart wiped every in-memory job — the whole
  // point being "don't lose whatever was already found." For "funding", the
  // saved funder→funded edges are enough to recompute clusters fresh
  // (findFundingFanOutClusters is cheap — pure in-memory grouping, no
  // network calls), so a checkpoint read gets real cluster results too, not
  // just raw counts.
  "GET /api/scan/checkpoint": async (query, res) => {
    const kind = (query.get("kind") || "").trim();
    if (!["deposits", "funding"].includes(kind)) {
      sendJson(res, 400, { error: "Query param 'kind' must be 'deposits' or 'funding'." });
      return;
    }
    const cp = await loadCheckpoint(kind);
    if (!cp) {
      sendJson(res, 404, {
        error: `No checkpoint saved yet for '${kind}' — no all-time scan of that kind has run long enough to checkpoint (checkpoints save every ~15s).`,
      });
      return;
    }
    if (kind === "funding" && Array.isArray(cp.edges)) {
      const { clusters } = findFundingFanOutClusters(cp.edges, {
        minFanOut: cp.minFanOut || 6,
        excludedFunders: getExcludedFunders(),
      });
      sendJson(res, 200, { ...cp, clusters });
      return;
    }
    sendJson(res, 200, cp);
  },

  "GET /api/checker": async (query, res, req) => {
    const address = requireAddress(query, res);
    if (!address) return;
    recordWalletCheck(address); // fire-and-forget — never blocks the response
    recordCheckerIp(getClientIp(req), address); // fire-and-forget — see lib/ipActivity.js
    const { hours: depositHours, isAll: depositIsAll } = parseHoursParam(query.get("depositHours"), 24);
    const { hours: mirrorHours, isAll: mirrorIsAll } = parseHoursParam(query.get("mirrorHours"), 6);
    const productIds = parseProductIds(query.get("products"));

    const subaccount = walletSubaccount(address);
    const [portfolio, { globalDeposits, globalFills, funding }] = await Promise.all([
      fetchPortfolio(subaccount).catch((err) => ({ error: err.message })),
      checkAddress(address, { depositHours, mirrorHours, productIds }),
    ]);

    const depositReport = findDepositClusters(globalDeposits.deposits, { amountTolerance: 0.05, windowSeconds: 600 });
    const mirrorReport = findMirrorTradeClusters(globalFills.fills, { sizeTolerance: 0.05, windowSeconds: 15, minMatchedTrades: 10 });

    const depositCluster = depositReport.clusters.find((c) => c.members.includes(address)) || null;
    const mirrorCluster = mirrorReport.clusters.find((c) => c.members.includes(address)) || null;
    const fundingCluster = (funding.clusters || []).find((c) => c.members.includes(address)) || null;

    // /portfolio's real shape is an array of [period, seriesObject] pairs
    // (confirmed via docs.nado.xyz), not an object keyed by "1d" the way
    // this used to guess before the app had live internet access.
    const volumeSeries = pickPortfolioSeries(portfolio, "day")?.volumeHistory;
    let totalVolume = null;
    if (Array.isArray(volumeSeries) && volumeSeries.length) {
      const last = volumeSeries[volumeSeries.length - 1];
      totalVolume = Array.isArray(last) ? Number(last[1]) : null;
    }

    sendJson(res, 200, {
      address,
      subaccount,
      explorerUrl: explorerAddressUrl(address),
      totalVolume,
      portfolioRaw: portfolio,
      flaggedForDepositPattern: Boolean(depositCluster),
      depositCluster,
      flaggedForMirrorTrading: Boolean(mirrorCluster),
      mirrorCluster,
      flaggedForFundingFanOut: Boolean(fundingCluster),
      fundingCluster,
      scan: {
        depositWindowHours: depositHours,
        depositAllTime: depositIsAll,
        depositsScanned: globalDeposits.scanned,
        depositsTruncated: globalDeposits.truncated,
        depositsError: globalDeposits.error || null,
        mirrorWindowHours: mirrorHours,
        mirrorAllTime: mirrorIsAll,
        fillsScanned: globalFills.scanned,
        fillsTruncated: globalFills.truncated,
        fillsError: globalFills.error || null,
        fundingWalletsConsidered: funding.walletsConsidered,
        fundingUnresolved: funding.unresolvedFunders,
        fundingTruncated: funding.truncated,
        fundingError: funding.error || null,
      },
    });
  },

  // Temporary diagnostic route (safe to leave: read-only, no secrets) — see
  // README's "Debugging live API assumptions" section. Surfaces real errors
  // instead of the swallowed ones the normal code paths hide behind empty
  // results, for the couple of Nado/Ink Explorer assumptions that could
  // only be checked once this was deployed with real internet access.
  "GET /api/debug/probe": async (query, res) => {
    const [oracle, symbols, orders, matrix] = await Promise.all([
      debugOraclePing(0),
      debugSymbolsProbe(),
      debugOrdersProbe(Number.parseInt(query.get("productId"), 10) || 1),
      query.get("matrix") ? debugMatrixProbe() : Promise.resolve(null),
    ]);
    let funder = null;
    const wallet = (query.get("wallet") || "").trim();
    if (wallet && isAddress(wallet)) {
      const startedAt = Date.now();
      try {
        const result = await fetchFirstFunder(normalizeAddress(wallet), { maxPages: 3 });
        funder = { ok: true, elapsedMs: Date.now() - startedAt, result };
      } catch (err) {
        funder = { ok: false, elapsedMs: Date.now() - startedAt, error: err.message };
      }
    }
    let depositSource = null;
    if (query.get("depositSource")) {
      const [clearinghouse, endpoint] = await Promise.all([
        debugTransferSourceProbe(NADO_CONTRACTS.clearinghouse, { pages: 2 }),
        debugTransferSourceProbe(NADO_CONTRACTS.endpoint, { pages: 2 }),
      ]);
      depositSource = { clearinghouse, endpoint };
    }
    sendJson(res, 200, { oracle, symbols, orders, matrix, funder, depositSource });
  },

  "GET /api/admin/suspicious-ips": async (query, res, req) => {
    if (!ADMIN_KEY) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    if (!isAdminAuthorized(req)) {
      sendJson(res, 401, { error: "Missing or invalid admin key." });
      return;
    }
    const minWallets = Math.max(2, Number.parseInt(query.get("minWallets"), 10) || 6);
    const ips = await getSuspiciousIps({ minWallets });
    sendJson(res, 200, { minWallets, ips });
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const routeKey = `${req.method} ${url.pathname}`;

  if (routes[routeKey]) {
    try {
      await routes[routeKey](url.searchParams, res, req);
    } catch (err) {
      console.error(`[${routeKey}]`, err);
      sendJson(res, 502, { error: err.message || "Upstream request failed." });
    }
    return;
  }

  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  // Unlinked admin page (key-gated client-side against /api/admin/*)
  // deliberately kept out of cleanRoutes/pageStatKeys below — it shouldn't
  // bump the public visit counters or appear anywhere in nav.
  if (url.pathname === "/admin") {
    await sendStatic(res, path.join(PUBLIC_DIR, "admin.html"));
    return;
  }

  // Clean-URL static routing for the three pages, plus generic static assets.
  const cleanRoutes = {
    "/": "dashboard.html",
    "/dashboard": "dashboard.html",
    "/clusters": "clusters.html",
    "/checker": "checker.html",
  };
  const pageStatKeys = { "/": "dashboard", "/dashboard": "dashboard", "/clusters": "clusters", "/checker": "checker" };
  if (cleanRoutes[url.pathname]) {
    recordPageView(pageStatKeys[url.pathname]); // fire-and-forget
    await sendStatic(res, path.join(PUBLIC_DIR, cleanRoutes[url.pathname]));
    return;
  }

  const candidate = path.normalize(path.join(PUBLIC_DIR, url.pathname));
  if (candidate.startsWith(PUBLIC_DIR) && existsSync(candidate)) {
    await sendStatic(res, candidate);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`nado-sybil-scanner listening on http://localhost:${PORT}`);
});
