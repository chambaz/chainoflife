import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ImmutableSnapshot, IndexerClient } from "@/indexer/client";
import type { RendererCallbacks } from "@/renderer/world-renderer";
import { WorldViewport } from "./world-viewport";

const mockRenderer = vi.hoisted(() => ({
  callbacks: null as RendererCallbacks | null,
}));

vi.mock("@/renderer/world-renderer", () => ({
  WorldRenderer: class {
    constructor(
      _canvas: HTMLCanvasElement,
      _client: IndexerClient,
      _visualized: ImmutableSnapshot | null,
      _worldSize: number,
      callbacks: RendererCallbacks,
    ) {
      mockRenderer.callbacks = callbacks;
    }

    destroy() {}
    stageSnapshot() {}
    cancelCandidate() {}
    handleKey() {}
    resize() {}
    zoom() {}
    fit() {}
    fill() {}
  },
}));

beforeEach(() => {
  mockRenderer.callbacks = null;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

describe("world viewport renderer failures", () => {
  test("transitions a failed context restoration to terminal unavailability", () => {
    const onAvailability = vi.fn();
    renderViewport(onAvailability);

    act(() => mockRenderer.callbacks!.onContext(true));
    expect(
      screen.getByText("WebGL context lost. Waiting for restoration."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeDisabled();

    act(() => mockRenderer.callbacks!.onUnavailable("restoration failed"));
    expect(
      screen.queryByText("WebGL context lost. Waiting for restoration."),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Visualization unavailable" }),
    ).toBeInTheDocument();
    expect(screen.getByText("restoration failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeDisabled();
    expect(onAvailability).toHaveBeenLastCalledWith("unavailable");
  });

  test("clears a tile warning once the renderer resolves it", () => {
    renderViewport(vi.fn());

    act(() => mockRenderer.callbacks!.onTileWarning("tile failed"));
    expect(screen.getByRole("status")).toHaveTextContent("tile failed");

    act(() => mockRenderer.callbacks!.onTileWarning(null));
    expect(screen.queryByText("tile failed")).not.toBeInTheDocument();
  });
});

function renderViewport(onAvailability: (value: string) => void) {
  render(
    <WorldViewport
      client={{} as IndexerClient}
      visualized={{ manifest: { width: 10_000 } } as ImmutableSnapshot}
      candidate={null}
      candidateEpoch={null}
      approveCommit={() => true}
      onAnnouncement={vi.fn()}
      onAvailability={onAvailability}
    />,
  );
}
