import { describe, it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { approvalMessage, verifyApprovalSignature, periodStart, parseDuration, windowStart } from "../src/index.js";

const cfo = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
const base = { id: "apr_1", principalId: "org", intentHash: `0x${"ab".repeat(32)}`, amount: "40000" };

describe("approval signatures", () => {
  it("binds id, principal, intent hash, amount and verdict", async () => {
    const sig = await cfo.signMessage({ message: approvalMessage(base, "approve") });
    expect(await verifyApprovalSignature(base, "approve", sig, cfo.address)).toBe(true);
    expect(await verifyApprovalSignature(base, "reject", sig, cfo.address)).toBe(false); // verdict swapped
    expect(await verifyApprovalSignature({ ...base, amount: "40001" }, "approve", sig, cfo.address)).toBe(false); // amount changed
    expect(await verifyApprovalSignature(base, "approve", sig, "0x0000000000000000000000000000000000000001")).toBe(false); // wrong approver
    expect(await verifyApprovalSignature(base, "approve", "0xdeadbeef", cfo.address)).toBe(false); // garbage
  });
});

describe("time helpers", () => {
  it("computes UTC calendar period starts", () => {
    const now = new Date("2026-10-08T15:30:00Z"); // a Thursday
    expect(periodStart("lifetime", now)).toBeNull();
    expect(periodStart("daily", now)?.toISOString()).toBe("2026-10-08T00:00:00.000Z");
    expect(periodStart("weekly", now)?.toISOString()).toBe("2026-10-05T00:00:00.000Z"); // Monday
    expect(periodStart("monthly", now)?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("parses durations", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("10m")).toBe(600_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("1d")).toBe(86_400_000);
    expect(parseDuration("1w")).toBe(604_800_000);
    expect(() => parseDuration("10x")).toThrow();
    expect(windowStart("10m", new Date("2026-10-08T15:30:00Z")).toISOString()).toBe("2026-10-08T15:20:00.000Z");
  });
});
