import { afterEach, expect, test, vi } from "vitest";
import { loadMeasurements, recordMeasurement } from "./measurements";

const scope = {
  networkId: "11".repeat(32),
  contractAddress: `0x${"22".repeat(32)}`,
};
const key = `chain-of-life:measurements:v1:${scope.networkId}:${scope.contractAddress}`;
const measurement = {
  kind: "reset" as const,
  size: 100,
  epoch: "1",
  generation: "0",
  digest: `0x${"33".repeat(32)}`,
  hash: `0x${"44".repeat(32)}`,
  submittedAt: 1,
  confirmedAt: 2,
  readyAt: null,
  gasUsed: "100",
};

afterEach(() => vi.restoreAllMocks());

test("malformed optional timing cannot interrupt transaction handling", () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  localStorage.setItem(key, "malformed");
  expect(() => recordMeasurement(scope, measurement)).not.toThrow();
  expect(localStorage.getItem(key)).toBe("malformed");
  expect(log).toHaveBeenCalledWith(
    "Cannot record transaction timing",
    expect.any(Error),
  );
});

test("quota failure is reported without escaping into receipt classification", () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Storage full", "QuotaExceededError");
  });
  expect(() => recordMeasurement(scope, measurement)).not.toThrow();
  expect(log).toHaveBeenCalled();
});

test("retains valid timing and ignores duplicate receipt observations", () => {
  recordMeasurement(scope, measurement);
  recordMeasurement(scope, measurement);
  expect(loadMeasurements(scope)).toEqual([measurement]);
});
