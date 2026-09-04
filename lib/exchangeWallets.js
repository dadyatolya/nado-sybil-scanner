// Known exchange / bridge / infrastructure wallets on Ink that should never
// be treated as a Sybil-farm "funding hub", even though they legitimately
// fan out to a large number of unrelated wallets (that's just what a CEX hot
// wallet or a bridge contract does all day).
//
// IMPORTANT — this list is NOT verified against live data. This project was
// built in a sandbox with no network access to Ink Explorer (see README's
// "Known unknowns"), so there was no way to look up Kraken's or any other
// exchange's actual Ink hot-wallet addresses. Treat the entries below as
// placeholders to replace, not a ready-made list.
//
// Two ways to fix/extend this once the site is live and you see false
// positives on the Clusters page's "Common funding source" section:
//
//   1. Best for one-offs / no redeploy needed: set the EXCLUDED_FUNDERS env
//      var on Railway (Settings -> Variables) to a comma-separated list of
//      addresses, e.g. EXCLUDED_FUNDERS=0xabc...,0xdef...
//   2. Best for a permanent list: add addresses to KNOWN_EXCHANGE_WALLETS
//      below and redeploy.
//
// Both lists are merged together (see getExcludedFunders() in
// lib/aggregate.js). There's also a best-effort automatic check
// (lib/inkExplorer.js's isLikelyInfrastructure()) that excludes any address
// Ink Explorer itself marks as a contract or tags as an exchange/hot wallet
// — but Blockscout's public-tag coverage varies, so it won't catch
// everything on its own.

export const KNOWN_EXCHANGE_WALLETS = new Set(
  [
    // Add real addresses here, one per line, e.g.:
    // "0x1234567890123456789012345678901234567890", // Kraken hot wallet (example only)
  ].map((a) => a.toLowerCase())
);
