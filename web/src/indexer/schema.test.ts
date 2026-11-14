import { describe, expect, test } from "vitest";
import {
  assertSnapshotAgreement,
  assertSnapshotEligible,
  parseLatest,
  parseManifest,
  parseProvenance,
} from "./schema";
const network = "11".repeat(32);
const contract = `0x${"22".repeat(32)}`;
const digest = `0x${"aa".repeat(32)}`;
const block = `0x${"bb".repeat(32)}`;
const identity = {
  epoch: "0",
  networkId: network,
  contractAddress: contract,
  generation: "0",
  seed: "7",
  population: "1",
  stateDigest: digest,
};
const manifest = {
  schemaVersion: 1,
  ...identity,
  width: 10000,
  height: 10000,
  tileSize: 256,
  maxZoom: 6,
  densityEncoding: "u16le-live-count",
  cellEncoding: "row-major-lsb-first",
  tilePathTemplate: "tiles/{z}/{x}/{y}.bin",
  verification: {
    canonicalDownloadVerified: true,
    individualTileProofs: false,
  },
};
const latest = {
  epoch: "0",
  schemaVersion: 1,
  generation: "0",
  stateDigest: digest,
  manifestUrl: `/v1/worlds/${network}/${contract}/${digest}/manifest.json`,
  sourceBlockHeight: "9",
  sourceBlockHash: block,
  publishedAt: "2026-08-28T01:02:03Z",
};
const provenance = {
  schemaVersion: 1,
  ...identity,
  sourceBlockHeight: "9",
  sourceBlockHash: block,
  verifiedAt: "2026-08-28T01:02:03.456Z",
};
describe("artifact schemas", () => {
  test("accepts one agreeing immutable snapshot", () => {
    const l = parseLatest(latest, network, contract);
    const m = parseManifest(manifest);
    const p = parseProvenance(provenance);
    expect(() => assertSnapshotAgreement(l, m, p)).not.toThrow();
  });
  test.each(["generation", "seed", "population"])(
    "rejects noncanonical %s decimals",
    (field) =>
      expect(() => parseManifest({ ...manifest, [field]: "01" })).toThrow(
        /canonical u64/,
      ),
  );
  test("rejects unknown fields recursively", () => {
    expect(() => parseManifest({ ...manifest, extra: true })).toThrow(
      /unknown/,
    );
    expect(() =>
      parseManifest({
        ...manifest,
        verification: { ...manifest.verification, extra: true },
      }),
    ).toThrow(/unknown/);
  });
  test("rejects escaping or cross-scope latest URLs", () =>
    expect(() =>
      parseLatest(
        { ...latest, manifestUrl: `${digest}/manifest.json` },
        network,
        contract,
      ),
    ).toThrow(/manifestUrl/));
  test("rejects impossible calendar dates", () =>
    expect(() =>
      parseLatest(
        { ...latest, publishedAt: "2026-02-30T01:02:03Z" },
        network,
        contract,
      ),
    ).toThrow(/date/));
  test("accepts only the exact provenance fields", () => {
    expect(parseProvenance(provenance).sourceBlockHeight).toBe("9");
    expect(() =>
      parseProvenance({ ...provenance, transactionHash: digest }),
    ).toThrow(/unknown fields/);
  });
  test("detects cross-document disagreement", () => {
    const l = parseLatest(latest, network, contract);
    const m = parseManifest(manifest);
    const p = parseProvenance({ ...provenance, population: "2" });
    expect(() => assertSnapshotAgreement(l, m, p)).toThrow(/population/);
  });
  test("requires exact current chain metadata", () => {
    const m = parseManifest(manifest);
    const current = {
      epoch: "0",
      size: 10000,
      generation: "0",
      seed: "7",
      population: "1",
      stateDigest: digest,
    };
    expect(() => assertSnapshotEligible(m, current)).not.toThrow();
    expect(() => assertSnapshotEligible(m, { ...current, seed: "8" })).toThrow(
      /seed/,
    );
  });
  test("accepts an older indexer-verified snapshot", () => {
    const current = {
      epoch: "0",
      size: 10000,
      generation: "1",
      seed: "7",
      population: "2",
      stateDigest: `0x${"dd".repeat(32)}`,
    };
    expect(() =>
      assertSnapshotEligible(parseManifest(manifest), current),
    ).not.toThrow();
  });
  test("rejects candidates ahead of accepted chain metadata", () => {
    const aheadManifest = parseManifest({ ...manifest, generation: "1" });
    expect(() =>
      assertSnapshotEligible(aheadManifest, {
        epoch: "0",
        size: 10000,
        generation: "0",
        seed: "7",
        population: "1",
        stateDigest: digest,
      }),
    ).toThrow(/ahead/);
  });

  test("requires exact identity at the accepted current generation", () => {
    expect(() =>
      assertSnapshotEligible(parseManifest(manifest), {
        epoch: "0",
        size: 10000,
        generation: "0",
        seed: "7",
        population: "2",
        stateDigest: digest,
      }),
    ).toThrow(/population/);
  });
});
