// Crash-recovery checkpoints for the "all time" background scans.
//
// Why this exists: an all-time scan can run for up to an hour and holds its
// running results only in memory (see lib/jobs.js). If the process dies
// mid-scan — an OOM kill from Railway's memory limit being the realistic way
// this happens, since these scans hold ever-growing arrays for as long as
// they run — the in-memory job is gone with it, and a fresh container starts
// from zero. The previous behavior was to just lose the whole run and start
// over. This gives the scan a way to periodically save its own progress to
// disk (the same persistent-Volume-backed directory as lib/stats.js, so it
// survives the same restart that kills the in-memory job) so that if it does
// get killed, whatever it found up to the last checkpoint can still be
// reported instead of nothing.
//
// This is deliberately NOT a resumable-scan mechanism (it doesn't re-start
// the walk from where it left off — that would need remembering Blockscout's
// opaque pagination cursor across a process restart, which is more machinery
// than the actual ask here). It's a "don't lose the work already done"
// safety net: if a scan dies, the next server start (or the next status poll)
// can see the last checkpoint and hand back a clearly-labeled partial result.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const CHECKPOINT_DIR = process.env.STATS_DIR || path.join(process.cwd(), "data");
const KNOWN_KINDS = ["deposits", "funding"];

function checkpointFile(kind) {
  return path.join(CHECKPOINT_DIR, `checkpoint-${kind}.json`);
}

let writeQueue = Promise.resolve();

/** Overwrite the checkpoint for `kind` with the given snapshot. Fire-and-forget
 * from the caller's point of view — never awaited by the scan loop itself, so
 * a slow disk can't slow down the actual scanning. `data` should be small
 * enough to write every few seconds without issue (a list of wallet
 * addresses / funding edges — tens of thousands of short strings at most,
 * not the full raw Explorer responses). */
export function saveCheckpoint(kind, data) {
  if (!KNOWN_KINDS.includes(kind)) return Promise.resolve();
  const snapshot = JSON.stringify({ kind, updatedAt: Date.now(), ...data });
  writeQueue = writeQueue
    .then(() => mkdir(CHECKPOINT_DIR, { recursive: true }))
    .then(() => writeFile(checkpointFile(kind), snapshot, "utf8"))
    .catch((err) => console.error(`[checkpoint:${kind}] failed to persist:`, err.message));
  return writeQueue;
}

/** Read back the last checkpoint for `kind`, or null if there isn't one (no
 * scan of that kind has ever checkpointed, or the file is missing/corrupt). */
export async function loadCheckpoint(kind) {
  if (!KNOWN_KINDS.includes(kind)) return null;
  try {
    const raw = await readFile(checkpointFile(kind), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
