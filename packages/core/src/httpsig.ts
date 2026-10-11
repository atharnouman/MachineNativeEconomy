import { createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as edSign, verify as edVerify, type KeyObject, type JsonWebKey } from "node:crypto";

/** Bounded memory of seen (keyid, nonce) pairs for replay protection; oldest entries are evicted. */
export class NonceWindow {
  private readonly seen = new Map<string, number>();
  constructor(private readonly max = 10_000) {}
  /** Returns true if the nonce was already seen for this key (and records it otherwise). */
  seenBefore(nonce: string, keyid: string): boolean {
    const k = `${keyid}:${nonce}`;
    if (this.seen.has(k)) return true;
    this.seen.set(k, Date.now());
    if (this.seen.size > this.max) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return false;
  }
}

/**
 * RFC 9421 HTTP Message Signatures with Ed25519, in the shape used by Web Bot Auth
 * (draft-meunier-web-bot-auth-architecture) and compatible with Visa's Trusted Agent Protocol:
 *
 *   Signature-Input: sig1=("@authority" "signature-agent");created=…;expires=…;keyid="<jwk thumbprint>";alg="ed25519";nonce="…";tag="web-bot-auth"
 *   Signature:       sig1=:<base64>:
 *   Signature-Agent: "https://gateway.example"
 *
 * Two uses in SpendMarshal:
 *   - outbound: the gateway signs every request it makes to a payee on behalf of an agent, and publishes its
 *     keys at /.well-known/http-message-signatures-directory, so a payee can tell a governed agent from a bot
 *   - inbound: a credential can be bound to a holder key (`holder_key` caveat); requests using it must carry a
 *     valid signature from that key, so a leaked bearer credential is useless on its own
 *
 * Only the subset of RFC 8941 structured fields needed for these shapes is implemented (inner lists of
 * strings, string / integer parameters).
 */

export interface Ed25519Jwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string; // base64url public key
  d?: string; // base64url private seed (never published)
  kid?: string;
}

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** Deterministic Ed25519 key from a secret: HMAC-SHA256(secret, label) is the 32-byte seed. */
export function ed25519FromSecret(secret: string, label: string): { privateKey: KeyObject; publicKey: KeyObject; jwk: Ed25519Jwk; publicJwk: Ed25519Jwk; keyid: string } {
  const seed = createHmac("sha256", secret).update(label).digest();
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
  return describeKey(privateKey);
}

export function ed25519Generate(): ReturnType<typeof ed25519FromSecret> {
  const { privateKey } = generateKeyPairSync("ed25519");
  return describeKey(privateKey);
}

export function ed25519FromJwk(jwk: Ed25519Jwk): ReturnType<typeof ed25519FromSecret> {
  if (!jwk.d) throw new Error("private JWK (d) required");
  const key: JsonWebKey = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, d: jwk.d };
  return describeKey(createPrivateKey({ key, format: "jwk" }));
}

function describeKey(privateKey: KeyObject) {
  const publicKey = createPublicKey(privateKey);
  const jwk = privateKey.export({ format: "jwk" }) as Ed25519Jwk;
  const publicJwk: Ed25519Jwk = { kty: "OKP", crv: "Ed25519", x: jwk.x };
  const keyid = jwkThumbprint(publicJwk);
  return { privateKey, publicKey, jwk: { ...jwk, kid: keyid }, publicJwk: { ...publicJwk, kid: keyid }, keyid };
}

/** RFC 7638 JWK thumbprint (base64url SHA-256 over the canonical required members). */
export function jwkThumbprint(jwk: Pick<Ed25519Jwk, "kty" | "crv" | "x">): string {
  return createHash("sha256").update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })).digest("base64url");
}

export function publicKeyFromJwk(jwk: Pick<Ed25519Jwk, "kty" | "crv" | "x">): KeyObject {
  return createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: "jwk" });
}

/** RFC 9530 Content-Digest field value for a body. */
export function contentDigest(body: string | Uint8Array): string {
  return `sha-256=:${createHash("sha256").update(body).digest("base64")}:`;
}

// ───────────────────────────── structured-field helpers (subset) ─────────────────────────────

const sfString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export interface SignatureParams {
  created: number;
  expires?: number;
  keyid: string;
  alg?: string;
  nonce?: string;
  tag?: string;
}

function serializeInnerList(components: string[], p: SignatureParams): string {
  let out = `(${components.map(sfString).join(" ")})`;
  out += `;created=${p.created}`;
  if (p.expires !== undefined) out += `;expires=${p.expires}`;
  out += `;keyid=${sfString(p.keyid)}`;
  if (p.alg) out += `;alg=${sfString(p.alg)}`;
  if (p.nonce) out += `;nonce=${sfString(p.nonce)}`;
  if (p.tag) out += `;tag=${sfString(p.tag)}`;
  return out;
}

