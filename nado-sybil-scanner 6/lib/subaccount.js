// Derives a Nado/Vertex-style bytes32 "subaccount" identifier from a plain
// EVM wallet address + a human-readable subaccount name (defaults to "default").
//
// Layout (32 bytes total):
//   [ 20 bytes wallet address ][ up to 12 bytes ascii name, right-padded with 0x00 ]
//
// Confirmed against the worked example in Nado's docs:
//   wallet 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb + name "default"
//   -> 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb64656661756c740000000000

const NAME_BYTES = 12;

export function isAddress(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

export function normalizeAddress(address) {
  if (!isAddress(address)) {
    throw new Error(`Not a valid EVM address: ${address}`);
  }
  return address.trim().toLowerCase();
}

export function toSubaccount(address, name = "default") {
  const addr = normalizeAddress(address).slice(2); // strip 0x, 40 hex chars
  const nameBytes = Buffer.from(name, "ascii");
  if (nameBytes.length > NAME_BYTES) {
    throw new Error(`Subaccount name too long (max ${NAME_BYTES} bytes): ${name}`);
  }
  const nameHex = nameBytes.toString("hex").padEnd(NAME_BYTES * 2, "0");
  return `0x${addr}${nameHex}`;
}

// Inverse: pull the 20-byte wallet address back out of a bytes32 subaccount id.
export function addressFromSubaccount(subaccount) {
  if (typeof subaccount !== "string") return null;
  const hex = subaccount.startsWith("0x") ? subaccount.slice(2) : subaccount;
  if (hex.length < 40) return null;
  return `0x${hex.slice(0, 40)}`.toLowerCase();
}

// Best-effort: pull the subaccount "name" (trailing bytes, ascii, zeros stripped).
export function nameFromSubaccount(subaccount) {
  if (typeof subaccount !== "string") return null;
  const hex = subaccount.startsWith("0x") ? subaccount.slice(2) : subaccount;
  if (hex.length <= 40) return "";
  const nameHex = hex.slice(40).replace(/0+$/, "");
  if (nameHex.length % 2 !== 0) return null;
  try {
    return Buffer.from(nameHex, "hex").toString("ascii");
  } catch {
    return null;
  }
}
