import { ChevronRight, LoaderCircle, Zap } from "lucide-react";
import { abbreviate } from "@/lib/format-identifier";
import { Button } from "@/components/ui/button";
import type { VisitorWallet } from "@/wallet/visitor-wallet";
import type { WorldWriteState } from "@/transactions/use-world-write";

export function TransactionActivity({
  wallet,
  worldSize,
  writes,
  resetting = false,
}: {
  readonly wallet: VisitorWallet;
  readonly worldSize: number | null;
  readonly writes: WorldWriteState;
  readonly resetting?: boolean;
}) {
  const { write, busy, pending } = writes;
  const advancing = write?.kind === "advance" && (busy || pending);
  const failure =
    writes.error ??
    (write?.kind === "advance" && write.status === "failed"
      ? write.message
      : null);
  return (
    <section className="pointer-events-none absolute right-[max(.75rem,var(--safe-right))] bottom-[calc(var(--safe-bottom)+10rem)] left-[max(.75rem,var(--safe-left))] z-20 rounded-lg border border-border bg-panel/95 p-3 shadow-lg backdrop-blur-md sm:left-auto sm:w-[23rem] md:bottom-[max(.75rem,var(--safe-bottom))] [@media(max-height:400px)]:bottom-[max(.75rem,var(--safe-bottom))] [@media(max-height:400px)]:left-auto [@media(max-height:400px)]:w-[min(23rem,45%)]">
      <p className="text-xs font-medium tracking-widest text-muted-foreground uppercase">
        Evolution control
      </p>
      <p
        aria-label="Your wallet"
        title={wallet.address}
        className="mt-0.5 text-sm"
      >
        Wallet {abbreviate(wallet.address)}
      </p>
      <Button
        className="pointer-events-auto mt-3 w-full justify-between"
        disabled={busy || pending || resetting}
        onClick={() => void writes.submit({ kind: "advance" })}
      >
        <span className="flex items-center gap-2">
          {advancing ? <LoaderCircle className="animate-spin" /> : <Zap />}
          {resetting
            ? "Resetting world..."
            : worldSize === null
              ? "Advance world"
              : `Advance ${(worldSize * worldSize).toLocaleString()} cells`}
        </span>
        <ChevronRight />
      </Button>
      {write?.kind === "advance" && write.status === "indeterminate" ? (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          Checking transaction {abbreviate(write.transactionHash)}…
        </p>
      ) : null}
      {failure ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {failure}
        </p>
      ) : null}
    </section>
  );
}
