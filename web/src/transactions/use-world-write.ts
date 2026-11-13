import { useEffect, useMemo, useRef, useState } from "react";
import type { CoreThruputClient } from "@thruputchain/client";
import type { AppConfig } from "@/config";
import type { VisitorWallet } from "@/wallet/visitor-wallet";
import { createWriteBoundary } from "./write-boundary";
import {
  isPending,
  loadWrite,
  recoverWrite,
  submitWrite,
  subscribeWrite,
  writeScope,
  type WorldWrite,
  type WriteRequest,
} from "./world-write";

const RECOVERY_INTERVAL_MS = 3_000;

export interface WorldWriteState {
  /** The wallet's latest advance or resize. */
  readonly write: WorldWrite | null;
  /** True while this tab signs, submits, or observes a write. */
  readonly busy: boolean;
  /** A storage or submission error that is not part of the saved write. */
  readonly error: string | null;
  readonly pending: boolean;
  submit(request: WriteRequest): Promise<WorldWrite | null>;
}

/**
 * Owns the wallet's world writes. A pending write is observed by its original
 * hash every few seconds; nothing is ever submitted again automatically.
 */
export function useWorldWrite(
  config: Readonly<AppConfig>,
  wallet: VisitorWallet | null,
  client: CoreThruputClient | Promise<CoreThruputClient>,
  onCommitted: () => void,
): WorldWriteState {
  const [write, setWrite] = useState<WorldWrite | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const committed = useRef(onCommitted);
  committed.current = onCommitted;
  const params = useMemo(
    () =>
      wallet
        ? {
            config,
            wallet,
            boundary: createWriteBoundary(config, wallet, client),
          }
        : null,
    [config, wallet, client],
  );

  useEffect(() => {
    if (!params) return;
    const scope = writeScope(params.config, params.wallet);
    const reload = () => {
      try {
        setWrite(loadWrite(scope));
        setError(null);
      } catch (cause) {
        setError(message(cause));
      }
    };
    reload();
    return subscribeWrite(scope, reload);
  }, [params]);

  const run = async (
    action: () => Promise<WorldWrite | null>,
  ): Promise<WorldWrite | null> => {
    if (running.current) return null;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      setWrite(next);
      if (next?.status === "committed") committed.current();
      return next;
    } catch (cause) {
      setError(message(cause));
      return null;
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  const pending = isPending(write);
  useEffect(() => {
    if (!params || !pending || busy) return;
    const timer = window.setTimeout(
      () => void run(() => recoverWrite(params)),
      RECOVERY_INTERVAL_MS,
    );
    return () => window.clearTimeout(timer);
  }, [params, pending, busy, write]);

  return {
    write,
    busy,
    error,
    pending,
    submit: (request) =>
      params ? run(() => submitWrite(params, request)) : Promise.resolve(null),
  };
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Transaction failed";
}