function parseInnerList(s: string): { components: string[]; params: Record<string, string | number> } {
  const m = /^\(([^)]*)\)(.*)$/.exec(s.trim());
  if (!m) throw new Error("malformed inner list");
  const components = [...m[1]!.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]!.replace(/\\(.)/g, "$1"));
  const params: Record<string, string | number> = {};
  for (const pm of m[2]!.matchAll(/;\s*([a-z][a-z0-9_\-.*]*)(?:=("(?:[^"\\]|\\.)*"|-?\d+))?/g)) {
    const key = pm[1]!;
    const raw = pm[2];
    if (raw === undefined) params[key] = "";
    else if (raw.startsWith('"')) params[key] = raw.slice(1, -1).replace(/\\(.)/g, "$1");
    else params[key] = Number(raw);
  }
  return { components, params };
}

// ───────────────────────────── signature base ─────────────────────────────

export interface MessageLike {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
}

function componentValue(name: string, msg: MessageLike): string {
  const u = new URL(msg.url);
  switch (name) {
    case "@method":
      return msg.method.toUpperCase();
    case "@authority":
      return u.host.toLowerCase();
    case "@scheme":
      return u.protocol.replace(":", "");
    case "@target-uri":
      return u.href;
    case "@path":
      return u.pathname || "/";
    case "@query":
      return u.search || "?";
    default: {
      if (name.startsWith("@")) throw new Error(`unsupported derived component ${name}`);
      const v = findHeader(msg.headers, name);
      if (v === undefined) throw new Error(`missing header ${name}`);
      return v.trim().replace(/\s*\n\s*/g, " ");
    }
  }
}

function findHeader(headers: Record<string, string | undefined>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === lower && v !== undefined) return v;
  return undefined;
}

export function signatureBase(msg: MessageLike, components: string[], params: SignatureParams): string {
  const lines = components.map((c) => `${sfString(c.toLowerCase())}: ${componentValue(c.toLowerCase(), msg)}`);
  lines.push(`"@signature-params": ${serializeInnerList(components.map((c) => c.toLowerCase()), params)}`);
  return lines.join("\n");
}

// ───────────────────────────── sign / verify ─────────────────────────────

export interface SignOptions {
  privateKey: KeyObject;
  keyid: string;
  components: string[];
  label?: string;
  tag?: string;
  nonce?: string;
  created?: number;
  ttlSeconds?: number;
}

/** Returns the headers to add. Pass the request's existing headers (incl. Content-Digest / Signature-Agent if covered). */
export function signMessage(msg: MessageLike, opts: SignOptions): { "signature-input": string; signature: string } {
  const label = opts.label ?? "sig1";
  const created = opts.created ?? Math.floor(Date.now() / 1000);
  const params: SignatureParams = {
    created,
    expires: created + (opts.ttlSeconds ?? 300),
    keyid: opts.keyid,
    alg: "ed25519",
    nonce: opts.nonce ?? randomBytes(16).toString("base64url"),
    tag: opts.tag,
  };
  const base = signatureBase(msg, opts.components, params);
  const sig = edSign(null, Buffer.from(base, "utf8"), opts.privateKey);
  return {
    "signature-input": `${label}=${serializeInnerList(opts.components.map((c) => c.toLowerCase()), params)}`,
    signature: `${label}=:${sig.toString("base64")}:`,
  };
}

export interface VerifyOptions {
  /** Resolve the public key for a keyid (and the Signature-Agent value when present). */
  resolveKey: (keyid: string, signatureAgent?: string) => Promise<KeyObject | undefined> | KeyObject | undefined;
  /** Components that must be covered (e.g. ["@authority", "signature-agent"]). */
  requireComponents?: string[];
  requireTag?: string;
  now?: number;
  maxSkewSeconds?: number;
  /** Optional replay guard: return false if this nonce was seen before. */
  nonceSeen?: (nonce: string, keyid: string) => boolean;
}

export type VerifyResult = { ok: true; keyid: string; label: string; components: string[]; params: Record<string, string | number> } | { ok: false; reason: string };

