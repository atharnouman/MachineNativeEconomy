import { describe, it, expect } from "vitest";
import {
  ed25519FromSecret,
  ed25519Generate,
  jwkThumbprint,
  publicKeyFromJwk,
  signMessage,
  verifyMessage,
  signatureBase,
  signAsAgent,
  signAsHolder,
  contentDigest,
  contentDigestMatches,
  WEB_BOT_AUTH_TAG,
  HOLDER_TAG,
} from "../src/index.js";

const agent = ed25519FromSecret("gateway-secret", "httpsig");

describe("RFC 9421 signatures (Ed25519)", () => {
  it("derives a stable key with an RFC 7638 thumbprint", () => {
    const again = ed25519FromSecret("gateway-secret", "httpsig");
    expect(again.keyid).toBe(agent.keyid);
    expect(agent.keyid).toBe(jwkThumbprint(agent.publicJwk));
    expect(ed25519FromSecret("other", "httpsig").keyid).not.toBe(agent.keyid);
    expect(agent.publicJwk.d).toBeUndefined();
  });

  it("builds the signature base in the RFC layout", () => {
    const base = signatureBase(
      { method: "get", url: "https://Payee.Example:8443/v1/quote?symbol=ETH", headers: { "Signature-Agent": '"https://gw.example"' } },
      ["@authority", "signature-agent", "@method", "@path"],
      { created: 1700000000, expires: 1700000300, keyid: "k1", alg: "ed25519", nonce: "n1", tag: "web-bot-auth" },
    );
    expect(base).toBe(
      [
        '"@authority": payee.example:8443',
        '"signature-agent": "https://gw.example"',
        '"@method": GET',
        '"@path": /v1/quote',
        '"@signature-params": ("@authority" "signature-agent" "@method" "@path");created=1700000000;expires=1700000300;keyid="k1";alg="ed25519";nonce="n1";tag="web-bot-auth"',
      ].join("\n"),
    );
  });

  it("signs and verifies a Web Bot Auth request; tampering and wrong keys fail", async () => {
    const msg = { method: "GET", url: "http://127.0.0.1:4403/v1/quote?symbol=ETH", headers: { accept: "application/json" } };
    const sigHeaders = signAsAgent(msg, agent, "http://127.0.0.1:4402");
    expect(sigHeaders["signature-agent"]).toBe('"http://127.0.0.1:4402"');
    expect(sigHeaders["signature-input"]).toContain('tag="web-bot-auth"');
    const signed = { ...msg, headers: { ...msg.headers, ...sigHeaders } };
    const resolve = (keyid: string) => (keyid === agent.keyid ? agent.publicKey : undefined);

    const ok = await verifyMessage(signed, { resolveKey: resolve, requireComponents: ["@authority", "signature-agent"], requireTag: WEB_BOT_AUTH_TAG });
    expect(ok.ok, JSON.stringify(ok)).toBe(true);

    // different path → base changes → fails
    const moved = await verifyMessage({ ...signed, url: "http://127.0.0.1:4403/v1/report" }, { resolveKey: resolve });
    expect(moved.ok).toBe(false);
    // different authority
    const rehosted = await verifyMessage({ ...signed, url: "http://evil.example/v1/quote?symbol=ETH" }, { resolveKey: resolve });
    expect(rehosted.ok).toBe(false);
    // unknown key
    const unknown = await verifyMessage(signed, { resolveKey: () => undefined });
    expect(unknown).toMatchObject({ ok: false, reason: expect.stringContaining("unknown key") });
    // wrong key
    const other = ed25519Generate();
    const wrong = await verifyMessage(signed, { resolveKey: () => other.publicKey });
    expect(wrong).toMatchObject({ ok: false, reason: "signature does not verify" });
    // expired
    const expired = await verifyMessage(signed, { resolveKey: resolve, now: Math.floor(Date.now() / 1000) + 10_000 });
    expect(expired).toMatchObject({ ok: false, reason: "signature expired" });
    // replay
    const seen = new Set<string>();
    const guard = (n: string) => (seen.has(n) ? true : (seen.add(n), false));
    expect((await verifyMessage(signed, { resolveKey: resolve, nonceSeen: guard })).ok).toBe(true);
    expect(await verifyMessage(signed, { resolveKey: resolve, nonceSeen: guard })).toMatchObject({ ok: false, reason: "nonce replayed" });
    // required tag / component
    expect(await verifyMessage(signed, { resolveKey: resolve, requireTag: HOLDER_TAG })).toMatchObject({ ok: false });
    expect(await verifyMessage(signed, { resolveKey: resolve, requireComponents: ["content-digest"] })).toMatchObject({ ok: false });
  });

  it("covers the body through Content-Digest for holder-signed POSTs", async () => {
    const holder = ed25519Generate();
    const body = JSON.stringify({ url: "http://p/x", maxAmount: "0.01", purpose: "research" });
    const msg = { method: "POST", url: "http://127.0.0.1:4402/v1/intents", headers: { "content-type": "application/json", authorization: "Bearer cred" } };
    const h = signAsHolder(msg, holder, body);
    expect(h["content-digest"]).toBe(contentDigest(body));
    const signed = { ...msg, headers: { ...msg.headers, ...h } };
    const res = await verifyMessage(signed, { resolveKey: () => publicKeyFromJwk(holder.publicJwk), requireTag: HOLDER_TAG, requireComponents: ["@method", "@path", "content-digest"] });
    expect(res.ok).toBe(true);
    expect(contentDigestMatches(signed.headers, body)).toBe(true);
    expect(contentDigestMatches(signed.headers, body + " ")).toBe(false); // body swapped after signing
  });

  it("round-trips through generic signMessage with custom components", async () => {
    const key = ed25519Generate();
    const msg = { method: "GET", url: "https://a.example/b?c=1", headers: { "x-thing": " spaced  value " } };
    const sig = signMessage(msg, { privateKey: key.privateKey, keyid: key.keyid, components: ["@method", "@query", "x-thing"], created: 1700000000, ttlSeconds: 10 });
    const res = await verifyMessage({ ...msg, headers: { ...msg.headers, ...sig } }, { resolveKey: () => key.publicKey, now: 1700000005 });
    expect(res).toMatchObject({ ok: true, components: ["@method", "@query", "x-thing"] });
  });
});
