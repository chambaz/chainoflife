import { useEffect, useId, useRef, useState } from "react";
import type { WorldWriteState } from "@/transactions/use-world-write";

export function BoardSizeControl({
  size,
  writes,
  resetting,
  onPreview,
}: {
  readonly size: number;
  readonly writes: WorldWriteState;
  /** True while a reset is pending or its new world is not yet visible. */
  readonly resetting: boolean;
  readonly onPreview: (size: number | null) => void;
}) {
  const id = useId();
  const [selected, setSelected] = useState(size);
  const appliedSize = useRef<number | null>(null);
  const { write } = writes;
  const failed = write?.kind === "resize" && write.status === "failed";
  const disabled = resetting || writes.busy || writes.pending;
  useEffect(() => {
    setSelected(size);
    appliedSize.current = null;
  }, [size]);
  const reset = async (target: number) => {
    if (disabled) return;
    setSelected(target);
    onPreview(null);
    const next = await writes.submit({ kind: "resize", size: target });
    if (next?.kind === "resize" && next.status === "committed")
      appliedSize.current = next.size;
  };
  const commit = () => {
    if (selected !== size && selected !== appliedSize.current)
      void reset(selected);
  };
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
        disabled={disabled}
        aria-valuetext={`${selected} by ${selected} cells`}
        className="h-8 w-full accent-primary focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 sm:h-5"
        onChange={(event) => {
          const next = Number(event.target.value);
          appliedSize.current = null;
          setSelected(next);
          onPreview(next === size ? null : next);
        }}
        onPointerDown={(event) =>
          event.currentTarget.setPointerCapture(event.pointerId)
        }
        onPointerUp={commit}
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
            commit();
        }}
      />
      <p className="text-xs text-muted-foreground tabular-nums" role="status">
        {resetting ? (
          "Resetting world…"
        ) : failed ? (
          <>
            {write.message}{" "}
            <button
              type="button"
              className="text-primary underline"
              onClick={() => void reset(write.size)}
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
