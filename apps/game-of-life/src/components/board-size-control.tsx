import { useEffect, useId, useRef, useState } from "react";
import type { CoreThruputClient } from "@thruputchain/client";
import type { AppConfig, LifeTransactionProfiles } from "@/config";
import type { VisitorWallet } from "@/wallet/visitor-wallet";
import { transactionScope } from "@/transactions/records";
import {
  loadResize,
  resizeStorageKey,
  subscribeResize,
  resizeWorld,
  recoverResize,
  type ResizeRecord,
} from "@/transactions/resize";
import { createWriteBoundary } from "@/transactions/write-boundary";

export function BoardSizeControl({
  size,
  config,
  profiles,
  wallet,
  client,
  onPreview,
  onCommitted,
  visualizedEpoch,
  onResettingChange,
}: {
  readonly size: number;
  readonly config: Readonly<AppConfig>;
  readonly profiles: LifeTransactionProfiles;
  readonly wallet: VisitorWallet;
  readonly client: CoreThruputClient | Promise<CoreThruputClient>;
  readonly onPreview: (size: number | null) => void;
  readonly onCommitted: () => void;
  readonly visualizedEpoch?: string | undefined;
  readonly onResettingChange?: (resetting: boolean) => void;
}) {
  const id = useId();
  const [selected, setSelected] = useState(size);
  const [record, setRecord] = useState<ResizeRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const running = useRef(false);
  const appliedSize = useRef<number | null>(null);
  const [boundary] = useState(() =>
    createWriteBoundary(config, wallet, client),
  );
  const scope = transactionScope(config, wallet.addressHex);
  const key = resizeStorageKey(scope);
  useEffect(() => {
    setSelected(size);
    appliedSize.current = null;
  }, [size]);
  useEffect(() => {
    const reload = () => {
      try {
        setRecord(loadResize(scope));
        setStorageError(false);
      } catch (cause) {
        setStorageError(true);
        setError(
          cause instanceof Error
            ? cause.message
            : "Cannot read resize evidence",
        );
      }
    };
    reload();
    return subscribeResize(scope, reload);
  }, [key]);
  const pending =
    record?.status === "signing" || record?.status === "indeterminate";
  const preparing =
    record?.status === "committed" &&
    record.epoch !== null &&
    (visualizedEpoch === undefined ||
      BigInt(visualizedEpoch) < BigInt(record.epoch));
  const resetting = busy || pending || preparing || storageError;
  useEffect(
    () => onResettingChange?.(resetting),
    [resetting, onResettingChange],
  );
  const run = async (recover = false, retry = false) => {
    if (
      running.current ||
      (!recover &&
        (pending ||
          preparing ||
          storageError ||
          (!retry && (selected === size || selected === appliedSize.current))))
    )
      return;
    running.current = true;
    setBusy(true);
    onResettingChange?.(true);
    setError(null);
    const targetSize =
      retry && record?.status === "failed" ? record.size : selected;
    if (retry) setSelected(targetSize);
    if (!recover) setRecord(null);
    onPreview(null);
    try {
      const params = { config, profiles, wallet, boundary };
      const next = await (recover
        ? recoverResize(params)
        : resizeWorld(params, targetSize));
      setRecord(next);
      if (next.status === "committed") {
        appliedSize.current = next.size;
        onCommitted();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Resize failed");
      try {
        setRecord(loadResize(scope));
      } catch {
        setStorageError(true);
      }
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!pending || !record?.hash || busy) return;
    const timer = window.setTimeout(() => void run(true), 3_000);
    return () => window.clearTimeout(timer);
  }, [pending, record, busy]);
  return (
    <div className="col-span-full grid min-w-0 gap-0 sm:col-span-1 sm:w-72">
      <div className="flex items-center justify-between gap-3 text-base tabular-nums sm:text-xs">
        <label htmlFor={id}>Board size</label>
        <output htmlFor={id} className="font-mono">
          {selected.toLocaleString()} × {selected.toLocaleString()}
        </output>
      </div>
      <input
        id={id}
        name="board-size"
        type="range"
        min={100}
        max={10_000}
        step={100}
        value={selected}
        disabled={resetting}
        aria-valuetext={`${selected} by ${selected} cells`}
        className="h-8 w-full accent-primary focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 sm:h-5"
        onChange={(event) => {
          const next = Number(event.target.value);
          setError(null);
          if (record?.status === "failed") setRecord(null);
          appliedSize.current = null;
          setSelected(next);
          onPreview(next === size ? null : next);
        }}
        onPointerDown={(event) =>
          event.currentTarget.setPointerCapture(event.pointerId)
        }
        onPointerUp={() => void run()}
        onPointerCancel={() => {
          setSelected(size);
          onPreview(null);
        }}
        onKeyUp={(event) => {
          if (
            [
              "ArrowLeft",
              "ArrowRight",
              "ArrowUp",
              "ArrowDown",
              "Home",
              "End",
              "PageUp",
              "PageDown",
            ].includes(event.key)
          )
            void run();
        }}
      />
      <p className="text-xs text-muted-foreground tabular-nums" role="status">
        {storageError ? (
          "Cannot read reset status"
        ) : busy || preparing ? (
          "Resetting world…"
        ) : pending ? (
          "Checking reset…"
        ) : error || record?.status === "failed" ? (
          <>
            Reset failed.{" "}
            <button
              type="button"
              className="text-primary underline"
              onClick={() => void run(false, true)}
            >
              Try again
            </button>
          </>
        ) : selected !== size ? (
          `Preview · ${(selected * selected).toLocaleString()} cells · release to reset`
        ) : (
          `${(size * size).toLocaleString()} cells · resize resets generation`
        )}
      </p>
    </div>
  );
}
