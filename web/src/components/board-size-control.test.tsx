import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { AppConfig, LifeTransactionProfiles } from "@/config";
import type { VisitorWallet } from "@/wallet/visitor-wallet";
import { BoardSizeControl } from "./board-size-control";

const resize = vi.hoisted(() =>
  vi.fn(async (_params: unknown, size: number) => ({
    status: "committed",
    epoch: "2",
    size,
  })),
);
const loadResize = vi.hoisted(() => vi.fn<() => unknown>(() => null));
const recoverResize = vi.hoisted(() => vi.fn());
vi.mock("@/transactions/resize", () => ({
  resizeWorld: resize,
  recoverResize,
  loadResize,
  resizeStorageKey: () => "resize-test",
  subscribeResize: () => () => {},
}));
vi.mock("@/transactions/write-boundary", () => ({
  createWriteBoundary: () => ({}),
}));

test("range changes preview and one release commits without a duplicate on blur", async () => {
  resize.mockClear();
  const onPreview = vi.fn();
  const onCommitted = vi.fn();
  render(
    <BoardSizeControl
      size={10_000}
      config={{ networkId: "aa", contractAddress: "bb" } as AppConfig}
      profiles={{} as LifeTransactionProfiles}
      wallet={{ addressHex: "cc" } as VisitorWallet}
      client={Promise.resolve({} as never)}
      onPreview={onPreview}
      onCommitted={onCommitted}
    />,
  );
  const slider = screen.getByRole("slider", { name: "Board size" });
  fireEvent.change(slider, { target: { value: "1000" } });
  fireEvent.change(slider, { target: { value: "100" } });
  expect(onPreview).toHaveBeenLastCalledWith(100);
  expect(resize).not.toHaveBeenCalled();
  fireEvent.pointerUp(slider);
  await waitFor(() => expect(onCommitted).toHaveBeenCalledOnce());
  fireEvent.blur(slider);
  expect(resize).toHaveBeenCalledOnce();
  expect(resize).toHaveBeenCalledWith(expect.anything(), 100);
});

test("retries the saved failed size after reload when the slider shows the current size", async () => {
  resize.mockClear();
  loadResize.mockReturnValueOnce({ status: "failed", size: 8000 });
  render(
    <BoardSizeControl
      size={2200}
      config={{ networkId: "aa", contractAddress: "bb" } as AppConfig}
      profiles={{} as LifeTransactionProfiles}
      wallet={{ addressHex: "cc" } as VisitorWallet}
      client={Promise.resolve({} as never)}
      onPreview={vi.fn()}
      onCommitted={vi.fn()}
      visualizedEpoch="1"
    />,
  );
  expect(screen.getByRole("slider")).toHaveValue("2200");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(resize).toHaveBeenCalledWith(expect.anything(), 8000),
  );
  expect(screen.getByRole("slider")).toHaveValue("8000");
});

test("shows concise failure feedback and waits for the reset to be visible", async () => {
  resize.mockClear();
  resize.mockRejectedValueOnce(new Error("Long executor diagnostic"));
  const onResettingChange = vi.fn();
  const props = {
    size: 10_000,
    config: { networkId: "aa", contractAddress: "bb" } as AppConfig,
    profiles: {} as LifeTransactionProfiles,
    wallet: { addressHex: "cc" } as VisitorWallet,
    client: Promise.resolve({} as never),
    onPreview: vi.fn(),
    onCommitted: vi.fn(),
    onResettingChange,
    visualizedEpoch: "1",
  };
  const { rerender } = render(<BoardSizeControl {...props} />);
  const slider = screen.getByRole("slider");
  fireEvent.change(slider, { target: { value: "8000" } });
  fireEvent.pointerUp(slider);
  const retry = await screen.findByRole("button", { name: "Try again" });
  expect(screen.getByText("Reset failed.")).toHaveAttribute("role", "status");
  expect(
    screen.queryByText("Long executor diagnostic"),
  ).not.toBeInTheDocument();
  expect(onResettingChange).toHaveBeenLastCalledWith(false);
  fireEvent.blur(slider);
  expect(resize).toHaveBeenCalledOnce();
  fireEvent.click(retry);
  await waitFor(() => expect(props.onCommitted).toHaveBeenCalledOnce());
  expect(slider).toBeDisabled();
  expect(onResettingChange).toHaveBeenLastCalledWith(true);
  rerender(<BoardSizeControl {...props} size={8000} visualizedEpoch="2" />);
  await waitFor(() => expect(slider).toBeEnabled());
  expect(onResettingChange).toHaveBeenLastCalledWith(false);
});

test("automatically releases a hashless reset and enables an explicit retry", async () => {
  vi.useFakeTimers();
  try {
    resize.mockClear();
    recoverResize.mockResolvedValueOnce({
      status: "failed",
      hash: null,
      size: 8000,
      message: "Reset interrupted. Try again.",
    });
    loadResize.mockReturnValueOnce({
      status: "signing",
      hash: null,
      size: 8000,
    });
    const onResettingChange = vi.fn();
    render(
      <BoardSizeControl
        size={2200}
        config={{ networkId: "aa", contractAddress: "bb" } as AppConfig}
        profiles={{} as LifeTransactionProfiles}
        wallet={{ addressHex: "cc" } as VisitorWallet}
        client={Promise.resolve({} as never)}
        onPreview={vi.fn()}
        onCommitted={vi.fn()}
        onResettingChange={onResettingChange}
      />,
    );
    expect(screen.getByRole("slider")).toBeDisabled();
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(screen.getByRole("slider")).toBeEnabled();
    expect(screen.getByText("Reset interrupted.")).toHaveTextContent(
      "Reset interrupted. Try again",
    );
    expect(onResettingChange).toHaveBeenLastCalledWith(false);
    expect(resize).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });
    expect(resize).toHaveBeenCalledWith(expect.anything(), 8000);
  } finally {
    vi.useRealTimers();
  }
});
