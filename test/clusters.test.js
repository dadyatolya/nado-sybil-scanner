import test from "node:test";
import assert from "node:assert/strict";
import { findDepositClusters, findMirrorTradeClusters, findFundingFanOutClusters, normalizeOrdersResponse } from "../lib/clusters.js";
import { toSubaccount, addressFromSubaccount } from "../lib/subaccount.js";
import { relDiff, x18ToNumber, rawToNumber } from "../lib/fixedpoint.js";
import { parseHoursParam, parseIntParam, parseProductIds } from "../lib/params.js";

function addr(suffix) {
  return `0x${"0".repeat(40 - suffix.length)}${suffix}`;
}
const W1 = addr("aa1");
const W2 = addr("bb2");
const W3 = addr("cc3");
const W4 = addr("dd4");

test("relDiff / x18ToNumber / rawToNumber basics", () => {
  assert.ok(Math.abs(relDiff(100, 104) - 4 / 104) < 1e-9);
  assert.ok(relDiff(100, 105) <= 0.05 + 1e-9);
  assert.ok(relDiff(100, 106) > 0.05);
  assert.equal(x18ToNumber("100000000000000000000"), 100); // 100e18
  assert.equal(x18ToNumber("-2000000000000000000"), -2); // -2e18
  assert.equal(x18ToNumber(null), 0);
  assert.equal(rawToNumber("100000000", 6), 100); // 100 USDT0 (6 decimals)
});

test("parseHoursParam: numbers, 'all', and fallback", () => {
  assert.deepEqual(parseHoursParam("24", 6), { hours: 24, isAll: false });
  assert.deepEqual(parseHoursParam("all", 6), { hours: null, isAll: true });
  assert.deepEqual(parseHoursParam("0", 6), { hours: null, isAll: true });
  assert.deepEqual(parseHoursParam(null, 6), { hours: 6, isAll: false });
  assert.deepEqual(parseHoursParam("garbage", 6), { hours: 6, isAll: false });
  assert.deepEqual(parseHoursParam("-5", 6), { hours: 6, isAll: false });
});

test("parseIntParam / parseProductIds", () => {
  assert.equal(parseIntParam("42", 1), 42);
  assert.equal(parseIntParam("nope", 1), 1);
  assert.deepEqual(parseProductIds("1, 2,3"), [1, 2, 3]);
  assert.equal(parseProductIds(""), undefined);
  assert.equal(parseProductIds("nope"), undefined);
});

test("subaccount round-trip", () => {
  const sub = toSubaccount(W1, "default");
  assert.equal(sub.length, 66); // 0x + 64 hex chars
  assert.equal(addressFromSubaccount(sub), W1);
});

test("findDepositClusters: flags two wallets funding within tolerance+window", () => {
  const now = 1_700_000_000;
  const deposits = [
    { wallet: W1, amount: 100, timestamp: now, evidence: { tx: "0xaaa" } },
    { wallet: W2, amount: 104, timestamp: now + 300, evidence: { tx: "0xbbb" } }, // +5min, +4%
    { wallet: W3, amount: 9000, timestamp: now + 60, evidence: { tx: "0xccc" } }, // unrelated amount
  ];
  const { clusters } = findDepositClusters(deposits, { amountTolerance: 0.05, windowSeconds: 600 });
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].members.sort(), [W1, W2].sort());
  assert.equal(clusters[0].edges[0].matches.length, 1);
});

test("findDepositClusters: does NOT flag when outside amount tolerance", () => {
  const now = 1_700_000_000;
  const deposits = [
    { wallet: W1, amount: 100, timestamp: now, evidence: {} },
    { wallet: W2, amount: 110, timestamp: now + 60, evidence: {} }, // +10%, over 5% tolerance
  ];
  const { clusters } = findDepositClusters(deposits, { amountTolerance: 0.05, windowSeconds: 600 });
  assert.equal(clusters.length, 0);
});

test("findDepositClusters: does NOT flag when outside time window", () => {
  const now = 1_700_000_000;
  const deposits = [
    { wallet: W1, amount: 100, timestamp: now, evidence: {} },
    { wallet: W2, amount: 100, timestamp: now + 700, evidence: {} }, // +11m40s, over 10min window
  ];
  const { clusters } = findDepositClusters(deposits, { amountTolerance: 0.05, windowSeconds: 600 });
  assert.equal(clusters.length, 0);
});

