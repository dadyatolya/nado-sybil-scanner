// Pure detection logic for the two Sybil-cluster heuristics described in the
// spec. Nothing here talks to the network — it takes already-fetched,
// already-normalized events and returns graphs/clusters. Keeping it pure
// makes it directly unit-testable (see test/clusters.test.js) without
// needing live access to Ink Explorer / Nado's API.

import { UnionFind } from "./unionFind.js";
import { relDiff } from "./fixedpoint.js";
import { addressFromSubaccount } from "./subaccount.js";

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// ---------------------------------------------------------------------------
// Cluster #1: "funding pattern" — different wallets deposit near-identical
// amounts within a short window of each other.
//   deposits: [{ wallet, amount, timestamp, evidence }]
//   amount: number (USD-ish units, e.g. USDT0)
//   timestamp: unix seconds
// ---------------------------------------------------------------------------
export function findDepositClusters(
  deposits,
  { amountTolerance = 0.05, windowSeconds = 600 } = {}
) {
  const sorted = [...deposits]
    .filter((d) => d && d.wallet && Number.isFinite(d.amount) && Number.isFinite(d.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);

  const pairEvidence = new Map(); // pairKey -> { a, b, matches: [] }
  const uf = new UnionFind();

  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const dt = sorted[j].timestamp - sorted[i].timestamp;
      if (dt > windowSeconds) break; // sorted by time, nothing further can be in-window
      const a = sorted[i];
      const b = sorted[j];
      if (a.wallet === b.wallet) continue;
      if (relDiff(a.amount, b.amount) > amountTolerance) continue;

      const key = pairKey(a.wallet, b.wallet);
      if (!pairEvidence.has(key)) {
        pairEvidence.set(key, { a: a.wallet < b.wallet ? a.wallet : b.wallet, b: a.wallet < b.wallet ? b.wallet : a.wallet, matches: [] });
      }
      pairEvidence.get(key).matches.push({
        walletA: a.wallet,
        walletB: b.wallet,
        amountA: a.amount,
        amountB: b.amount,
        deltaSeconds: Math.round(dt),
        evidenceA: a.evidence,
        evidenceB: b.evidence,
      });
      uf.union(a.wallet, b.wallet);
    }
  }

  return buildClusterReport(uf, pairEvidence, deposits.map((d) => d.wallet));
}

