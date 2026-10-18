import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The independent Python verifier (docs/spec/verify_bundle.py, standard library only) must agree with every test vector,
// as this package's verifier does (ADR-0026). Skipped where no Python 3.8+ is installed.

const SPEC = resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs/spec");
const python = ["python3", "python"].find((cmd) => {
  const r = spawnSync(cmd, ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)"], { encoding: "utf8" });
  return r.status === 0;
});

describe.skipIf(!python)("the independent Python verifier", () => {
  it("agrees with every evidence format v1 test vector", () => {
    const r = spawnSync(python!, [resolve(SPEC, "verify_bundle.py"), "--vectors", resolve(SPEC, "vectors")], { encoding: "utf8", timeout: 300_000 });
    expect(r.stdout).toMatch(/^(\d+)\/\1 vectors agree$/m);
    expect(r.status, r.stdout + r.stderr).toBe(0);
  }, 300_000);
});