test("findDepositClusters: chains transitively into one cluster (A~B, B~C)", () => {
  const now = 1_700_000_000;
  const deposits = [
    { wallet: W1, amount: 100, timestamp: now, evidence: {} },
    { wallet: W2, amount: 101, timestamp: now + 60, evidence: {} },
    { wallet: W3, amount: 102, timestamp: now + 120, evidence: {} },
  ];
  const { clusters } = findDepositClusters(deposits, { amountTolerance: 0.05, windowSeconds: 600 });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].size, 3);
});

test("findFundingFanOutClusters: flags a funder that fed more than minFanOut wallets", () => {
  const funder = addr("f00");
  const funded = [addr("101"), addr("102"), addr("103"), addr("104"), addr("105"), addr("106")]; // 6 wallets
  const edges = funded.map((w, i) => ({ funder, funded: w, timestamp: 1_700_000_000 + i, evidence: { kind: "native" } }));
  const { clusters } = findFundingFanOutClusters(edges, { minFanOut: 6 });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].funder, funder.toLowerCase());
  assert.equal(clusters[0].size, 6);
  assert.deepEqual(clusters[0].members.sort(), funded.map((w) => w.toLowerCase()).sort());
});

test("findFundingFanOutClusters: does NOT flag a funder under the threshold", () => {
  const funder = addr("f00");
  const funded = [addr("101"), addr("102"), addr("103"), addr("104"), addr("105")]; // only 5
  const edges = funded.map((w, i) => ({ funder, funded: w, timestamp: 1_700_000_000 + i }));
  const { clusters } = findFundingFanOutClusters(edges, { minFanOut: 6 });
  assert.equal(clusters.length, 0);
});

test("findFundingFanOutClusters: excludes a funder on the exclude list even above threshold", () => {
  const funder = addr("f00");
  const funded = [addr("101"), addr("102"), addr("103"), addr("104"), addr("105"), addr("106")];
  const edges = funded.map((w, i) => ({ funder, funded: w, timestamp: 1_700_000_000 + i }));
  const { clusters } = findFundingFanOutClusters(edges, {
    minFanOut: 6,
    excludedFunders: new Set([funder.toLowerCase()]),
  });
  assert.equal(clusters.length, 0);
});

test("findFundingFanOutClusters: self-funding edges and duplicate (funder,funded) pairs are ignored/deduped", () => {
  const funder = addr("f00");
  const funded = [addr("101"), addr("102"), addr("103"), addr("104"), addr("105"), addr("106")];
  const edges = [
    { funder, funded: funder, timestamp: 1 }, // self-funding, should be dropped
    ...funded.map((w, i) => ({ funder, funded: w, timestamp: 1_700_000_000 + i })),
    { funder, funded: funded[0], timestamp: 1_700_000_050 }, // duplicate pair, later timestamp — should not create a 7th member
  ];
  const { clusters } = findFundingFanOutClusters(edges, { minFanOut: 6 });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].size, 6);
});

function mirrorFill({ wallet, product = "BTC-PERP", side, size, timestamp, kind }) {
  return { kind, wallet, product, side, size, timestamp, evidence: {} };
}

test("findMirrorTradeClusters: needs >=10 matched mirrored trades AND both open+close legs", () => {
  const base = 1_700_000_000;
  const fills = [];
  // 9 mirrored opens only (no closes) — should NOT qualify (only one leg present)
  for (let i = 0; i < 9; i++) {
    const t = base + i * 100;
    fills.push(mirrorFill({ wallet: W1, side: 1, size: 10, timestamp: t, kind: "open" }));
    fills.push(mirrorFill({ wallet: W2, side: -1, size: 10.2, timestamp: t + 5, kind: "open" }));
  }
  const r1 = findMirrorTradeClusters(fills, { minMatchedTrades: 10 });
  assert.equal(r1.clusters.length, 0);

  // add 1 more open pair (10 total) + a matching close pair -> now both legs present, 11 total >= 10
  const t = base + 2000;
  fills.push(mirrorFill({ wallet: W1, side: 1, size: 10, timestamp: t, kind: "open" }));
  fills.push(mirrorFill({ wallet: W2, side: -1, size: 10.1, timestamp: t + 3, kind: "open" }));
  const t2 = base + 3000;
  fills.push(mirrorFill({ wallet: W1, side: -1, size: 10, timestamp: t2, kind: "close" }));
  fills.push(mirrorFill({ wallet: W2, side: 1, size: 9.9, timestamp: t2 + 4, kind: "close" }));

  const r2 = findMirrorTradeClusters(fills, { minMatchedTrades: 10 });
  assert.equal(r2.clusters.length, 1);
  assert.deepEqual(r2.clusters[0].members.sort(), [W1, W2].sort());
});

