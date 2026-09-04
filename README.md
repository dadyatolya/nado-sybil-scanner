# Sybil Scanner for Nado

An unofficial community tool for the [Nado](https://www.nado.xyz) DEX (Ink L2, Kraken's chain). Three pages:

- **Dashboard** — Nado's protocol-wide TVL, plus a wallet lookup showing that wallet's value in Nado over time.
- **Clusters** — live scan for two Sybil-wallet patterns.
- **Checker** — paste a wallet address, see its trading volume and whether it lands inside either cluster.

## The two cluster heuristics

1. **Funding pattern.** Two *different* wallets deposit near-identical amounts (≤5% apart) within 10 minutes of each other. Chains of matching pairs are grouped transitively (A↔B, B↔C ⇒ one 3-wallet cluster).
2. **Mirror trading.** Two different wallets open opposite-side positions (one long, one short) on the same market within 15 seconds, size within 5%, *and* later close them the same way too. A pair only counts once it has **≥10** such matched trades. Direct repeated taker↔maker matches between the same two wallets (i.e. they keep trading directly against each other rather than the broader book) are treated as an even stronger version of the same signal.

Both are graph-clustered with union-find: any two wallets connected by a qualifying match end up in the same cluster, and clusters transitively absorb more members.

**These are statistical heuristics, not proof.** Correlated deposits and offsetting trades can happen for innocent reasons (an exchange's hot wallet, a market maker, friends funding at the same time). Treat flags as a starting point for investigation, not a verdict — the UI says as much on every page.

## Data sources

| Data | Source | Why |
|---|---|---|
| Global TVL | [DefiLlama](https://defillama.com/protocol/nado) (`api.llama.fi`) | Already tracks Nado; no need to re-derive TVL from every collateral asset's price ourselves. |
| On-chain deposits (cluster #1) | **Ink Explorer** (Blockscout, `explorer.inkonchain.com`) — incoming USDT0 transfers to Nado's `Clearinghouse` contract | Deposits are on-chain transactions, so the block explorer sees them directly. |
| Trades / fills (cluster #2, wallet trade history) | **Nado's own Archive API** (`archive.prod.nado.xyz`) | Nado's trading engine is an **off-chain sequencer** — individual long/short opens and closes never touch the chain, only periodic settlement does. The block explorer literally cannot see them; Nado's own indexer is the only place this data exists. |
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
| `NADO_ARCHIVE_BASE` | `https://archive.prod.nado.xyz/v1` |
| `NADO_GATEWAY_BASE` | `https://gateway.prod.nado.xyz/v1` |
| `INK_EXPLORER_BASE` | `https://explorer.inkonchain.com` |

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

## Known unknowns — verify once this is live

I built this against Nado's published docs (`docs.nado.xyz`) and Blockscout's standard v2 API, but **this sandbox's network access is restricted to a short allowlist** (couldn't reach `archive.prod.nado.xyz` or `explorer.inkonchain.com` from here even during development), so none of the live API calls were tested end-to-end — only the pure detection logic was (11 passing unit tests in `test/clusters.test.js`, using synthetic data). Once deployed somewhere with normal internet access, worth checking:

1. **`/portfolio` response shape.** The docs describe "8 series as `[period, history]` pairs" without a concrete JSON example. `dashboard.html` and `server.js`'s checker route try a couple of plausible shapes (`portfolio.accountValueHistory`, `portfolio["1d"].accountValueHistory`, etc.) and fail soft to "—" / `null` if none match — so nothing crashes, but the account-value and volume numbers may just show as empty until the real field path is confirmed and adjusted (one-line fix in `dashboard.html`'s `lookupWallet()` and `server.js`'s checker route).
2. **Market/product discovery.** There's no confirmed "list all markets" endpoint in the reachable docs, so `lib/nadoClient.js`'s `discoverProductIds()` brute-force-probes product IDs 0–40 via the cheap `oracle-price` query and keeps whichever respond. Works, but if Nado has a real `/symbols` or `/products` endpoint it'd be faster and would also give you readable ticker names instead of bare IDs — worth a look at `docs.nado.xyz/developer-resources/api/v2` (its "Archive" section mentions `symbols`/`tickers`).
3. **Whether the Archive API needs auth for reads.** Nothing in the docs suggested an API key for read-only queries (`matches`, `events`, `portfolio`), but this was never confirmed against a real 200 response.
4. **`matches` pagination direction.** Implemented as: fetch newest page, take the minimum `submission_idx` in it, request `idx = that - 1` for the next (older) page, stop once a page's oldest timestamp falls before the scan window. This matches the documented cursor semantics but wasn't run against live data.

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
  clusters.js              the two detection algorithms (pure, unit-tested)
  aggregate.js             glue: paginated scans -> normalized events -> clusters
  unionFind.js            small union-find for graph clustering
public/                  dashboard.html, clusters.html, checker.html, style.css, app.js
test/clusters.test.js    unit tests for lib/clusters.js (node --test, no deps)
```