export async function verifyMessage(msg: MessageLike, opts: VerifyOptions): Promise<VerifyResult> {
  const input = findHeader(msg.headers, "signature-input");
  const sigHeader = findHeader(msg.headers, "signature");
  if (!input || !sigHeader) return { ok: false, reason: "missing Signature-Input or Signature" };
  const im = /^\s*([A-Za-z][A-Za-z0-9_\-]*)=(.*)$/s.exec(input);
  if (!im) return { ok: false, reason: "malformed Signature-Input" };
  const label = im[1]!;
  let parsed: ReturnType<typeof parseInnerList>;
  try {
    parsed = parseInnerList(im[2]!);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  const sm = new RegExp(`(?:^|,)\\s*${label}=:([A-Za-z0-9+/=]+):`).exec(sigHeader);
  if (!sm) return { ok: false, reason: `no Signature for label ${label}` };
  const { components, params } = parsed;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const skew = opts.maxSkewSeconds ?? 60;
  if (typeof params.created !== "number") return { ok: false, reason: "missing created" };
  if (params.created > now + skew) return { ok: false, reason: "created in the future" };
  if (typeof params.expires === "number" && params.expires < now - skew) return { ok: false, reason: "signature expired" };
  if (typeof params.expires !== "number" && now - params.created > 300) return { ok: false, reason: "signature too old" };
  if (params.alg !== undefined && params.alg !== "ed25519") return { ok: false, reason: `unsupported alg ${params.alg}` };
  if (opts.requireTag && params.tag !== opts.requireTag) return { ok: false, reason: `tag ${params.tag ?? "(none)"} is not ${opts.requireTag}` };
  for (const c of opts.requireComponents ?? []) if (!components.includes(c.toLowerCase())) return { ok: false, reason: `component ${c} not covered` };
  const keyid = String(params.keyid ?? "");
  if (!keyid) return { ok: false, reason: "missing keyid" };
  if (opts.nonceSeen && typeof params.nonce === "string" && opts.nonceSeen(params.nonce, keyid)) return { ok: false, reason: "nonce replayed" };
  const key = await opts.resolveKey(keyid, findHeader(msg.headers, "signature-agent")?.replace(/^"|"$/g, ""));
  if (!key) return { ok: false, reason: `unknown key ${keyid}` };
  let base: string;
  try {
    base = signatureBase(msg, components, {
      created: params.created,
      expires: typeof params.expires === "number" ? params.expires : undefined,
      keyid,
      alg: typeof params.alg === "string" ? params.alg : undefined,
      nonce: typeof params.nonce === "string" ? params.nonce : undefined,
      tag: typeof params.tag === "string" ? params.tag : undefined,
    });
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  const ok = edVerify(null, Buffer.from(base, "utf8"), key, Buffer.from(sm[1]!, "base64"));
  return ok ? { ok: true, keyid, label, components, params } : { ok: false, reason: "signature does not verify" };
}

// ───────────────────────────── Web Bot Auth conveniences ─────────────────────────────

export const WEB_BOT_AUTH_TAG = "web-bot-auth";
export const DIRECTORY_PATH = "/.well-known/http-message-signatures-directory";
export const DIRECTORY_CONTENT_TYPE = "application/http-message-signatures-directory+json";
export const HOLDER_TAG = "spendmarshal-holder";

/** Sign an outbound request as a Web Bot Auth agent. `signatureAgent` is the origin that serves the directory. */
export function signAsAgent(msg: MessageLike, key: { privateKey: KeyObject; keyid: string }, signatureAgent: string, body?: string | Uint8Array): Record<string, string> {
  const headers: Record<string, string> = { ...(Object.fromEntries(Object.entries(msg.headers).filter(([, v]) => v !== undefined)) as Record<string, string>), "signature-agent": `"${signatureAgent}"` };
  const components = ["@authority", "signature-agent", "@method", "@path"];
  if (body !== undefined) {
    headers["content-digest"] = contentDigest(body);
    components.push("content-digest");
  }
  const sig = signMessage({ ...msg, headers }, { ...key, components, tag: WEB_BOT_AUTH_TAG });
  return { "signature-agent": headers["signature-agent"]!, ...(headers["content-digest"] ? { "content-digest": headers["content-digest"] } : {}), ...sig };
}

/** Sign a request to the gateway with a credential's holder key (proof of possession). */
export function signAsHolder(msg: MessageLike, key: { privateKey: KeyObject; keyid: string }, body?: string | Uint8Array): Record<string, string> {
  const headers: Record<string, string> = Object.fromEntries(Object.entries(msg.headers).filter(([, v]) => v !== undefined)) as Record<string, string>;
  const components = ["@method", "@authority", "@path"];
  if (body !== undefined) {
    headers["content-digest"] = contentDigest(body);
    components.push("content-digest");
  }
  const sig = signMessage({ ...msg, headers }, { ...key, components, tag: HOLDER_TAG, ttlSeconds: 120 });
  return { ...(headers["content-digest"] ? { "content-digest": headers["content-digest"] } : {}), ...sig };
}

/** Verifies a Content-Digest header against the body if the header is present. */
export function contentDigestMatches(headers: Record<string, string | undefined>, body: string | Uint8Array | undefined): boolean {
  const h = findHeader(headers, "content-digest");
  if (!h) return body === undefined || body.length === 0;
  return body !== undefined && h.trim() === contentDigest(body);
}
