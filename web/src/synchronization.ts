import type { ChainMetadata } from "@/chain/game-of-life";
import {
  markChainReadFailed,
  reconcileChainMetadata,
} from "@/chain/metadata-state";
import type { ImmutableSnapshot } from "@/indexer/client";
import { compareWorldVersion } from "@/indexer/schema";

export type ArtifactState =
  | "idle"
  | "loading"
  | "awaiting-chain"
  | "ready"
  | "unavailable"
  | "malformed"
  | "invalid";
export type RendererAvailability =
  "initializing" | "available" | "context-lost" | "unavailable";

export interface SynchronizationState {
  readonly chain: ChainMetadata | null;
  readonly chainError: string | null;
  readonly chainIntegrityFailed: boolean;
  readonly visualized: ImmutableSnapshot | null;
  readonly candidate: ImmutableSnapshot | null;
  readonly candidateEpoch: number | null;
  readonly nextEpoch: number;
  readonly pendingSnapshot: ImmutableSnapshot | null;
  readonly artifactState: ArtifactState;
  readonly artifactError: string | null;
}

export const INITIAL_SYNCHRONIZATION_STATE: SynchronizationState = {
  chain: null,
  chainError: null,
  chainIntegrityFailed: false,
  visualized: null,
  candidate: null,
  candidateEpoch: null,
  nextEpoch: 1,
  pendingSnapshot: null,
  artifactState: "idle",
  artifactError: null,
};

/**
 * True when the chain has a newer world than any snapshot this browser holds,
 * so the indexer is expected to publish one soon.
 */
export function awaitingNewerSnapshot(state: SynchronizationState): boolean {
  if (!state.chain) return false;
  return [state.visualized, state.candidate, state.pendingSnapshot].every(
    (snapshot) =>
      !snapshot || compareWorldVersion(snapshot.manifest, state.chain!) < 0,
  );
}

export type SynchronizationAction =
  | { readonly type: "chain-read"; readonly value: ChainMetadata }
  | { readonly type: "chain-failed"; readonly error: string }
  | { readonly type: "artifact-loading" }
  | { readonly type: "artifact-unchanged" }
  | { readonly type: "artifact-parsed"; readonly snapshot: ImmutableSnapshot }
  | {
      readonly type: "artifact-failed";
      readonly condition: "unavailable" | "malformed";
      readonly error: string;
    }
  | { readonly type: "candidate-ready"; readonly snapshot: ImmutableSnapshot }
  | { readonly type: "candidate-invalid"; readonly error: string }
  | {
      readonly type: "visualization-committed";
      readonly digest: string;
      readonly epoch: number;
    };

export function synchronizationReducer(
  state: SynchronizationState,
  action: SynchronizationAction,
): SynchronizationState {
  switch (action.type) {
    case "chain-read": {
      const next = reconcileChainMetadata(state, action.value);
      return next.chainIntegrityFailed
        ? clearCandidate(
            next,
            next.chainError ?? "Chain metadata integrity failure",
          )
        : next;
    }
    case "chain-failed":
      return markChainReadFailed(state, action.error);
    case "artifact-loading":
      return { ...state, artifactState: "loading", artifactError: null };
    case "artifact-unchanged":
      return {
        ...state,
        artifactState: state.pendingSnapshot ? "awaiting-chain" : "ready",
        artifactError: null,
      };
    case "artifact-parsed":
      return {
        ...state,
        pendingSnapshot: action.snapshot,
        artifactState: "awaiting-chain",
        artifactError: null,
      };
    case "artifact-failed":
      return {
        ...state,
        artifactState: action.condition,
        artifactError: action.error,
      };
    case "candidate-invalid":
      return clearCandidate(
        {
          ...state,
          pendingSnapshot: null,
          artifactState: "invalid",
        },
        action.error,
      );
    case "candidate-ready": {
      const next = action.snapshot;
      const current = state.candidate ?? state.visualized;
      if (current) {
        const order = compareSnapshot(next, current);
        if (order < 0)
          return {
            ...state,
            pendingSnapshot: null,
            artifactState: "ready",
            artifactError: null,
          };
        if (order === 0) {
          if (next.manifest.stateDigest === current.manifest.stateDigest)
            return {
              ...state,
              pendingSnapshot: null,
              artifactState: "ready",
              artifactError: null,
            };
          return clearCandidate(
            { ...state, pendingSnapshot: null, artifactState: "invalid" },
            "Indexer returned conflicting digests for one generation",
          );
        }
      }
      return {
        ...state,
        candidate: next,
        candidateEpoch: state.nextEpoch,
        nextEpoch: state.nextEpoch + 1,
        pendingSnapshot: null,
        artifactState: "ready",
        artifactError: null,
      };
    }
    case "visualization-committed":
      if (
        state.candidate?.manifest.stateDigest !== action.digest ||
        state.candidateEpoch !== action.epoch ||
        state.chainIntegrityFailed
      )
        return state;
      return {
        ...state,
        visualized: state.candidate,
        candidate: null,
        candidateEpoch: null,
        artifactState: "ready",
      };
  }
}

function clearCandidate(
  state: SynchronizationState,
  error: string,
): SynchronizationState {
  return {
    ...state,
    candidate: null,
    candidateEpoch: null,
    artifactError: error,
  };
}

function compareSnapshot(
  left: ImmutableSnapshot,
  right: ImmutableSnapshot,
): number {
  return compareWorldVersion(left.manifest, right.manifest);
}
