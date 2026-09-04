import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchNadoTvlCurrent } from "./lib/defillama.js";
import { fetchPortfolio, walletSubaccount } from "./lib/nadoClient.js";
import { isAddress, normalizeAddress } from "./lib/subaccount.js";
import { fetchWalletDeposits, fetchGlobalDeposits, fetchGlobalFills, fetchFundingFanOut, getKnownProductIds, checkAddress } from "./lib/aggregate.js";
import { findDepositClusters, findMirrorTradeClusters } from "./lib/clusters.js";
import { explorerAddressUrl } from "./lib/inkExplorer.js";
import { parseHoursParam, parseProductIds } from "./lib/params.js";
import { recordPageView, recordWalletCheck, getStats } from "./lib/stats.js";
import { recordCheckerIp, getClientIp, getSuspiciousIps } from "./lib/ipActivity.js";

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
    const { deposits, scanned, truncated, sinceTs } = await fetchGlobalDeposits({ hours });
    const result = findDepositClusters(deposits, {
      amountTolerance: 0.05,
      windowSeconds: 600,
    });
    sendJson(res, 200, {
      windowHours: hours,
      allTime: isAll,
      sinceTs,
      depositsScanned: scanned,
      depositsConsidered: deposits.length,
      truncated,
      clusters: result.clusters,
    });
  },

  "GET /api/clusters/mirror": async (query, res) => {
    const { hours, isAll } = parseHoursParam(query.get("hours"), 6);
    const productIds = parseProductIds(query.get("products"));
    const { fills, scanned, truncated, sinceTs, productIds: usedIds } = await fetchGlobalFills({ hours, productIds });
    const result = findMirrorTradeClusters(fills, {
      sizeTolerance: 0.05,
      windowSeconds: 15,
      minMatchedTrades: 10,
    });
    sendJson(res, 200, {
      windowHours: hours,
      allTime: isAll,
      sinceTs,
      productIds: usedIds,
      fillsScanned: scanned,
      fillsConsidered: fills.length,
      truncated,
      clusters: result.clusters,
    });
  },

  "GET /api/clusters/funding": async (query, res) => {
    const { hours, isAll } = parseHoursParam(query.get("hours"), 24);
    const minFanOut = Math.max(2, Number.parseInt(query.get("minFanOut"), 10) || 6);
    const result = await fetchFundingFanOut({ hours, minFanOut });
    sendJson(res, 200, {
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
      clusters: result.clusters,
    });
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

    const volumeSeries = portfolio?.volumeHistory?.["1d"]?.history?.volumeHistory;
    let totalVolume = null;
    if (Array.isArray(volumeSeries) && volumeSeries.length) {
      const last = volumeSeries[volumeSeries.length - 1];
      totalVolume = Array.isArray(last) ? last[1] : null;
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
