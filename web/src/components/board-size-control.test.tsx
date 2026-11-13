import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { WorldWriteState } from "@/transactions/use-world-write";
import type { WorldWrite } from "@/transactions/world-write";
import { BoardSizeControl } from "./board-size-control";

function writes(write: WorldWrite | null = null): WorldWriteState {
  return {
    write,
    busy: false,
    error: null,
    pending: false,
    submit: vi.fn(async (request) =>
      request.kind === "resize"
        ? {
            ...request,
            status: "committed" as const,
            transactionHash: `0x${"11".repeat(32)}`,
            epoch: "2",
          }
        : null,
    ),
  };
}

test("range changes preview and one release commits without a duplicate on blur", async () => {
  const state = writes();
  const onPreview = vi.fn();
  render(
    <BoardSizeControl
      size={10_000}
      writes={state}
      resetting={false}
      onPreview={onPreview}
    />,
  );
  const slider = screen.getByRole("slider", { name: "Board size" });
  fireEvent.change(slider, { target: { value: "1000" } });
  fireEvent.change(slider, { target: { value: "100" } });
  expect(onPreview).toHaveBeenLastCalledWith(100);
  expect(state.submit).not.toHaveBeenCalled();
  fireEvent.pointerUp(slider);
  await waitFor(() => expect(state.submit).toHaveBeenCalledOnce());
  fireEvent.blur(slider);
  fireEvent.pointerUp(slider);
  expect(state.submit).toHaveBeenCalledOnce();
  expect(state.submit).toHaveBeenCalledWith({ kind: "resize", size: 100 });
});

test("retries the saved failed size when the slider shows the current size", async () => {
  const state = writes({
    kind: "resize",
    size: 8000,
    status: "failed",
    message: "Signing was interrupted. Try again.",
  });
  render(
    <BoardSizeControl
      size={2200}
      writes={state}
      resetting={false}
      onPreview={vi.fn()}
    />,
  );
  expect(screen.getByRole("slider")).toHaveValue("2200");
  expect(screen.getByText(/Signing was interrupted\./)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(state.submit).toHaveBeenCalledWith({ kind: "resize", size: 8000 }),
  );
  expect(screen.getByRole("slider")).toHaveValue("8000");
});

test("disables the slider while a reset is pending or not yet visible", () => {
  const { rerender } = render(
    <BoardSizeControl
      size={2200}
      writes={writes()}
      resetting
      onPreview={vi.fn()}
    />,
  );
  expect(screen.getByRole("slider")).toBeDisabled();
  expect(screen.getByText("Resetting world…")).toBeVisible();
  rerender(
    <BoardSizeControl
      size={2200}
      writes={{ ...writes(), pending: true }}
      resetting={false}
      onPreview={vi.fn()}
    />,
  );
  expect(screen.getByRole("slider")).toBeDisabled();
});