// ---------------------------------------------------------------------------
// Cluster #2: "mirror trading" — different wallets open (and later close)
// opposite-side positions on the same market within seconds of each other,
// at near-identical size. Also credits directly-matched taker<->maker fills
// between the same two wallets (a much stronger, zero-ambiguity signal) when
// that pair repeats often enough to not be coincidental order-book crossing.
//
//   fills: raw, per-fill records as normalized from Nado's /matches response,
//   see normalizeMatchesResponse() below for the shape.
// ---------------------------------------------------------------------------
export function findMirrorTradeClusters(
  fills,
  { sizeTolerance = 0.05, windowSeconds = 15, minMatchedTrades = 10 } = {}
) {
  const pairCounts = new Map(); // pairKey -> { a, b, open: [], close: [], direct: [] }

  function ensurePair(walletA, walletB) {
    const key = pairKey(walletA, walletB);
    if (!pairCounts.has(key)) {
      pairCounts.set(key, {
        a: walletA < walletB ? walletA : walletB,
        b: walletA < walletB ? walletB : walletA,
        open: [],
        close: [],
        direct: [],
      });
    }
    return pairCounts.get(key);
  }

  // --- Signal A: direct taker<->maker matches between two real wallets ---
  for (const f of fills) {
    if (f.kind !== "direct") continue;
    if (!f.takerWallet || !f.makerWallet || f.takerWallet === f.makerWallet) continue;
    ensurePair(f.takerWallet, f.makerWallet).direct.push({
      product: f.product,
      size: f.size,
      timestamp: f.timestamp,
      evidence: f.evidence,
    });
  }

  // --- Signal B: independent same-direction-cancelling opens/closes ---
  const opens = fills.filter((f) => f.kind === "open").sort((a, b) => a.timestamp - b.timestamp);
  const closes = fills.filter((f) => f.kind === "close").sort((a, b) => a.timestamp - b.timestamp);

  function scanMirrors(list, bucketName) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const dt = list[j].timestamp - list[i].timestamp;
        if (dt > windowSeconds) break;
        const a = list[i];
        const b = list[j];
        if (a.wallet === b.wallet) continue;
        if (a.product !== b.product) continue;
        if (a.side === b.side) continue; // must be opposite directions to "mirror"
        if (relDiff(a.size, b.size) > sizeTolerance) continue;

        ensurePair(a.wallet, b.wallet)[bucketName].push({
          product: a.product,
          sizeA: a.size,
          sizeB: b.size,
          deltaSeconds: Math.round(dt),
          walletA: a.wallet,
          walletB: b.wallet,
          evidenceA: a.evidence,
          evidenceB: b.evidence,
        });
      }
    }
  }
  scanMirrors(opens, "open");
  scanMirrors(closes, "close");

  const uf = new UnionFind();
  const pairEvidence = new Map();
  const allWallets = new Set();
  for (const f of fills) if (f.wallet) allWallets.add(f.wallet);
  for (const f of fills) {
    if (f.takerWallet) allWallets.add(f.takerWallet);
    if (f.makerWallet) allWallets.add(f.makerWallet);
  }

  for (const [key, rec] of pairCounts) {
    const directCount = rec.direct.length;
    const mirrorCount = rec.open.length + rec.close.length;
    const hasBothLegs = rec.open.length > 0 && rec.close.length > 0;

    const qualifiesDirect = directCount >= minMatchedTrades;
    const qualifiesMirror = mirrorCount >= minMatchedTrades && hasBothLegs;

    if (!qualifiesDirect && !qualifiesMirror) continue;

    pairEvidence.set(key, {
      a: rec.a,
      b: rec.b,
      matches: [
        ...rec.direct.map((m) => ({ type: "direct_counterparty", ...m })),
        ...rec.open.map((m) => ({ type: "mirrored_open", ...m })),
        ...rec.close.map((m) => ({ type: "mirrored_close", ...m })),
      ],
      directCount,
      openCount: rec.open.length,
      closeCount: rec.close.length,
      qualifiesDirect,
      qualifiesMirror,
    });
    uf.union(rec.a, rec.b);
  }

  return buildClusterReport(uf, pairEvidence, [...allWallets]);
}

// ---------------------------------------------------------------------------
// Cluster #3: "common funding source" — a single wallet (the "funder") is
// the first-ever funder of more than `minFanOut` distinct other wallets that
// went on to deposit into Nado. This is a stronger, more classic Sybil
// signal than #1 (same-amount deposits): fresh farmed wallets are typically
// bankrolled from one hub address before anything else happens to them.
//
// Deliberately NOT union-find here — the funder is not itself a suspected
// Sybil wallet (it's plausibly an exchange, a treasury, a friend), so it's
// kept as metadata on the cluster rather than merged in as a member. Members
// are only the funded (depositor) wallets.
//
//   fundingEdges: [{ funder, funded, timestamp, evidence }]
//   excludedFunders: Set<lowercase address> — known exchange/service wallets
//     to never treat as a Sybil hub (see lib/exchangeWallets.js). A funder
//     fanning out to hundreds of unrelated wallets is exactly what a CEX hot
//     wallet looks like, so excluding known ones matters more here than for
//     the other two heuristics.
// ---------------------------------------------------------------------------
export function findFundingFanOutClusters(
  fundingEdges,
  { minFanOut = 6, excludedFunders = new Set() } = {}
) {
  const byFunder = new Map(); // funder -> Map<funded, edge>

  for (const edge of fundingEdges) {
    if (!edge || !edge.funder || !edge.funded) continue;
    const funder = edge.funder.toLowerCase();
    const funded = edge.funded.toLowerCase();
    if (funder === funded) continue;
    if (excludedFunders.has(funder)) continue;
    if (!byFunder.has(funder)) byFunder.set(funder, new Map());
    // If we somehow see the same (funder, funded) pair twice, keep the
    // earliest-timestamped edge — that's the one that actually establishes
    // "first funder."
    const existing = byFunder.get(funder).get(funded);
    if (!existing || (Number.isFinite(edge.timestamp) && edge.timestamp < existing.timestamp)) {
      byFunder.get(funder).set(funded, edge);
    }
  }

  const clusters = [];
  for (const [funder, fundedMap] of byFunder) {
    if (fundedMap.size < minFanOut) continue;
    const edges = [...fundedMap.values()].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    clusters.push({
      id: `funding_${funder}`,
      funder,
      members: edges.map((e) => e.funded.toLowerCase()),
      size: fundedMap.size,
      edges,
    });
  }

  clusters.sort((a, b) => b.size - a.size);
  return { clusters };
}

