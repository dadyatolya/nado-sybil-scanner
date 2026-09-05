# Sybil Scanner for Nado

An unofficial community tool for the [Nado](https://www.nado.xyz) DEX (Ink L2, Kraken's chain). Three pages:

- **Dashboard** — Nado's protocol-wide TVL, plus a wallet lookup showing that wallet's value in Nado over time.
- **Clusters** — live scan for three Sybil-wallet patterns.
- **Checker** — paste a wallet address, see its trading volume and whether it lands inside any cluster.

## The three cluster heuristics

1. **Funding pattern.** Two *different* wallets deposit near-identical amounts (≤5% apart) within 10 minutes of each other. Chains of matching pairs are grouped transitively (A↔B, B↔C ⇒ one 3-wallet cluster).
2. **Mirror trading.** Two different wallets open opposite-side positions (one long, one short) on the same market within 15 seconds, size within 5%, *and* later close them the same way too. A pair only counts once it has **≥10** such matched trades. Direct repeated taker↔maker matches between the same two wallets (i.e. they keep trading directly against each other rather than the broader book) are treated as an even stronger version of the same signal.
3. **Common funding source.** A single wallet is the *first-ever* funder (native ETH or any token, whichever transfer landed first) of more than a threshold number of distinct wallets (default **6**, i.e. "more than 5") that went on to deposit into Nado. This is the classic on-chain Sybil signature — a fresh farmed wallet's very first inbound transfer is almost always the hub that bankrolled it — and doesn't need any coincidence in amount or timing the way #1 does. Known exchange / bridge / service wallets are excluded from being counted as a "hub" (see below), since a CEX hot wallet legitimately fans out to thousands of unrelated people.

The first two are graph-clustered with union-find: any two wallets connected by a qualifying match end up in the same cluster, and clusters transitively absorb more members. The third is different by nature — the funder isn't itself a suspected Sybil wallet (it's plausibly an exchange, a treasury, or a friend), so it's kept as metadata on the cluster rather than merged in as a member; only the funded (depositor) wallets are the cluster's `members`.

### Excluding exchange wallets from cluster #3

This project was built with no live access to Ink Explorer (see "Known unknowns" below), so there was no way to look up real exchange hot-wallet addresses on Ink to pre-populate an exclude list — `lib/exchangeWallets.js` ships empty, with instructions inline. Two ways to add exclusions once the site is live and you see a false positive (a wallet you recognize as an exchange showing up as a "funding hub"):

- **No redeploy needed:** on Railway, go to your service → **Variables** → add `EXCLUDED_FUNDERS` = a comma-separated list of addresses (e.g. `0xabc...,0xdef...`). Takes effect on the next scan, no code change.
- **Permanent:** add the address to `KNOWN_EXCHANGE_WALLETS` in `lib/exchangeWallets.js` and redeploy.

There's also a best-effort *automatic* check (`isLikelyInfrastructure()` in `lib/inkExplorer.js`): any funder that Ink Explorer itself marks as a smart contract, or tags with something like "exchange"/"hot wallet"/"bridge", gets excluded without you doing anything — but Blockscout's public-tag coverage varies a lot, so treat it as a supplement to the manual list, not a replacement.