test("findMirrorTradeClusters: same-side trades never mirror, unrelated wallet stays out", () => {
  const base = 1_700_000_000;
  const fills = [];
  for (let i = 0; i < 12; i++) {
    const t = base + i * 50;
    fills.push(mirrorFill({ wallet: W1, side: 1, size: 5, timestamp: t, kind: "open" }));
    fills.push(mirrorFill({ wallet: W3, side: 1, size: 5, timestamp: t + 2, kind: "open" })); // same side -> not a mirror
    fills.push(mirrorFill({ wallet: W1, side: -1, size: 5, timestamp: t + 10, kind: "close" }));
    fills.push(mirrorFill({ wallet: W3, side: -1, size: 5, timestamp: t + 12, kind: "close" }));
  }
  const { clusters } = findMirrorTradeClusters(fills, { minMatchedTrades: 10 });
  assert.equal(clusters.length, 0);
});

test("findMirrorTradeClusters: direct taker<->maker repeated matches also qualify", () => {
  const base = 1_700_000_000;
  const fills = [];
  for (let i = 0; i < 10; i++) {
    fills.push({
      kind: "direct",
      takerWallet: W1,
      makerWallet: W4,
      product: "ETH-PERP",
      size: 1,
      timestamp: base + i * 30,
      evidence: {},
    });
  }
  const { clusters } = findMirrorTradeClusters(fills, { minMatchedTrades: 10 });
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].members.sort(), [W1, W4].sort());
});

// Shape here matches the REAL /orders response (confirmed via docs.nado.xyz
// once this was actually deployed with live internet access) — each order
// record is self-contained, unlike the old guessed "/matches"+"/txs" pair.
test("normalizeOrdersResponse: derives open from a fresh position increase", () => {
  const sub1 = toSubaccount(W1, "default");
  const raw = {
    orders: [
      {
        digest: "0xd1",
        submission_idx: "1",
        subaccount: sub1,
        base_filled: "2000000000000000000", // +2
        last_fill_timestamp: "1700000000",
        pre_balance: { base: { perp: { product_id: 2, balance: { amount: "0" } } } },
        post_balance: { base: { perp: { product_id: 2, balance: { amount: "2000000000000000000" } } } },
      },
    ],
  };
  const fills = normalizeOrdersResponse(raw);
  assert.equal(fills.length, 1);
  assert.equal(fills[0].kind, "open");
  assert.equal(fills[0].wallet, W1);
  assert.equal(fills[0].side, 1);
  assert.equal(fills[0].size, 2);
  assert.equal(fills[0].timestamp, 1700000000);
});

test("normalizeOrdersResponse: derives close from a position decrease", () => {
  const sub1 = toSubaccount(W1, "default");
  const raw = {
    orders: [
      {
        digest: "0xd2",
        submission_idx: "2",
        subaccount: sub1,
        base_filled: "-1000000000000000000",
        last_fill_timestamp: "1700000500",
        pre_balance: { base: { perp: { product_id: 3, balance: { amount: "2000000000000000000" } } } },
        post_balance: { base: { perp: { product_id: 3, balance: { amount: "1000000000000000000" } } } },
      },
    ],
  };
  const fills = normalizeOrdersResponse(raw);
  const close = fills.find((f) => f.kind === "close");
  assert.ok(close);
  assert.equal(close.wallet, W1);
  assert.equal(close.size, 1);
  assert.equal(close.timestamp, 1700000500);
});
