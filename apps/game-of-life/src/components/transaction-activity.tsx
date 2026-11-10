import { startTransition, useEffect, useState } from "react";
import { ChevronRight, LoaderCircle, RotateCcw, Zap } from "lucide-react";
import type { CoreThruputClient } from "@thruputchain/client";
import type { AppConfig, LifeTransactionProfiles } from "@/config";
import { Button } from "@/components/ui/button";
import type { VisitorWallet } from "@/wallet/visitor-wallet";
import {
  observeCompletions,
  applyCompletionBatch,
} from "@/transactions/observer";
import {
  crankStorageKey,
  isTransactionStorageKey,
  loadCranks,
  loadRequests,
  requestStorageKey,
  saveRequests,
  transactionScope,
  withTransactionLock,
  type CrankRecord,
  type TickRequestRecord,
} from "@/transactions/records";
import { createWriteBoundary } from "@/transactions/write-boundary";
import {
  abandonUnsignedCrank,
  abandonUnsignedRequest,
  processOneTick,
  recoverCrank,
  recoverRequest,
  requestTick,
  type WorkflowResult,
} from "@/transactions/workflow";

export function TransactionActivity({
  config,
  profiles,
  wallet,
  client,
  onCrankCommitted,
  worldSize = 10_000,
  resetting = false,
}: {
  readonly config: Readonly<AppConfig>;
  readonly profiles: LifeTransactionProfiles;
  readonly wallet: VisitorWallet;
  readonly client: CoreThruputClient | Promise<CoreThruputClient>;
  readonly onCrankCommitted: () => void;
  readonly worldSize?: number;
  readonly resetting?: boolean;
}) {
  const scope = transactionScope(config, wallet.addressHex);
  const [boundary] = useState(() =>
    createWriteBoundary(config, wallet, client),
  );
  const [initial] = useState(() => initialRecords(scope));
  const [requests, setRequests] = useState<readonly TickRequestRecord[]>(
    initial.requests,
  );
  const [cranks, setCranks] = useState<readonly CrankRecord[]>(initial.cranks);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initial.error);
  const [observerError, setObserverError] = useState<string | null>(null);

  const apply = (result: WorkflowResult) => {
    startTransition(() => {
      setRequests(result.requests);
      setCranks(result.cranks);
    });
    if (result.cranks.some(({ status }) => status === "advanced"))
      onCrankCommitted();
  };

  useEffect(() => {
    const reload = () => {
      try {
        setRequests(loadRequests(scope));
        setCranks(loadCranks(scope));
        setError(null);
      } catch (cause) {
        setError(message(cause));
      }
    };
    const storage = (event: StorageEvent) => {
      if (isTransactionStorageKey(scope, event.key)) reload();
    };
    window.addEventListener("storage", storage);
    return () => window.removeEventListener("storage", storage);
  }, [crankStorageKey(scope), requestStorageKey(scope)]);

  useEffect(() => {
    let disposed = false;
    let running = false;
    const scan = async () => {
      if (disposed || running || document.visibilityState !== "visible") return;
      running = true;
      try {
        const scanned = loadRequests(scope).filter(
          ({ status }) => status === "accepted",
        );
        const batch = await observeCompletions({
          client,
          contractAddress: config.contractAddress,
          requests: scanned,
        });
        if (!disposed) setObserverError(null);
        if (
          disposed ||
          (batch.observations.length === 0 &&
            batch.observedThroughBlock === null)
        )
          return;
        const next = await withTransactionLock(scope, async () =>
          saveRequests(
            scope,
            applyCompletionBatch(loadRequests(scope), scanned, batch),
          ),
        );
        if (!disposed) startTransition(() => setRequests(next));
        if (batch.observations.length > 0) onCrankCommitted();
      } catch (cause) {
        if (!disposed) setObserverError(message(cause));
      } finally {
        running = false;
      }
    };
    void scan();
    const timer = window.setInterval(scan, 5_000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [client, config.contractAddress, crankStorageKey(scope)]);

  const run = async (action: () => Promise<WorkflowResult>) => {
    if (busy || resetting) return;
    setBusy(true);
    setError(null);
    try {
      apply(await action());
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  const common = { config, profiles, wallet, boundary };
  const recoverableRequests = requests.filter(
    (record) =>
      record.transactionHash !== null &&
      ["signing", "indeterminate", "acceptedUntracked"].includes(record.status),
  );
  const recoverableCranks = cranks.filter(
    (record) =>
      record.transactionHash !== null &&
      ["signing", "indeterminate"].includes(record.status),
  );
  const unsignedRequests = requests.filter(
    (record) => record.status === "signing" && record.transactionHash === null,
  );
  const unsignedCranks = cranks.filter(
    (record) => record.status === "signing" && record.transactionHash === null,
  );

  return (
    <section className="pointer-events-none absolute right-[max(.75rem,var(--safe-right))] bottom-[calc(var(--safe-bottom)+10rem)] left-[max(.75rem,var(--safe-left))] z-20 rounded-lg border border-border bg-panel/95 p-3 shadow-lg backdrop-blur-md sm:left-auto sm:w-[23rem] md:bottom-[max(.75rem,var(--safe-bottom))] [@media(max-height:400px)]:bottom-[max(.75rem,var(--safe-bottom))] [@media(max-height:400px)]:left-auto [@media(max-height:400px)]:w-[min(23rem,45%)]">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium tracking-widest text-muted-foreground uppercase">
            Evolution control
          </p>
          <p
            aria-label="Your wallet"
            title={wallet.address}
            className="mt-0.5 text-sm"
          >
            Wallet {wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}
          </p>
        </div>
      </div>
      <Button
        className="pointer-events-auto mt-3 w-full justify-between"
        disabled={busy || resetting}
        onClick={() =>
          void run(() =>
            loadRequests(scope).some(({ status }) => status === "accepted")
              ? processOneTick(common)
              : requestTick({ ...common, automaticCrank: true }),
          )
        }
      >
        <span className="flex items-center gap-2">
          {busy ? <LoaderCircle className="animate-spin" /> : <Zap />}
          {resetting
            ? "Resetting world..."
            : `Advance ${(worldSize * worldSize).toLocaleString()} cells`}
        </span>
        <ChevronRight />
      </Button>
      {recoverableRequests.map((record) => (
        <RecoveryButton
          key={record.localId}
          label={`Check request ${abbreviate(record.transactionHash!)}`}
          busy={busy}
          onClick={() =>
            run(async () => {
              const recovered = await recoverRequest({
                ...common,
                localId: record.localId,
              });
              return recovered.requests.some(
                ({ localId, status }) =>
                  localId === record.localId && status === "accepted",
              )
                ? processOneTick(common)
                : recovered;
            })
          }
        />
      ))}
      {recoverableCranks.map((record) => (
        <RecoveryButton
          key={record.localId}
          label={`Check crank ${abbreviate(record.transactionHash!)}`}
          busy={busy}
          onClick={() =>
            run(() => recoverCrank({ ...common, localId: record.localId }))
          }
        />
      ))}
      {unsignedRequests.map((record) => (
        <RecoveryButton
          key={record.localId}
          label="I confirm signing did not complete"
          busy={busy}
          onClick={() =>
            run(() =>
              abandonUnsignedRequest({
                config,
                wallet,
                localId: record.localId,
              }),
            )
          }
        />
      ))}
      {unsignedCranks.map((record) => (
        <RecoveryButton
          key={record.localId}
          label="I confirm crank signing did not complete"
          busy={busy}
          onClick={() =>
            run(() =>
              abandonUnsignedCrank({
                config,
                wallet,
                localId: record.localId,
              }),
            )
          }
        />
      ))}
      {(error ?? observerError) ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error ?? observerError}
        </p>
      ) : null}
    </section>
  );
}

function RecoveryButton({
  label,
  busy,
  onClick,
}: {
  readonly label: string;
  readonly busy: boolean;
  readonly onClick: () => Promise<void>;
}) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void onClick()}
      className="pointer-events-auto mt-2 flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline disabled:opacity-50"
    >
      <RotateCcw className="size-3" /> {label}
    </button>
  );
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Transaction activity failed";
}

function initialRecords(scope: ReturnType<typeof transactionScope>): {
  readonly requests: readonly TickRequestRecord[];
  readonly cranks: readonly CrankRecord[];
  readonly error: string | null;
} {
  try {
    return {
      requests: loadRequests(scope),
      cranks: loadCranks(scope),
      error: null,
    };
  } catch (cause) {
    return { requests: [], cranks: [], error: message(cause) };
  }
}

function abbreviate(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}
