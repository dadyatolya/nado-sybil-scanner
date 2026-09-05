// Minimal in-memory background job runner.
//
// Why this exists: a genuine "all time" scan (especially cluster #3, common
// funding source — up to two Ink Explorer lookups *per depositor* across
// Nado's entire history) can legitimately take minutes. A normal HTTP
// request/response can't stay open that long — Railway's own reverse proxy
// (like most platforms') times out a request well before that, which is
// exactly what caused the bare, empty-handed 502s seen during the first
// production run on the "24 hours" default window, let alone all-time.
//
// The fix isn't a bigger budget inside one request — it's not doing this
// synchronously at all. This app is a long-lived Node process on Railway
// (not a serverless function that dies between requests), so a scan can
// keep running in the background after the "start" call already returned.
// The browser then polls a cheap status endpoint every couple of seconds
// instead of holding one connection open for as long as the scan takes.
//
// State lives in memory only: it's lost on a redeploy/restart. That's fine
// here — a scan is cheap to re-kick-off, and nothing here needs to survive
// a deploy.

// Explicit import rather than relying on the bare global `crypto` —
// globalThis.crypto without an import isn't available on every Node 18.x
// build (it only became unconditionally global in later 18.x/20.x releases),
// and this app's package.json only requires >=18.17. `node:crypto`'s
// `randomUUID` has been stable since Node 14.17, so this works everywhere
// the app is actually meant to run.
import { randomUUID } from "node:crypto";

const jobs = new Map();
const MAX_JOBS = 50; // simple cap so a chatty client can't leak memory forever

function pruneOldJobs() {
  if (jobs.size <= MAX_JOBS) return;
  const sorted = [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt);
  for (const job of sorted.slice(0, jobs.size - MAX_JOBS)) {
    jobs.delete(job.id);
  }
}

/** Starts `run()` in the background and returns immediately with a job
 * record the caller can hand back to the client as a job id. `run` is a
 * zero-arg async function returning the eventual result (or throwing). */
export function startJob(kind, params, run) {
  const id = randomUUID();
  const job = {
    id,
    kind,
    params,
    status: "running",
    startedAt: Date.now(),
    finishedAt: null,
    result: null,
    error: null,
  };
  jobs.set(id, job);
  pruneOldJobs();

  // Intentionally not awaited: the whole point is that the HTTP handler
  // calling startJob() can respond right away with the job id while this
  // keeps running on its own.
  run()
    .then((result) => {
      job.status = "done";
      job.result = result;
      job.finishedAt = Date.now();
    })
    .catch((err) => {
      job.status = "error";
      job.error = err?.message || String(err);
      job.finishedAt = Date.now();
    });

  return job;
}

export function getJob(id) {
  return jobs.get(id) || null;
}