function buildClusterReport(uf, pairEvidence, allWalletsSeen) {
  // make sure every wallet that appears anywhere is at least registered
  // (so singletons - wallets with no matches - don't crash groups()).
  for (const w of allWalletsSeen) if (w) uf.find(w);

  const groups = uf.groups().filter((g) => g.length > 1); // only real clusters (2+ members)

  const clusters = groups.map((members, idx) => {
    const memberSet = new Set(members);
    const edges = [];
    for (const [, rec] of pairEvidence) {
      if (memberSet.has(rec.a) && memberSet.has(rec.b)) {
        edges.push(rec);
      }
    }
    return {
      id: `cluster_${idx + 1}`,
      members,
      size: members.length,
      edges,
    };
  });

  clusters.sort((a, b) => b.size - a.size || b.edges.length - a.edges.length);

  return { clusters, pairEvidence };
}

// ---------------------------------------------------------------------------
// Turns one page of Nado's POST /matches response into the flat "fills"
// shape findMirrorTradeClusters() expects: open/close synthetic events per
// wallet (derived from pre/post perp balance deltas) plus direct
// taker<->maker events for non-AMM matches.
// ---------------------------------------------------------------------------
import { x18ToNumber, sign } from "./fixedpoint.js";

export function normalizeMatchesResponse(raw, { productLabel } = {}) {
  const matches = raw?.matches || [];
  const txs = raw?.txs || [];
  const tsByIdx = new Map(txs.map((t) => [String(t.submission_idx), Number(t.timestamp)]));

  const fills = [];

  for (const m of matches) {
    const idx = String(m.submission_idx);
    const timestamp = tsByIdx.get(idx);
    if (!Number.isFinite(timestamp)) continue;

    const wallet = addressFromSubaccount(m.order?.sender);
    if (!wallet) continue;

    const product = productLabel ?? m?.pre_balance?.base?.perp?.product_id ?? m?.post_balance?.base?.perp?.product_id ?? "unknown";

    const preAmt = x18ToNumber(m?.pre_balance?.base?.perp?.balance?.amount);
    const postAmt = x18ToNumber(m?.post_balance?.base?.perp?.balance?.amount);
    const baseFilled = x18ToNumber(m?.base_filled);
    const evidence = { digest: m.digest, submissionIdx: idx };

    // Split into open/close legs based on how the position magnitude moved.
    const preMag = Math.abs(preAmt);
    const postMag = Math.abs(postAmt);
    const sameSign = sign(preAmt) === sign(postAmt) || preAmt === 0 || postAmt === 0;

    if (sameSign) {
      if (postMag > preMag) {
        fills.push({ kind: "open", wallet, product, side: sign(postAmt) || sign(baseFilled), size: postMag - preMag, timestamp, evidence });
      } else if (postMag < preMag) {
        fills.push({ kind: "close", wallet, product, side: sign(preAmt), size: preMag - postMag, timestamp, evidence });
      }
    } else {
      // position flipped sign in one fill: closed the old side entirely, opened the new one
      fills.push({ kind: "close", wallet, product, side: sign(preAmt), size: preMag, timestamp, evidence });
      fills.push({ kind: "open", wallet, product, side: sign(postAmt), size: postMag, timestamp, evidence });
    }
  }

  // Direct taker<->maker pairing, from the txs[].tx.match_orders envelope
  // (only present when the counterparty was a real wallet, not the AMM).
  for (const t of txs) {
    const mo = t?.tx?.match_orders;
    if (!mo || mo.amm) continue;
    const takerWallet = addressFromSubaccount(mo.taker?.order?.sender);
    const makerWallet = addressFromSubaccount(mo.maker?.order?.sender);
    if (!takerWallet || !makerWallet || takerWallet === makerWallet) continue;
    const size = Math.abs(x18ToNumber(mo.taker?.order?.amount));
    fills.push({
      kind: "direct",
      takerWallet,
      makerWallet,
      product: productLabel ?? mo.product_id ?? "unknown",
      size,
      timestamp: Number(t.timestamp),
      evidence: { submissionIdx: String(t.submission_idx) },
    });
  }

  return fills;
}