Every scan (Clusters page and Checker) has a lookback-window dropdown that goes up to **All time** — this walks Ink Explorer / Nado's Archive API as far back as it can within a bounded page count and wall-clock budget (`ALL_TIME_MAX_PAGES` / `ALL_TIME_BUDGET_MS` env vars, defaults 500 pages / 50s), rather than a fixed number of hours. A full-history scan of an active market can be a lot of paginated requests, so it can come back with `truncated: true` (shown in the UI as "(partial)") if it hits that budget before reaching genesis — that's the safety valve doing its job, not a bug. Re-running the scan re-walks from the newest data each time (there's no "resume from where it left off" cursor yet), so an all-time scan is inherently slower and less complete on a very active market than a bounded one; the mirror-trading scan in particular walks every known product's full match history in turn, so it's the slower of the two.

**These are statistical heuristics, not proof.** Correlated deposits and offsetting trades can happen for innocent reasons (an exchange's hot wallet, a market maker, friends funding at the same time). Treat flags as a starting point for investigation, not a verdict — the UI says as much on every page.

## Data sources

| Data | Source | Why |
|---|---|---|
| Global TVL | [DefiLlama](https://defillama.com/protocol/nado) (`api.llama.fi`) | Already tracks Nado; no need to re-derive TVL from every collateral asset's price ourselves. |
| On-chain deposits (cluster #1) | **Ink Explorer** (Blockscout, `explorer.inkonchain.com`) — incoming USDT0 transfers to Nado's `Clearinghouse` contract | Deposits are on-chain transactions, so the block explorer sees them directly. |
| Trades / fills (cluster #2, wallet trade history) | **Nado's own Archive API** (`archive.prod.nado.xyz`) | Nado's trading engine is an **off-chain sequencer** — individual long/short opens and closes never touch the chain, only periodic settlement does. The block explorer literally cannot see them; Nado's own indexer is the only place this data exists. |
| First funder per wallet (cluster #3) | **Ink Explorer** — each depositor's own earliest incoming native + ERC-20 transfer | Same reasoning as cluster #1: funding transfers are on-chain, so the explorer sees them directly; no Nado-specific data needed. |
| Wallet "value over time" | Nado Archive API `/portfolio` (`accountValueHistory`) | Closest available series to "this wallet's TVL in Nado over time." |

Contract addresses (Ink mainnet) and API base URLs are in `lib/inkExplorer.js` and `lib/nadoClient.js`, sourced from `docs.nado.xyz`.

## Running it

No dependencies to install — everything uses Node's built-in `fetch`/`http`.

```bash
node server.js
# -> http://localhost:3000
```

Requires Node 18.17+ (built-in `fetch`; tested on Node 22).

Run the logic tests (pure functions, no network needed):

```bash
node --test test/clusters.test.js
# or: npm test
```

### Environment variables (all optional, sensible defaults baked in)

| Var | Default |
|---|---|
| `PORT` | `3000` |
| `NADO_ARCHIVE_BASE` | `https://api.prod.nado.xyz/archive/v1` (archive-indexer: oracle-price, portfolio, events, orders) |
| `NADO_ARCHIVE_V2_BASE` | `https://api.prod.nado.xyz/archive/v2` (v2 REST: symbols/tickers/trades/contracts) |
| `NADO_GATEWAY_BASE` | `https://api.prod.nado.xyz/gateway/v2` |
| `INK_EXPLORER_BASE` | `https://explorer.inkonchain.com` |
| `ALL_TIME_MAX_PAGES` | `500` — page cap for an "All time" scan (per deposit scan, or per product for mirror trading) |
| `ALL_TIME_BUDGET_MS` | `50000` — wall-clock budget (ms) for an "All time" scan before it stops and reports `truncated: true` |
| `EXCLUDED_FUNDERS` | *(empty)* — comma-separated addresses to always exclude as a cluster #3 "funding hub" (exchanges, bridges, your own treasury, etc.) — see "Excluding exchange wallets" above |
| `STATS_DIR` | `./data` — where usage-stats.json is written; see "Usage stats" below |
| `ADMIN_KEY` | *(unset)* — secret key that enables the admin-only "suspicious IPs" endpoint/page; the feature is fully disabled (404) while this is unset. See "Abuse signal" below |
| `IP_SALT` | *(random, generated on boot)* — salt mixed into the IP hash used for abuse detection; set this explicitly if you want hashes to stay stable across redeploys even without a persistent volume |
| `IP_ACTIVITY_DIR` | same default as `STATS_DIR` — where `ip-activity.json` is written |

## Usage stats

A small counter strip (site visits · distinct wallets checked · total checks) shows at the top of every page, backed by `GET /api/stats` and `lib/stats.js`. It's deliberately simple — no cookies, no bot filtering, a page refresh counts as another visit — so treat it as a rough "is anyone using this" signal (handy as traction evidence, e.g. for a grant application), not real analytics.

Counts are written to a JSON file (`data/stats.json` by default) so they survive ordinary restarts. **They will NOT survive a redeploy** unless that file lives on a persistent Volume — Railway (and most PaaS platforms) build a fresh container from your GitHub repo on every deploy, and anything written at runtime outside of a mounted volume is thrown away with the old container. To make the counters durable across deploys on Railway:

1. Open your service on Railway → **Settings** → **Volumes** → **+ New Volume**.
2. Set the mount path to `/data`.
3. Add an environment variable `STATS_DIR` = `/data` (Settings → Variables).
4. Redeploy once (Railway does this automatically after a variable change). From then on, `data/stats.json` lives on the volume and survives future deploys.

Without a volume, the strip still works — it just resets to zero the next time you push a code update, which is fine if you mainly care about "traffic since the last change" rather than a running lifetime total.

## Abuse signal: suspicious IPs (admin-only)

The Checker also tracks, per client IP, how many *distinct* wallet addresses have been looked up. Rationale: a lazy Sybil-farm operator checking whether their own controlled wallets got flagged would tend to run a bunch of different addresses through the Checker from one machine — same underlying idea as the on-chain cluster heuristics, just based on who's asking instead of on-chain behavior.

**Privacy design:**

- The raw IP is never stored. It's hashed (SHA-256, salted, truncated) before being kept in memory or on disk — the stored value cannot be turned back into an IP address.
- Nothing here is ever shown on a public page. It's exposed only through `GET /api/admin/suspicious-ips`, and that route is **completely disabled (404, not just "unauthorized")** unless you set the `ADMIN_KEY` environment variable.
- With `ADMIN_KEY` set, the route requires an `Authorization: Bearer <key>` header matching it — anything else gets `401`.
- There's a simple, unlinked page at `/admin` (not in the nav, not counted in the visit stats) where you can paste the key and view the list — see the "Min. distinct wallets" field there, default matches the ">5" threshold from the on-chain cluster heuristics.

**To enable it on Railway:** Settings → Variables → add `ADMIN_KEY` = any long random string you pick, then visit `https://<your-domain>/admin` and paste that same string in.

**Like the cluster heuristics, this is a signal, not proof.** A shared IP — an office, a university, a VPN exit node, mobile carrier-grade NAT — can easily push several unrelated people's wallet checks through the same address and light this up with zero bad intent. Treat a high count as "worth a closer look," never as a verdict on its own. Same persistence caveat as the usage stats: without a Volume mounted at `IP_ACTIVITY_DIR`/`STATS_DIR`, this resets on every redeploy (and the salt regenerates too, so old hashes simply stop matching — tracking just starts over cleanly).

## Deploying so it has a real, stable public URL

This is a single always-on Node process (`node server.js`), which fits **Railway** or **Render** with zero config. It does *not* fit Vercel's model as-is — Vercel wants separate serverless functions per route, not one persistent `http.createServer`; porting it there means splitting `server.js`'s route table into `/api/*.js` files, which isn't done here. Recommending Railway/Render below; ping me if you'd rather I do the Vercel split instead.

### Railway (recommended — free tier, ~5 minutes)

1. Push this folder to a new GitHub repo (Railway deploys from GitHub).
2. [railway.app](https://railway.app) → New Project → Deploy from GitHub repo → pick the repo.
3. Railway auto-detects Node, runs `npm install` (instant — no dependencies) then `npm start` (`node server.js`). No other config needed.
4. Settings → Networking → **Generate Domain** to get a public `*.up.railway.app` URL. Add a custom domain there too if you have one.

### Render

1. New → Web Service → connect the repo.
2. Build command: (leave empty / `npm install`). Start command: `node server.js`.
3. Free instance type works for testing; Render gives you a `*.onrender.com` URL immediately.

## Debugging live API assumptions (resolved, first production run)

This app was originally built in a sandbox with no access to `archive.prod.nado.xyz` / `docs.nado.xyz`, so the Nado Archive API client was written from a mix of incomplete docs and Vertex Protocol architectural similarity, then only unit-tested against synthetic data. Once it was actually deployed and scanned live traffic, two of those guesses turned out wrong — both now fixed, confirmed against the real docs:

- **Wrong base URL entirely.** The archive-indexer was being called at `https://archive.prod.nado.xyz/v1`, which 404s. The correct unified base is `https://api.prod.nado.xyz/archive/v1`. Fixed in `lib/nadoClient.js`.
- **`/matches` doesn't exist.** The mirror-trading scan's fill-fetching assumed a `/matches` + `/txs` pair (a Vertex-family shape). Nado's real per-subaccount endpoint is `/orders` (self-contained records, no separate `txs` array to join). Rewritten as `fetchOrders()` / `normalizeOrdersResponse()`. One real capability loss from this: the old code could pair up direct taker↔maker fills from the txs envelope; `/orders` carries no counterparty data, so that signal no longer fires — only the independent mirrored-open/close signal (comparing two wallets' own position changes) still works, which is the one that actually matters for the "duration/closing %" pattern this cluster was built around.
- **A real "list all markets" endpoint exists**: `GET {archive/v2 base}/symbols`, confirmed via docs. `getKnownProductIds()` now calls this first (also giving real ticker names) and only falls back to the old brute-force `oracle-price` ID-probing if it ever fails.
- **`/portfolio`'s real shape** is an array of `[period, seriesObject]` pairs (e.g. `[["day", {accountValueHistory: [...], ...}], ...]`), not an object keyed by `"1d"` the way `dashboard.html` and the checker route used to guess. Fixed via `pickPortfolioSeries()` in `lib/nadoClient.js` (and inline in `dashboard.html`, since that's client-side).
- **`Accept-Encoding` header requirement.** The archive-indexer docs require this header naming gzip/br/deflate; added explicitly to every archive/gateway request rather than relying on `fetch` setting one automatically.

A small **`GET /api/debug/probe`** route (see `server.js`) is left in place — safe, read-only, no secrets — to make the next live-data surprise faster to diagnose: it does a raw oracle-price probe, a raw symbols fetch, a raw orders fetch, a full base-URL × endpoint matrix probe (`?matrix=1`), and (with `?wallet=0x...`) times a single first-funder lookup, surfacing the real error/timing instead of whatever a normal route's `.catch()` would swallow.

### Confirmed blocking issue: `/orders`, `/portfolio`, `/oracle-price` are unreachable

A matrix probe (`/api/debug/probe?matrix=1`) tested all three of these endpoints against **every** documented base URL variant (`archive/v1` and `archive/v2`, unified `api.prod.nado.xyz` and legacy `archive.prod.nado.xyz` hosts — 12 combinations total). **All twelve 404.** Meanwhile `GET .../archive/v2/symbols` (92 real markets) and `GET .../archive/v2/trades?ticker_id=...` (real trade data) both work fine at 200. So this isn't a config mistake on this app's side — the archive-indexer endpoint family that `/orders`, `/portfolio`, and `/oracle-price` belong to appears to not actually be live at any reachable path, despite being documented at docs.nado.xyz.

Practical effect:

- **Cluster #2 (mirror trading) cannot function as originally designed.** It needs per-wallet trade attribution, which only `/orders` provides — the working `/trades` feed is anonymized (no wallet/subaccount field at all, just price/size/timestamp). There is currently no public Nado endpoint that exposes which wallet made which trade.
- **Wallet portfolio value/volume (Dashboard "look up a wallet" and Checker) cannot be fetched** — that data lives behind `/portfolio`, same story.

Rather than silently return an empty-looking result that reads as "scanned, found nothing", both surfaces now say explicitly that the data source is unreachable:

- `fetchGlobalFills()` in `lib/aggregate.js` tracks whether every single `/orders` request it made actually errored (not just "came back with zero rows") and sets `ordersUnavailable: true` + a plain-English `error` message when so.
- `GET /api/clusters/mirror` and `GET /api/checker` both pass this through; `clusters.html` and `checker.html` render it as an explicit warning box instead of "no clusters found in this window".

**If this ever changes** (Nado deploys the endpoint, or support points at a different path), the fix is entirely inside `fetchOrders()`/`ARCHIVE_BASE` in `lib/nadoClient.js` — nothing else needs to change, since the rest of the pipeline already assumes `/orders`' real response shape.

**Still open / worth re-checking if something looks off:**

1. **The common-funding-source scan (cluster #3) erroring out (502) even on small windows.** This doesn't touch Nado's API at all — it's pure Ink Explorer (`fetchFirstFunder`, `fetchGlobalDeposits`). Current best guess is real-world pagination latency exceeding Railway's request timeout; `/api/debug/probe?wallet=0x...` reports elapsed time for one such lookup to help confirm — not yet tested against a real wallet address.
2. **`/addresses/{address}/transactions?filter=to` support, and `is_contract`/`public_tags` fields** for the automatic exchange-detection heuristic (`isLikelyInfrastructure()`) — standard Blockscout v2 fields per its docs, still not independently exercised against a live response.
3. **Exchange wallet exclude list is empty.** `lib/exchangeWallets.js` ships with no real addresses in it. See "Excluding exchange wallets" above for how to fill it in.

If any of these need adjusting, the fix is localized — each item above points at the specific file/function.

## Design

No screenshot/browser access was available while building this, so the look is a deliberate "dark trading-terminal" aesthetic *inspired by* Nado's positioning (fast CLOB DEX) rather than a pixel-accurate copy of nado.xyz's actual branding — colors, fonts and logo are original, not extracted from Nado's site. If you send a screenshot or the logo file, the palette in `public/style.css` (`:root` variables at the top) is a five-minute edit to match exactly.

## Project layout

```
server.js              plain Node http server: static pages + /api/* routes
lib/
  subaccount.js         wallet <-> Nado bytes32 subaccount id
  fixedpoint.js          X18 / token-decimal number parsing, ±% tolerance helper
  nadoClient.js          Nado Archive + Gateway API client
  inkExplorer.js          Blockscout (Ink Explorer) API client
  defillama.js            DefiLlama TVL client
  clusters.js              the three detection algorithms (pure, unit-tested)
  aggregate.js             glue: paginated scans -> normalized events -> clusters
  unionFind.js            small union-find for graph clustering
  exchangeWallets.js      exclude-list for cluster #3's "funding hub" check
  params.js               pure query-param parsers (testable without a live server)
  stats.js                 usage counters (site visits, wallets checked), JSON-file backed
  ipActivity.js            admin-only abuse signal: hashed per-IP distinct-wallet-check counts
public/                  dashboard.html, clusters.html, checker.html, admin.html, style.css, app.js
data/                    runtime-created; stats.json + ip-activity.json live here — gitignored
test/clusters.test.js    unit tests for lib/clusters.js (node --test, no deps)
```
