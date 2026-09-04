// Lightweight, dependency-free usage counters: how many times each page has
// been loaded, and how many (and how many *distinct*) wallets have been run
// through the Checker. This is deliberately simple — no cookies, no visitor
// fingerprinting, no bot filtering, a page refresh counts as another visit —
// so treat it as a rough "is anyone using this" signal (useful e.g. as
// traction evidence for a grant application), not real analytics. For
// trustworthy visitor analytics, use a dedicated tool instead.
//
// Persisted to a small JSON file so counts survive simple restarts. On a
// typical PaaS (Railway included) the container's filesystem is thrown away
// on every redeploy unless a persistent Volume is mounted at STATS_DIR — see
// README's "Usage stats" section for how to add one. Without a volume,
// expect these numbers to reset to zero each time new code is pushed.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const STATS_DIR = process.env.STATS_DIR || path.join(process.cwd(), "data");
const STATS_FILE = path.join(STATS_DIR, "stats.json");
const KNOWN_PAGES = ["dashboard", "clusters", "checker"];

function freshState() {
  return {
    since: new Date().toISOString(),
    totalVisits: 0,
    pageViews: { dashboard: 0, clusters: 0, checker: 0 },
    totalWalletChecks: 0,
    uniqueWalletsChecked: new Set(),
  };
}

let state = null;
let writeQueue = Promise.resolve();

async function load() {
  if (state) return state;
  try {
    const raw = await readFile(STATS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    state = {
      ...freshState(),
      ...parsed,
      uniqueWalletsChecked: new Set(Array.isArray(parsed.uniqueWalletsChecked) ? parsed.uniqueWalletsChecked : []),
    };
  } catch {
    state = freshState(); // no file yet, or unreadable — start from zero rather than fail the request
  }
  return state;
}

function persist() {
  // Serialize writes so two concurrent requests can't interleave their
  // writeFile calls and corrupt the file; each write reflects the full
  // current in-memory state, so a write that "loses" a race just gets
  // superseded by the next one moments later — no data is actually lost.
  const snapshot = JSON.stringify({ ...state, uniqueWalletsChecked: [...state.uniqueWalletsChecked] });
  writeQueue = writeQueue
    .then(() => mkdir(STATS_DIR, { recursive: true }))
    .then(() => writeFile(STATS_FILE, snapshot, "utf8"))
    .catch((err) => console.error("[stats] failed to persist:", err.message));
  return writeQueue;
}

/** Call once per page load. `page` is one of "dashboard" | "clusters" |
 * "checker". Fire-and-forget from the caller's point of view — never makes
 * the actual page response wait on a disk write. */
export async function recordPageView(page) {
  await load();
  state.totalVisits += 1;
  if (KNOWN_PAGES.includes(page)) state.pageViews[page] += 1;
  persist();
}

/** Call once per successful /api/checker lookup. */
export async function recordWalletCheck(address) {
  await load();
  const lower = address.toLowerCase();
  state.totalWalletChecks += 1;
  state.uniqueWalletsChecked.add(lower);
  persist();
}

export async function getStats() {
  await load();
  return {
    since: state.since,
    totalVisits: state.totalVisits,
    pageViews: { ...state.pageViews },
    totalWalletChecks: state.totalWalletChecks,
    uniqueWalletsChecked: state.uniqueWalletsChecked.size,
  };
}
