import { keccak256, toHex, type Hex } from "viem";

/** Deterministic JSON: sorted keys, no whitespace, bigint as decimal string, undefined dropped. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(sortDeep);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as Record<string, unknown>).sort()) {
    const x = (v as Record<string, unknown>)[k];
    if (x !== undefined) out[k] = sortDeep(x);
  }
  return out;
}

/** keccak256 over the canonical JSON encoding. */
export function hashJson(value: unknown): Hex {
  return keccak256(toHex(canonicalize(value)));
}

export function b64encode(obj: unknown): string {
  return Buffer.from(canonicalize(obj), "utf8").toString("base64");
}

export function b64decode<T = unknown>(s: string): T {
  return JSON.parse(Buffer.from(s, "base64").toString("utf8")) as T;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function randomId(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Buffer.from(bytes).toString("hex")}`;
}
