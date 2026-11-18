import { describe, expect, test } from "vitest";
import type { ImmutableSnapshot } from "./indexer/client";
import type { ChainMetadata } from "./chain/game-of-life";
import {
  awaitingNewerSnapshot,
  INITIAL_SYNCHRONIZATION_STATE,
  synchronizationReducer,
} from "./synchronization";

function snapshot(generation: string, byte: string): ImmutableSnapshot {
  return {
    manifest: {
      epoch: "0",
      generation,
      stateDigest: `0x${byte.repeat(64)}`,
    },
  } as ImmutableSnapshot;
}

function stage(
  state: typeof INITIAL_SYNCHRONIZATION_STATE,
  value: ImmutableSnapshot,
) {
  return synchronizationReducer(state, {
    type: "candidate-ready",
    snapshot: value,
  });
}

function commit(state: ReturnType<typeof stage>) {
  return synchronizationReducer(state, {
    type: "visualization-committed",
    digest: state.candidate!.manifest.stateDigest,
    epoch: state.candidateEpoch!,
  });
}

describe("generation synchronization", () => {
  test("a reset supersedes an older epoch even when its generation is lower", () => {
    const old = snapshot("9", "a");
    const reset = snapshot("0", "b");
    const next = {
      ...reset,
      manifest: { ...reset.manifest, epoch: "1", width: 100, height: 100 },
    };
    const state = stage(
      commit(stage(INITIAL_SYNCHRONIZATION_STATE, old)),
      next,
    );
    expect(state.candidate).toBe(next);
    const committed = commit(state);
    expect(stage(committed, old).visualized).toBe(next);
    expect(stage(committed, old).candidate).toBeNull();
  });
  test("stages the first eligible snapshot without assigning ownership", () => {
    const first = snapshot("0", "a");
    const state = stage(INITIAL_SYNCHRONIZATION_STATE, first);
    expect(state.visualized).toBeNull();
    expect(state.candidate).toBe(first);
    expect(state.candidateEpoch).toBe(1);
  });

  test("keeps a verified visualization while a newer candidate is staged", () => {
    const first = snapshot("4", "a");
    const next = snapshot("5", "b");
    let state = commit(stage(INITIAL_SYNCHRONIZATION_STATE, first));
    state = stage(state, next);
    expect(state.visualized).toBe(first);
    expect(state.candidate).toBe(next);
  });

  test("commits only the exact staged digest", () => {
    const first = snapshot("4", "a");
    const next = snapshot("5", "b");
    let state = commit(stage(INITIAL_SYNCHRONIZATION_STATE, first));
    state = stage(state, next);
    expect(
      synchronizationReducer(state, {
        type: "visualization-committed",
        digest: first.manifest.stateDigest,
        epoch: state.candidateEpoch!,
      }).visualized,
    ).toBe(first);
    state = synchronizationReducer(state, {
      type: "visualization-committed",
      digest: next.manifest.stateDigest,
      epoch: state.candidateEpoch!,
    });
    expect(state.visualized).toBe(next);
    expect(state.candidate).toBeNull();
  });

  test("rejects regressions and equal-generation digest conflicts", () => {
    const current = commit(
      stage(INITIAL_SYNCHRONIZATION_STATE, snapshot("5", "a")),
    );
    expect(
      synchronizationReducer(current, {
        type: "candidate-ready",
        snapshot: snapshot("4", "b"),
      }).visualized,
    ).toBe(current.visualized);
    const conflict = synchronizationReducer(current, {
      type: "candidate-ready",
      snapshot: snapshot("5", "b"),
    });
    expect(conflict.artifactError).toMatch(/conflicting digests/);
    expect(conflict.visualized).toBe(current.visualized);
  });

  test("clears a staged epoch on chain integrity and rejects its stale commit", () => {
    const first = snapshot("4", "a");
    const next = snapshot("5", "b");
    let state = commit(stage(INITIAL_SYNCHRONIZATION_STATE, first));
    state = stage(state, next);
    const epoch = state.candidateEpoch!;
    state = synchronizationReducer(
      {
        ...state,
        chain: {
          size: 10000,
          epoch: "0",
          generation: "5",
          seed: "7",
          population: "1",
          stateDigest: next.manifest.stateDigest,
          resizable: true,
        },
        chainIntegrityFailed: false,
      },
      {
        type: "chain-read",
        value: {
          resizable: true,
          epoch: "0",
          size: 10000,
          generation: "5",
          seed: "7",
          population: "2",
          stateDigest: next.manifest.stateDigest,
        },
      },
    );
    expect(state.candidate).toBeNull();
    expect(
      synchronizationReducer(state, {
        type: "visualization-committed",
        digest: next.manifest.stateDigest,
        epoch,
      }).visualized,
    ).toBe(first);
  });
});

describe("awaiting a newer snapshot", () => {
  const chain = (epoch: string, generation: string) =>
    ({ epoch, generation }) as ChainMetadata;

  test("is false before the chain is read", () => {
    expect(awaitingNewerSnapshot(INITIAL_SYNCHRONIZATION_STATE)).toBe(false);
  });

  test("is true while every held snapshot is older than the chain", () => {
    const state = commit(
      stage(INITIAL_SYNCHRONIZATION_STATE, snapshot("4", "a")),
    );
    expect(awaitingNewerSnapshot({ ...state, chain: chain("0", "5") })).toBe(
      true,
    );
    expect(awaitingNewerSnapshot({ ...state, chain: chain("1", "0") })).toBe(
      true,
    );
  });

  test("is false once any held snapshot reaches the chain", () => {
    const visualized = commit(
      stage(INITIAL_SYNCHRONIZATION_STATE, snapshot("4", "a")),
    );
    expect(
      awaitingNewerSnapshot({ ...visualized, chain: chain("0", "4") }),
    ).toBe(false);
    const staged = stage(visualized, snapshot("5", "b"));
    expect(awaitingNewerSnapshot({ ...staged, chain: chain("0", "5") })).toBe(
      false,
    );
  });
});
