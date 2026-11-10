import {
  useEffect,
  useId,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { VisitorWallet } from "@/wallet/visitor-wallet";
import { hashFromHex, toBase58 } from "@thruputchain/client";
import { BoardSizeControl } from "@/components/board-size-control";
import { WorldActivity } from "@/components/world-activity";
import { abbreviate } from "@/lib/format-identifier";
import {
  markBoardReady,
  subscribeMeasurements,
} from "@/transactions/measurements";
import { Activity, CircleAlert, CircleCheck, Dna, Info } from "lucide-react";
import type { AppConfig } from "@/config";
import { createAppClient } from "@/chain/client";
import {
  createLifeReadAdapter,
  type LifeReadAdapter,
} from "@/chain/game-of-life";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { WorldViewport } from "@/components/world-viewport";
import { VisitorControls } from "@/components/visitor-controls";
import { IndexerClient, type ImmutableSnapshot } from "@/indexer/client";
import {
  assertSnapshotEligible,
  compareWorldVersion,
  SchemaError,
} from "@/indexer/schema";
import { createVisiblePoller, type Poller } from "@/polling";
import {
  INITIAL_SYNCHRONIZATION_STATE,
  synchronizationReducer,
  type RendererAvailability,
  type SynchronizationAction,
  type SynchronizationState,
} from "@/synchronization";

const REQUEST_TIMEOUT = 8_000;

export function App({ config }: { readonly config: Readonly<AppConfig> }) {
  const [state, dispatch] = useReducer(
    synchronizationReducer,
    INITIAL_SYNCHRONIZATION_STATE,
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const [announcement, setAnnouncement] = useState("");
  const [wallet, setWallet] = useState<VisitorWallet | null>(null);
  const [previewSize, setPreviewSize] = useState<number | null>(null);
  const [resetting, setResetting] = useState(false);
  const [rendererAvailability, setRendererAvailability] =
    useState<RendererAvailability>("initializing");
  const rendererAvailabilityRef = useRef(rendererAvailability);
  const ownedRendererKey = useRef<string | null>(null);
  const [statusClock, setStatusClock] = useState(Date.now());
  const lastAnnouncement = useRef("");
  const [indexer] = useState(() => new IndexerClient(config));
  const [rpcClient] = useState(() => createAppClient(config));
  const [chain] = useState(() =>
    createLifeReadAdapter({
      client: rpcClient,
      contractAddress: config.contractAddress,
    }),
  );
  const chainRefresh = useRef<(() => void) | null>(null);
  const visualizedDigest = state.visualized?.manifest.stateDigest;
  useEffect(() => {
    if (!visualizedDigest) return;
    const recordReady = () => {
      try {
        markBoardReady(config, visualizedDigest);
      } catch (cause) {
        console.error("Cannot record board-ready timing", cause);
      }
    };
    recordReady();
    return subscribeMeasurements(config, recordReady);
  }, [config.networkId, config.contractAddress, visualizedDigest]);

  const send = (action: SynchronizationAction) => {
    stateRef.current = synchronizationReducer(stateRef.current, action);
    dispatch(action);
  };
  const updateRendererAvailability = (value: RendererAvailability) => {
    rendererAvailabilityRef.current = value;
    setRendererAvailability(value);
  };

  const announce = (value: string) => {
    if (lastAnnouncement.current === value) return;
    lastAnnouncement.current = value;
    setAnnouncement(value);
  };

  useEffect(() => {
    const pollers: Poller[] = [];
    const chainPoller = createVisiblePoller(
      15_000,
      REQUEST_TIMEOUT,
      async (signal, commit) => {
        try {
          const result = await raceAbort(chain.metadata(), signal);
          commit(() => send({ type: "chain-read", value: result.value }));
        } catch (cause) {
          commit(() => send({ type: "chain-failed", error: message(cause) }));
          throw cause;
        }
      },
    );
    chainRefresh.current = () => chainPoller.refresh();
    pollers.push(
      chainPoller,
      createVisiblePoller(5_000, REQUEST_TIMEOUT, async (signal, commit) => {
        try {
          const pointer = await indexer.latest(signal);
          const known = [
            stateRef.current.visualized,
            stateRef.current.candidate,
            stateRef.current.pendingSnapshot,
          ].filter((value): value is ImmutableSnapshot => value !== null);
          const newest = known.sort((left, right) =>
            Number(compareWorldVersion(right.manifest, left.manifest)),
          )[0];
          if (newest) {
            const order = compareWorldVersion(pointer, newest.manifest);
            if (order < 0) {
              commit(() => send({ type: "artifact-unchanged" }));
              return;
            }
            if (order === 0) {
              if (pointer.stateDigest === newest.manifest.stateDigest)
                commit(() => send({ type: "artifact-unchanged" }));
              else
                commit(() =>
                  send({
                    type: "candidate-invalid",
                    error:
                      "Indexer returned conflicting digests for one generation",
                  }),
                );
              return;
            }
          }
          commit(() => send({ type: "artifact-loading" }));
          const snapshot = await indexer.snapshotFromPointer(pointer, signal);
          commit(() => send({ type: "artifact-parsed", snapshot }));
        } catch (cause) {
          commit(() =>
            send({
              type: "artifact-failed",
              condition: artifactFailure(cause),
              error: message(cause),
            }),
          );
          throw cause;
        }
      }),
      createVisiblePoller(5_000, REQUEST_TIMEOUT, async (signal, commit) => {
        try {
          const value = await indexer.status(signal);
          commit(() => send({ type: "status-read", value }));
        } catch (cause) {
          commit(() =>
            send({
              type: "status-failed",
              condition:
                cause instanceof SchemaError ? "malformed" : "unavailable",
              error: message(cause),
            }),
          );
          throw cause;
        }
      }),
    );

    const refresh = () => {
      if (document.visibilityState === "visible")
        for (const poller of pollers) poller.refresh();
      else for (const poller of pollers) poller.pause();
    };
    document.addEventListener("visibilitychange", refresh);
    refresh();
    return () => {
      chainRefresh.current = null;
      for (const poller of pollers) poller.dispose();
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [chain, config, indexer]);

  useEffect(() => {
    const snapshot = state.pendingSnapshot;
    if (!snapshot || !state.chain) return;
    if (state.chainVerification === "integrity") {
      send({
        type: "candidate-invalid",
        error: "Chain metadata integrity failure",
      });
      return;
    }
    try {
      assertSnapshotEligible(
        snapshot.manifest,
        snapshot.provenance,
        state.chain,
        config,
      );
      send({ type: "candidate-ready", snapshot });
    } catch (cause) {
      send({ type: "candidate-invalid", error: message(cause) });
    }
  }, [config, state.chain, state.chainVerification, state.pendingSnapshot]);

  useEffect(() => {
    const candidate = state.candidate;
    if (!candidate || !state.chain) return;
    try {
      assertSnapshotEligible(
        candidate.manifest,
        candidate.provenance,
        state.chain,
        config,
      );
    } catch (cause) {
      send({ type: "candidate-invalid", error: message(cause) });
    }
  }, [config, state.candidate, state.chain, state.chainVerification]);

  useEffect(() => {
    setStatusClock(Date.now());
    if (!state.status) return;
    const remaining =
      Date.parse(state.status.heartbeatAt) + 15_000 - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => setStatusClock(Date.now()), remaining);
    return () => clearTimeout(timer);
  }, [state.status, state.statusEndpoint]);

  useEffect(() => {
    const generation = state.visualized?.manifest.generation;
    if (rendererAvailability === "available" && generation)
      announce(`Ready. Visualized generation ${generation}.`);
    else if (rendererAvailability === "context-lost")
      announce("WebGL context lost. Visualization is unavailable.");
    else if (rendererAvailability === "unavailable")
      announce("Visualization unavailable.");
  }, [rendererAvailability, state.visualized]);

  const visualized = state.visualized;
  const rendererSnapshot = visualized ?? state.candidate;
  if (!visualized) ownedRendererKey.current = null;
  const rendererKey = visualized
    ? (ownedRendererKey.current ??= visualized.manifest.stateDigest)
    : rendererSnapshot?.manifest.stateDigest;
  const initialIdentity =
    !visualized && state.candidate && state.candidateEpoch !== null
      ? {
          epoch: state.candidateEpoch,
          digest: state.candidate.manifest.stateDigest,
        }
      : null;
  const approveCommit = (
    snapshot: ImmutableSnapshot,
    identity: { readonly epoch: number; readonly digest: string },
  ): boolean => {
    const current = stateRef.current;
    if (
      rendererAvailabilityRef.current !== "available" ||
      current.candidateEpoch !== identity.epoch ||
      current.candidate?.manifest.stateDigest !== identity.digest ||
      current.chainVerification === "integrity" ||
      !current.chain
    )
      return false;
    try {
      assertSnapshotEligible(
        snapshot.manifest,
        snapshot.provenance,
        current.chain,
        config,
      );
    } catch (cause) {
      send({ type: "candidate-invalid", error: message(cause) });
      return false;
    }
    send({
      type: "visualization-committed",
      digest: identity.digest,
      epoch: identity.epoch,
    });
    return (
      stateRef.current.visualized?.manifest.stateDigest === identity.digest
    );
  };
  void statusClock;
  return (
    <main className="flex h-dvh min-w-80 flex-col overflow-hidden bg-background text-foreground">
      <TopBar state={state} rendererAvailability={rendererAvailability}>
        {wallet && config.transactionProfiles && state.chain ? (
          <BoardSizeControl
            onResettingChange={setResetting}
            visualizedEpoch={state.visualized?.manifest.epoch}
            size={state.chain.width}
            config={config}
            profiles={config.transactionProfiles}
            wallet={wallet}
            client={rpcClient}
            onPreview={setPreviewSize}
            onCommitted={() => chainRefresh.current?.()}
          />
        ) : null}
      </TopBar>
      <div className="relative flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 flex-col">
          {rendererSnapshot ? (
            <WorldViewport
              key={rendererKey}
              client={indexer}
              initialSnapshot={rendererSnapshot}
              previewSize={previewSize}
              initialIdentity={initialIdentity}
              candidate={visualized ? state.candidate : null}
              candidateEpoch={visualized ? state.candidateEpoch : null}
              onTransition={(value) => {
                send({ type: "transition", value });
              }}
              approveCommit={approveCommit}
              onAnnouncement={announce}
              onAvailability={updateRendererAvailability}
            />
          ) : (
            <EmptyWorld state={state} />
          )}
          <GenerationReadout
            state={state}
            rendererAvailability={rendererAvailability}
          />
          <MobileSheets reader={chain} state={state} config={config} />
          {config.transactionProfiles ? (
            <VisitorControls
              resetting={resetting}
              key={`${config.networkId}:${config.contractAddress}`}
              config={config}
              profiles={config.transactionProfiles}
              client={rpcClient}
              onWalletReady={setWallet}
              worldSize={state.chain?.width ?? 10_000}
              onCrankCommitted={() => chainRefresh.current?.()}
            />
          ) : null}
        </div>
        <aside className="hidden min-h-0 w-80 shrink-0 flex-col overflow-y-auto border-l border-border bg-panel/95 lg:flex">
          <DetailsContent state={state} config={config} />
          <WorldActivity reader={chain} />
        </aside>
      </div>
      <p
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </p>
    </main>
  );
}

function TopBar({
  state,
  rendererAvailability,
  children,
}: {
  readonly state: SynchronizationState;
  readonly rendererAvailability: RendererAvailability;
  readonly children?: ReactNode;
}) {
  const identity = state.visualized?.manifest;
  return (
    <header className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border bg-panel/95 pt-[max(.5rem,var(--safe-top))] pr-[max(.75rem,var(--safe-right))] pb-2 pl-[max(.75rem,var(--safe-left))] sm:pr-[max(1rem,var(--safe-right))] sm:pl-[max(1rem,var(--safe-left))] xl:grid-cols-[minmax(0,1fr)_auto_auto]">
      <div className="flex min-w-0 items-center gap-2.5">
        <a
          href="/"
          aria-label="Homepage"
          className="grid size-12 shrink-0 place-items-center rounded-md border border-primary/35 bg-primary/10 text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring sm:size-9 [@media(pointer:coarse)]:size-12"
        >
          <Dna />
        </a>
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold">Chain of Life</h1>
          <p className="truncate font-mono text-xs text-muted-foreground sm:text-sm">
            {((state.chain?.width ?? 10_000) ** 2).toLocaleString()} cells
          </p>
        </div>
      </div>
      {children}
      <div className="hidden items-center gap-6 xl:ml-12 xl:flex">
        <Metric label="On-chain" value={state.chain?.generation ?? "—"} />
        <Metric
          label="Visualized"
          value={
            !identity
              ? "—"
              : rendererAvailability === "available"
                ? identity.generation
                : "Unavailable"
          }
          warning={isBehind(state) || state.chainVerification === "integrity"}
        />
        <Metric
          label="Population"
          value={identity ? Number(identity.population).toLocaleString() : "—"}
        />
        <Metric
          label="Digest"
          value={
            identity
              ? abbreviate(toBase58(hashFromHex(identity.stateDigest)))
              : "—"
          }
          mono
        />
      </div>
    </header>
  );
}

export function GenerationReadout({
  state,
  rendererAvailability = "available",
}: {
  readonly state: SynchronizationState;
  readonly rendererAvailability?: RendererAvailability;
}) {
  const visualized = state.visualized?.manifest.generation;
  return (
    <div className="pointer-events-none absolute top-[max(.75rem,var(--safe-top))] right-[calc(max(.75rem,var(--safe-right))+7rem)] left-[max(.75rem,var(--safe-left))] flex items-center gap-2 rounded-md border border-border bg-panel/95 px-3 py-2 font-mono text-xs shadow-sm backdrop-blur-md sm:right-auto sm:max-w-[calc(100%-2rem)] sm:text-sm">
      {isBehind(state) || state.chainVerification === "integrity" ? (
        <CircleAlert className="shrink-0 text-warning" />
      ) : (
        <CircleCheck className="shrink-0 text-primary" />
      )}
      <span className="truncate">
        {!state.visualized
          ? "No ready visualization"
          : rendererAvailability !== "available"
            ? "Visualization unavailable"
            : state.transition !== "idle"
              ? `Preparing visualization ${state.candidate?.manifest.generation ?? ""}`
              : state.chainVerification === "integrity"
                ? `Chain integrity warning · retained generation ${visualized ?? "—"}`
                : isBehind(state)
                  ? `Displaying older generation ${visualized ?? "—"}`
                  : `Ready · generation ${visualized}`}
      </span>
    </div>
  );
}

function MobileSheets({
  state,
  config,
  reader,
}: {
  readonly state: SynchronizationState;
  readonly config: Readonly<AppConfig>;
  readonly reader: LifeReadAdapter;
}) {
  return (
    <div className="absolute top-[max(.75rem,var(--safe-top))] right-[max(.75rem,var(--safe-right))] flex gap-2 lg:hidden">
      <Sheet>
        <SheetTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className="size-12 bg-panel/95"
            aria-label="Open activity"
          >
            <Activity />
          </Button>
        </SheetTrigger>
        <SheetContent side="bottom">
          <SheetHeader>
            <SheetTitle>Generation activity</SheetTitle>
            <SheetDescription>
              Generation and reset transactions.
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 overflow-y-auto">
            <WorldActivity reader={reader} />
          </div>
        </SheetContent>
      </Sheet>
      <Sheet>
        <SheetTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className="size-12 bg-panel/95"
            aria-label="Open world details"
          >
            <Info />
          </Button>
        </SheetTrigger>
        <SheetContent side="bottom">
          <SheetHeader>
            <SheetTitle>World details</SheetTitle>
            <SheetDescription>
              Board statistics and on-chain identity.
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 overflow-y-auto">
            <DetailsContent state={state} config={config} />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

export function DetailsContent({
  state,
  config,
}: {
  readonly state: SynchronizationState;
  readonly config: Readonly<AppConfig>;
}) {
  const title = useId();
  const snapshot = state.visualized ?? state.candidate;
  const manifest = snapshot?.manifest;
  const provenance = snapshot?.provenance;
  return (
    <section aria-labelledby={title}>
      <details open>
        <summary
          id={title}
          className="cursor-pointer p-4 text-xs font-medium tracking-widest text-muted-foreground uppercase outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          World details
        </summary>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 px-4 pb-4 text-sm">
          <Detail label="Generation" value={manifest?.generation} />
          <Detail label="Population" value={manifest?.population} />
          <Detail
            label="Dimensions"
            value={
              manifest ? `${manifest.width} × ${manifest.height}` : undefined
            }
          />
          <Detail
            label="State digest"
            value={manifest?.stateDigest}
            identifier
          />
          <Detail
            label="Contract"
            value={manifest?.contractAddress ?? config.contractAddress}
            identifier
          />
          <Detail label="Source block" value={provenance?.sourceBlockHeight} />
        </dl>
        {state.chainError || state.artifactError ? (
          <p role="status" className="px-4 pb-4 text-xs text-warning">
            {state.chainError ?? state.artifactError}
          </p>
        ) : null}
      </details>
    </section>
  );
}

function EmptyWorld({ state }: { readonly state: SynchronizationState }) {
  return (
    <section className="grid min-h-0 flex-1 place-items-center bg-canvas p-6">
      <div className="max-w-[52ch] text-center">
        <h2 className="text-xl font-semibold">No ready visualization</h2>
        <p className="mt-2 text-muted-foreground">
          {emptyVisualizationMessage(state)}
        </p>
        {state.chain ? (
          <p className="mt-4 font-mono text-sm">
            On-chain generation {state.chain.generation} · population{" "}
            {Number(state.chain.population).toLocaleString()}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function Metric({
  label,
  value,
  mono = false,
  warning = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
  readonly warning?: boolean;
}) {
  return (
    <dl className="min-w-0">
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "text-sm",
          mono ? "font-mono" : "font-medium",
          warning && "text-warning",
        )}
      >
        {value}
      </dd>
    </dl>
  );
}

function Detail({
  label,
  value,
  identifier = false,
}: {
  readonly label: string;
  readonly value: string | undefined;
  readonly identifier?: boolean;
}) {
  const fullValue = identifier && value ? toBase58(hashFromHex(value)) : value;
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd title={fullValue} className="min-w-0 text-right font-mono text-xs">
        {identifier && fullValue ? abbreviate(fullValue) : (fullValue ?? "—")}
      </dd>
    </>
  );
}

function emptyVisualizationMessage(state: SynchronizationState): string {
  if (state.artifactState === "awaiting-chain")
    return "Snapshot artifacts loaded; awaiting chain verification.";
  if (state.artifactState === "unavailable")
    return "Visualization updates unavailable and no verified snapshot is available.";
  if (state.artifactState === "malformed")
    return "Indexer artifacts are malformed; no snapshot can be displayed.";
  if (state.artifactState === "invalid")
    return (
      state.artifactError ?? "Snapshot evidence is not eligible for display."
    );
  return "Validating immutable indexer artifacts.";
}

function isBehind(state: SynchronizationState): boolean {
  return Boolean(
    state.chain &&
    state.visualized &&
    compareWorldVersion(state.chain, state.visualized.manifest) > 0,
  );
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : "Request failed";
}

function artifactFailure(cause: unknown): "unavailable" | "malformed" {
  return cause instanceof SchemaError ||
    (cause instanceof Error &&
      /content type|content length|disagree|scope|escaped|schema/i.test(
        cause.message,
      ))
    ? "malformed"
    : "unavailable";
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (cause) => {
        signal.removeEventListener("abort", abort);
        reject(cause);
      },
    );
  });
}
