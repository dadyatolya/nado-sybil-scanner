// Privacy-conscious tracking of which client IPs have used the Checker to
// look up many different wallets. Rationale: a lazy Sybil-farm operator
// checking whether their own controlled wallets got flagged would tend to
// run many different addresses through the Checker from one machine/IP —
// a classic "self-auditing" signal, same idea as the other cluster
// heuristics but based on *who is asking* instead of on-chain behavior.
//
// Raw IP addresses are never stored. Each IP is hashed (SHA-256, truncated,
// salted) before being kept in memory / on disk, so the stored data cannot
// be reversed back into an IP address. Nothing here is exposed on a public
// route — see server.js's /api/admin/suspicious-ips, which is gated behind
// the ADMIN_KEY env var (disabled entirely if that var is unset).
//
// Same persistence caveats as lib/stats.js: JSON file under
// IP_ACTIVITY_DIR (defaults to ./data, falls back to STATS_DIR), wiped on
// redeploy unless a persistent Volume is mounted. If the salt itself
// resets (e.g. a redeploy with no volume), old hashes stop matching new
// ones — tracking just restarts cleanly, same as the visit counters.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import path from "node:path";

const IP_ACTIVITY_DIR = process.env.IP_ACTIVITY_DIR || process.env.STATS_DIR || path.join(process.cwd(), "data");
const IP_ACTIVITY_FILE = path.join(IP_ACTIVITY_DIR, "ip-activity.json");

function makeSalt() {
  return process.env.IP_SALT || randomBytes(16).toString("hex");
}

function freshState() {
  return { salt: makeSalt(), ips: {} }; // hash -> { wallets: Set<string>, firstSeen, lastSeen, checks }
}

let state = null;
let writeQueue = Promise.resolve();

async function load() {
  if (state) return state;
  try {
    const raw = await readFile(IP_ACTIVITY_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const ips = {};
    for (const [hash, entry] of Object.entries(parsed.ips || {})) {
      ips[hash] = { ...entry, wallets: new Set(Array.isArray(entry.wallets) ? entry.wallets : []) };
    }
    state = { salt: process.env.IP_SALT || parsed.salt || makeSalt(), ips };
  } catch {
    state = freshState(); // no file yet, or unreadable — start from zero rather than fail the request
  }
  return state;
}

function persist() {
  const snapshot = JSON.stringify({
    salt: state.salt,
    ips: Object.fromEntries(
      Object.entries(state.ips).map(([hash, entry]) => [hash, { ...entry, wallets: [...entry.wallets] }])
    ),
  });
  writeQueue = writeQueue
    .then(() => mkdir(IP_ACTIVITY_DIR, { recursive: true }))
    .then(() => writeFile(IP_ACTIVITY_FILE, snapshot, "utf8"))
    .catch((err) => console.error("[ipActivity] failed to persist:", err.message));
  return writeQueue;
}

function hashIp(ip) {
  return createHash("sha256").update(state.salt + ip).digest("hex").slice(0, 20);
}

/** Extract the real client IP from a request, accounting for Railway's (and
 * most PaaS's) reverse proxy: the X-Forwarded-For header's first entry is
 * the original client. Falls back to the raw socket address. Returns null
 * if nothing usable is found — never throws. */
export function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) {
    return xff.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || null;
}

/** Call once per successful /api/checker lookup. Fire-and-forget — never
 * blocks the response. `ip` may be null (e.g. local dev with no proxy in
 * front), in which case this is a no-op. */
export async function recordCheckerIp(ip, address) {
  if (!ip) return;
  await load();
  const hash = hashIp(ip);
  const now = new Date().toISOString();
  const entry = state.ips[hash] || { wallets: new Set(), firstSeen: now, checks: 0 };
  entry.wallets.add(address.toLowerCase());
  entry.checks += 1;
  entry.lastSeen = now;
  state.ips[hash] = entry;
  persist();
}

/** Admin-only read: IPs (as opaque hashes — never the real IP) that have
 * checked more than `minWallets` distinct wallets, sorted by distinct-wallet
 * count descending. This is a heuristic signal, not proof: shared IPs
 * (offices, VPNs, mobile carrier-grade NAT) can trigger false positives. */
export async function getSuspiciousIps({ minWallets = 6 } = {}) {
  await load();
  return Object.entries(state.ips)
    .map(([hash, entry]) => ({
      ipHash: hash,
      distinctWallets: entry.wallets.size,
      totalChecks: entry.checks,
      firstSeen: entry.firstSeen,
      lastSeen: entry.lastSeen,
    }))
    .filter((e) => e.distinctWallets >= minWallets)
    .sort((a, b) => b.distinctWallets - a.distinctWallets);
}
