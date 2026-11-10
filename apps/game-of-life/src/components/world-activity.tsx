import { useEffect, useState } from "react";
import { hashFromHex, toBase58 } from "@thruputchain/client";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { LifeChainEvent, LifeReadAdapter } from "@/chain/game-of-life";

type GenerationEvent = Exclude<LifeChainEvent, { kind: "TickRequested" }>;

export function WorldActivity({
  reader,
}: {
  readonly reader: LifeReadAdapter;
}) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<GenerationEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    let running = false;
    const reload = async () => {
      if (running || document.visibilityState !== "visible") return;
      running = true;
      try {
        const events = await reader.events(0n);
        if (disposed) return;
        const generations = new Map<string, GenerationEvent>();
        for (const event of events) {
          if (event.kind !== "TickRequested")
            generations.set(event.transactionHash, event);
        }
        setEntries(
          [...generations.values()].sort((a, b) => {
            const height = BigInt(b.blockHeight) - BigInt(a.blockHeight);
            return height === 0n
              ? b.sequenceNumber - a.sequenceNumber
              : height > 0n
                ? 1
                : -1;
          }),
        );
        setLoaded(true);
        setError(null);
      } catch (cause) {
        if (!disposed)
          setError(
            cause instanceof Error ? cause.message : "Cannot load activity",
          );
      } finally {
        running = false;
      }
    };
    void reload();
    const timer = window.setInterval(reload, 5_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [reader, open]);

  return (
    <details
      className="border-t border-border"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer p-4 text-xs font-medium tracking-widest text-muted-foreground uppercase outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        Activity
      </summary>
      <div className="px-4 pb-4">
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {!error && !loaded ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading activity…
          </p>
        ) : null}
        {loaded && !entries.length ? (
          <p className="text-sm text-muted-foreground">
            No generation transactions yet.
          </p>
        ) : null}
        <ol role="list" className="grid max-h-96 gap-3 overflow-y-auto">
          {entries.map((entry) => (
            <GenerationActivityItem key={entry.transactionHash} entry={entry} />
          ))}
        </ol>
      </div>
    </details>
  );
}

function GenerationActivityItem({
  entry,
}: {
  readonly entry: GenerationEvent;
}) {
  const hash = toBase58(hashFromHex(entry.transactionHash));
  const generation = entry.kind === "WorldInitialized" ? "0" : entry.generation;
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2_000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(hash);
      setCopied(true);
    } catch {
      setCopied(false);
      setCopyFailed(true);
    }
  };
  return (
    <li className="grid text-sm tabular-nums">
      <p>
        Generation {generation}
        {entry.kind === "WorldInitialized" ? " · Reset" : ""}
      </p>
      <div className="flex items-center gap-2">
        <p className="min-w-0 font-mono text-muted-foreground" title={hash}>
          Epoch {entry.epoch} · {hash.slice(0, 6)}…{hash.slice(-6)}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={`Copy transaction hash for generation ${generation}, epoch ${entry.epoch}`}
          title={copied ? "Copied" : "Copy full hash"}
          onClick={() => void copy()}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
        <span role="status" className="sr-only">
          {copied ? "Transaction hash copied" : ""}
        </span>
      </div>
      {copyFailed ? (
        <p role="alert" className="break-all text-destructive">
          Could not copy. Select the full hash:{" "}
          <span className="select-all font-mono">{hash}</span>
        </p>
      ) : null}
    </li>
  );
}
