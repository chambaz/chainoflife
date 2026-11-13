import type { ChainMetadata } from "./game-of-life";
import { compareWorldVersion } from "@/indexer/schema";

export interface ChainState {
  readonly chain: ChainMetadata | null;
  readonly chainError: string | null;
  /** The last metadata read conflicted with accepted metadata. */
  readonly chainIntegrityFailed: boolean;
}

export function reconcileChainMetadata<T extends ChainState>(
  current: T,
  next: ChainMetadata,
): T {
  if (!current.chain) return accept(current, next);
  const order = compareWorldVersion(next, current.chain);
  if (order < 0)
    return integrityFailure(
      current,
      "Chain metadata regressed to an older generation",
    );
  if (
    current.chain.resizable !== next.resizable ||
    (order === 0 && !sameChainIdentity(current.chain, next))
  )
    return integrityFailure(
      current,
      "Conflicting metadata was returned for the current generation",
    );
  return accept(current, next);
}

export function markChainReadFailed<T extends ChainState>(
  current: T,
  error: string,
): T {
  return current.chainIntegrityFailed
    ? current
    : { ...current, chainError: error };
}

function accept<T extends ChainState>(current: T, next: ChainMetadata): T {
  return {
    ...current,
    chain: next,
    chainError: null,
    chainIntegrityFailed: false,
  };
}

function integrityFailure<T extends ChainState>(current: T, error: string): T {
  return { ...current, chainError: error, chainIntegrityFailed: true };
}

function sameChainIdentity(left: ChainMetadata, right: ChainMetadata): boolean {
  return (
    left.size === right.size &&
    left.generation === right.generation &&
    left.seed === right.seed &&
    left.population === right.population &&
    left.stateDigest === right.stateDigest
  );
}
