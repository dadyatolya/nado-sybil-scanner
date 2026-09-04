// Shared helpers used by all three pages. Plain script, no build step —
// loaded with a plain <script src="/app.js"> tag.

function renderNav(active) {
  const items = [
    { href: "/", label: "Dashboard", key: "dashboard" },
    { href: "/clusters", label: "Clusters", key: "clusters" },
    { href: "/checker", label: "Checker", key: "checker" },
  ];
  document.getElementById("nav").innerHTML = items
    .map((i) => `<a href="${i.href}" class="${i.key === active ? "active" : ""}">${i.label}</a>`)
    .join("");
}

async function fetchJson(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return body;
}

function fmtUsd(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const abs = Math.abs(n);
  const opts = abs >= 1000 ? { maximumFractionDigits: 0 } : { maximumFractionDigits: 2 };
  return "$" + Number(n).toLocaleString("en-US", opts);
}

function fmtAddr(addr) {
  if (!addr) return "—";
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

function isValidAddress(v) {
  return /^0x[0-9a-fA-F]{40}$/.test((v || "").trim());
}

function walletChip(addr, youAddr) {
  const mine = youAddr && addr.toLowerCase() === youAddr.toLowerCase();
  return `<span class="wallet-chip${mine ? " you" : ""}" title="${addr}">${fmtAddr(addr)}${mine ? " (this address)" : ""}</span>`;
}

function errorBox(message) {
  return `<div class="error-box">${escapeHtml(message)}</div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderDepositClusterCard(cluster, youAddr) {
  const evidence = cluster.edges
    .flatMap((e) => e.matches)
    .slice(0, 8)
    .map(
      (m) =>
        `<tr><td class="mono">${fmtAddr(m.walletA)}</td><td class="mono">${fmtUsd(m.amountA)}</td><td class="mono">${fmtAddr(
          m.walletB
        )}</td><td class="mono">${fmtUsd(m.amountB)}</td><td class="mono">${m.deltaSeconds}s</td></tr>`
    )
    .join("");
  return `
    <div class="cluster-card">
      <div class="field-row" style="justify-content: space-between;">
        <strong>${cluster.id} · ${cluster.size} wallets</strong>
        <span class="badge warn">funding pattern</span>
      </div>
      <div class="members">${cluster.members.map((m) => walletChip(m, youAddr)).join("")}</div>
      <details>
        <summary>${cluster.edges.reduce((n, e) => n + e.matches.length, 0)} matched deposit pairs — show evidence</summary>
        <table>
          <thead><tr><th>Wallet A</th><th>Amount A</th><th>Wallet B</th><th>Amount B</th><th>Δt</th></tr></thead>
          <tbody>${evidence}</tbody>
        </table>
      </details>
    </div>`;
}

function renderMirrorClusterCard(cluster, youAddr) {
  const allMatches = cluster.edges.flatMap((e) => e.matches);
  const directCount = allMatches.filter((m) => m.type === "direct_counterparty").length;
  const openCount = allMatches.filter((m) => m.type === "mirrored_open").length;
  const closeCount = allMatches.filter((m) => m.type === "mirrored_close").length;
  const evidence = allMatches
    .slice(0, 8)
    .map((m) => {
      if (m.type === "direct_counterparty") {
        return `<tr><td class="mono">direct</td><td class="mono">${m.product}</td><td class="mono">${fmtUsd(m.size)}</td><td class="mono">0s</td></tr>`;
      }
      return `<tr><td class="mono">${m.type === "mirrored_open" ? "open" : "close"}</td><td class="mono">${m.product}</td><td class="mono">${fmtUsd(
        m.sizeA
      )} / ${fmtUsd(m.sizeB)}</td><td class="mono">${m.deltaSeconds}s</td></tr>`;
    })
    .join("");
  return `
    <div class="cluster-card">
      <div class="field-row" style="justify-content: space-between;">
        <strong>${cluster.id} · ${cluster.size} wallets</strong>
        <span class="badge danger">mirror trading</span>
      </div>
      <div class="members">${cluster.members.map((m) => walletChip(m, youAddr)).join("")}</div>
      <p class="faint">${directCount} direct counterparty fills · ${openCount} mirrored opens · ${closeCount} mirrored closes</p>
      <details>
        <summary>show evidence</summary>
        <table>
          <thead><tr><th>Type</th><th>Market</th><th>Size</th><th>Δt</th></tr></thead>
          <tbody>${evidence}</tbody>
        </table>
      </details>
    </div>`;
}
