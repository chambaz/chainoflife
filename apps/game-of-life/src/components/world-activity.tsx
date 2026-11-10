import { useEffect, useRef, useState } from "react";
import { hashFromHex, toBase58 } from "@thruputchain/client";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { abbreviate } from "@/lib/format-identifier";
import type { LifeChainEvent, LifeReadAdapter } from "@/chain/game-of-life";

type GenerationEvent = Exclude<LifeChainEvent, { kind: "TickRequested" }>;

export function WorldActivity({
  reader,
}: {
  readonly reader: LifeReadAdapter;
}) {
  const [open, setOpen] = useState(true);
  const [entries, setEntries] = useState<GenerationEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const [moreBelow, setMoreBelow] = useState(false);

  useEffect(() => {
    const list = listRef.current;
    if (!list || !open) return;
    const update = () =>
      setMoreBelow(list.scrollHeight - list.scrollTop - list.clientHeight > 1);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(list);
    list.addEventListener("scroll", update, { passive: true });
    return () => {
      observer.disconnect();
      list.removeEventListener("scroll", update);
    };
  }, [entries, open]);

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
      open={open}
      className="flex min-h-0 flex-col border-t border-border open:flex-1 [&::details-content]:min-h-0 [&::details-content]:flex-1 [&[open]::details-content]:flex [&[open]::details-content]:flex-col"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer p-4 text-xs font-medium tracking-widest text-muted-foreground uppercase outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        Activity
      </summary>
      <div className="relative flex min-h-0 flex-1 flex-col px-4 pb-4">
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
        <ol
          ref={listRef}
          role="list"
          aria-label="Generation transactions"
          className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto"
        >
          {entries.map((entry) => (
            <GenerationActivityItem key={entry.transactionHash} entry={entry} />
          ))}
        </ol>
        {moreBelow ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute right-4 bottom-4 left-4 h-10 bg-gradient-to-t from-panel to-transparent"
          />
        ) : null}
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
    <li className="grid text-sm">
      <p className="text-muted-foreground">
        Generation {generation}
      </p>
      <div className="flex items-center gap-2">
        <p className="min-w-0 font-mono text-xs" title={hash}>
          {abbreviate(hash)}
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
