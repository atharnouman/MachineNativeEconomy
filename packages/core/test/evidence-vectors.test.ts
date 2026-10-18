import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBundle, type EvidenceBundle } from "../src/index.js";

// Conformance of this verifier to the evidence format v1 test vectors (docs/spec, ADR-0026): the same checks, in the
// same order, with the same results. The vectors come from packages/gateway/scripts/gen-evidence-spec.ts.

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs/spec/vectors");
interface Vector {
  format: string;
  name: string;
  options?: { trustedGatewayKeys: string[] };
  expected: { ok: boolean; checks: Array<{ check: string; ok: boolean }> };
  bundle: EvidenceBundle;
}
const vectors = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => ({ file: f, v: JSON.parse(readFileSync(join(DIR, f), "utf8")) as Vector }));

describe("evidence format v1 test vectors", () => {
  it("are all there, valid and broken ones alike", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(30);
    expect(vectors.some(({ v }) => v.expected.ok)).toBe(true);
    expect(vectors.some(({ v }) => !v.expected.ok)).toBe(true);
    for (const { v } of vectors) expect(v.format).toBe("evidence-v1");
  });

  for (const { file, v } of vectors) {
    it(`${file}: ${v.expected.ok ? "verifies" : `fails ${v.expected.checks.filter((c) => !c.ok).map((c) => c.check).join(", ")}`}`, async () => {
      const report = await verifyBundle(v.bundle, v.options ?? {});
      expect(report.checks.map((c) => ({ check: c.check, ok: c.ok }))).toEqual(v.expected.checks);
      expect(report.ok).toBe(v.expected.ok);
    });
  }
});
