import { describe, expect, test } from "vitest";
import {
  markChainReadFailed,
  reconcileChainMetadata,
  type ChainState,
} from "./metadata-state";

const metadata = {
  epoch: "0",
  width: 10_000,
  height: 10_000,
  generation: "4",
  seed: "7",
  population: "12",
  stateDigest: `0x${"aa".repeat(32)}`,
  resizable: true,
} as const;
const state: ChainState = {
  chain: metadata,
  chainError: null,
  chainIntegrityFailed: false,
};

test("a reset epoch accepts generation zero and rejects a late old-epoch read", () => {
  const reset = {
    ...metadata,
    epoch: "1",
    generation: "0",
    width: 100,
    height: 100,
    population: "1",
    stateDigest: `0x${"bb".repeat(32)}`,
  };
  const next = reconcileChainMetadata(state, reset);
  expect(next.chain).toEqual(reset);
  expect(next.chainIntegrityFailed).toBe(false);
  expect(reconcileChainMetadata(next, metadata).chain).toEqual(reset);
  expect(reconcileChainMetadata(next, metadata).chainIntegrityFailed).toBe(
    true,
  );
});

describe("chain metadata verification state", () => {
  test("treats lower and conflicting equal generations as integrity failures", () => {
    expect(
      reconcileChainMetadata(state, { ...metadata, generation: "3" }),
    ).toMatchObject({ chain: metadata, chainIntegrityFailed: true });
    expect(
      reconcileChainMetadata(state, { ...metadata, population: "13" }),
    ).toMatchObject({ chain: metadata, chainIntegrityFailed: true });
  });

  test("retains last verified metadata and reports transient failures", () => {
    expect(markChainReadFailed(state, "timed out")).toEqual({
      chain: metadata,
      chainError: "timed out",
      chainIntegrityFailed: false,
    });
  });

  test("does not let a transient failure clear an integrity failure", () => {
    const integrity = reconcileChainMetadata(state, {
      ...metadata,
      generation: "3",
    });
    expect(markChainReadFailed(integrity, "offline")).toBe(integrity);
  });
});
