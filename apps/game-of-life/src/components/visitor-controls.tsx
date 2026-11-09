import { useEffect, useState } from "react";
import type { AppClient } from "@/chain/client";
import type { AppConfig, LifeTransactionProfiles } from "@/config";
import {
  prepareVisitorWallet,
  type VisitorWallet,
} from "@/wallet/visitor-wallet";
import { Button } from "@/components/ui/button";
import { TransactionActivity } from "./transaction-activity";

export function VisitorControls({
  config,
  profiles,
  client,
  onCrankCommitted,
}: {
  readonly config: Readonly<AppConfig>;
  readonly profiles: LifeTransactionProfiles;
  readonly client: Promise<AppClient>;
  readonly onCrankCommitted: () => void;
}) {
  const [wallet, setWallet] = useState<VisitorWallet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let disposed = false;
    setError(null);
    void client
      .then((connection) =>
        prepareVisitorWallet(
          config.networkId,
          connection,
          (profiles.crank.transactionGasLimit >
          profiles.request.transactionGasLimit
            ? profiles.crank.transactionGasLimit
            : profiles.request.transactionGasLimit) + 1_000_000n,
        ),
      )
      .then((ready) => {
        if (!disposed) setWallet(ready);
      })
      .catch((cause: unknown) => {
        if (!disposed)
          setError(
            cause instanceof Error ? cause.message : "Wallet setup failed.",
          );
      });
    return () => {
      disposed = true;
    };
  }, [client, config.networkId, profiles, attempt]);

  if (wallet)
    return (
      <TransactionActivity
        config={config}
        profiles={profiles}
        wallet={wallet}
        client={client}
        onCrankCommitted={onCrankCommitted}
      />
    );
  return (
    <section
      aria-label="Wallet setup"
      className="absolute right-3 bottom-3 left-3 z-20 rounded-lg border border-border bg-panel/95 p-3 shadow-lg sm:left-auto sm:w-[23rem]"
    >
      <p role="status" className="text-base sm:text-sm">
        {error
          ? "Your wallet is not ready"
          : "Creating and funding your wallet…"}
      </p>
      {error ? (
        <>
          <p role="alert" className="mt-2 text-sm text-destructive">
            {error}
          </p>
          <Button
            className="mt-3 w-full"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Check funding
          </Button>
        </>
      ) : (
        <Button className="mt-3 w-full" disabled>
          Preparing wallet…
        </Button>
      )}
    </section>
  );
}
