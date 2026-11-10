import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { DetailsContent, GenerationReadout } from "./app";
import { hashFromHex, toBase58 } from "@thruputchain/client";
import type { ImmutableSnapshot } from "./indexer/client";
import {
  INITIAL_SYNCHRONIZATION_STATE,
  type SynchronizationState,
} from "./synchronization";

const digest = `0x${"aa".repeat(32)}`;
const snapshot = {
  manifest: {
    epoch: "0",
    networkId: "11".repeat(32),
    contractAddress: `0x${"22".repeat(32)}`,
    generation: "3",
    population: "32768",
    stateDigest: digest,
    seed: "7",
    width: 10000,
    height: 10000,
  },
  provenance: {
    sourceBlockHeight: "12",
    sourceBlockHash: `0x${"bb".repeat(32)}`,
    evidenceKind: "generation-advanced-event",
  },
} as ImmutableSnapshot;

const state = {
  ...INITIAL_SYNCHRONIZATION_STATE,
  chain: {
    epoch: "0",
    width: 10000,
    height: 10000,
    generation: "5",
    seed: "7",
    population: "32770",
    stateDigest: `0x${"cc".repeat(32)}`,
    chunkBytes: 1000,
    chunksPerRow: 2,
    maxQueueLength: 16,
  },
  chainVerification: "fresh",
  visualized: snapshot,
  candidate: {
    ...snapshot,
    manifest: { ...snapshot.manifest, generation: "4" },
  },
  transition: "staging",
} satisfies SynchronizationState;

afterEach(cleanup);

describe("World instrument surfaces", () => {
  test("labels the retained visualization honestly while staging", () => {
    render(<GenerationReadout state={state} />);
    expect(screen.getByText("Preparing visualization 4")).toBeInTheDocument();
  });

  test("does not call a retained visualization ready during integrity failure", () => {
    render(
      <GenerationReadout
        state={{
          ...state,
          candidate: null,
          transition: "idle",
          chainVerification: "integrity",
        }}
      />,
    );
    expect(
      screen.getByText("Chain integrity warning · retained generation 3"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Ready/)).not.toBeInTheDocument();
  });

  test("opens world details with shortened base58 identities and useful snapshot data", () => {
    render(
      <DetailsContent
        state={state}
        config={
          {
            contractAddress: snapshot.manifest.contractAddress,
          } as never
        }
      />,
    );
    expect(screen.getByText("World details")).toBeVisible();
    expect(screen.getByText("Dimensions")).toBeVisible();
    expect(screen.queryByText("Reset epoch")).not.toBeInTheDocument();
    expect(screen.getByText("Source block")).toBeVisible();
    for (const hex of [digest, snapshot.manifest.contractAddress]) {
      const full = toBase58(hashFromHex(hex));
      expect(screen.getByTitle(full)).toHaveTextContent(
        `${full.slice(0, 10)}…${full.slice(-6)}`,
      );
      expect(screen.queryByText(hex)).not.toBeInTheDocument();
    }
    expect(screen.queryByText("Block hash")).not.toBeInTheDocument();
    expect(screen.queryByText("Provenance")).not.toBeInTheDocument();
    expect(screen.queryByText("Immutable snapshot")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/One Thruput contract invocation/),
    ).not.toBeInTheDocument();
  });

  test("does not label retained metadata as visualized without WebGL", () => {
    render(
      <GenerationReadout state={state} rendererAvailability="unavailable" />,
    );
    expect(
      screen.getByText("Visualization unavailable", { exact: true }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Ready/)).not.toBeInTheDocument();
  });
});
