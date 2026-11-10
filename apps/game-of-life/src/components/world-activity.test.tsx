import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { hashFromHex, toBase58 } from "@thruputchain/client";
import { afterEach, expect, test, vi } from "vitest";
import type { LifeChainEvent, LifeReadAdapter } from "@/chain/game-of-life";
import { WorldActivity } from "./world-activity";

function advanced(
  generation: string,
  blockHeight: string,
  byte: string,
): LifeChainEvent {
  return {
    kind: "GenerationAdvanced",
    epoch: "2",
    generation,
    blockHeight,
    transactionHash: `0x${byte.repeat(32)}`,
    sequenceNumber: 0,
    requestId: `0x${"11".repeat(32)}`,
    requester: `0x${"22".repeat(32)}`,
    population: "100",
    stateDigest: `0x${"33".repeat(32)}`,
  };
}

function openActivity() {
  const details = screen.getByText("Activity").closest("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
}

afterEach(() => Reflect.deleteProperty(navigator, "clipboard"));

test("loads generations newest first and copies full hashes without explorer links", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  const first = advanced("1", "10", "44");
  const second = advanced("2", "12", "55");
  const reset: LifeChainEvent = {
    kind: "WorldInitialized",
    epoch: "3",
    size: 1100,
    blockHeight: "15",
    transactionHash: `0x${"66".repeat(32)}`,
    sequenceNumber: 0,
    seed: "0",
    maxQueueLength: 8,
    population: "100",
    stateDigest: `0x${"77".repeat(32)}`,
  };
  const requested: LifeChainEvent = {
    kind: "TickRequested",
    epoch: "2",
    blockHeight: "11",
    transactionHash: `0x${"88".repeat(32)}`,
    sequenceNumber: 0,
    requestId: `0x${"11".repeat(32)}`,
    requester: `0x${"22".repeat(32)}`,
  };
  const events = vi
    .fn()
    .mockResolvedValue([first, second, requested, reset, second]);
  render(<WorldActivity reader={{ events } as unknown as LifeReadAdapter} />);
  expect(events).not.toHaveBeenCalled();
  openActivity();
  await screen.findByRole("button", { name: /generation 0, epoch 3/ });
  const buttons = screen.getAllByRole("button");
  expect(buttons).toHaveLength(3);
  expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
    "Copy transaction hash for generation 0, epoch 3",
    "Copy transaction hash for generation 2, epoch 2",
    "Copy transaction hash for generation 1, epoch 2",
  ]);
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
  fireEvent.click(buttons[0]!);
  await waitFor(() => expect(buttons[0]).toHaveAttribute("title", "Copied"));
  expect(writeText).toHaveBeenCalledWith(
    toBase58(hashFromHex(reset.transactionHash)),
  );
  writeText.mockRejectedValueOnce(new Error("Clipboard permission denied"));
  fireEvent.click(buttons[1]!);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    toBase58(hashFromHex(second.transactionHash)),
  );
  expect(buttons[1]).toHaveAttribute("title", "Copy full hash");
  expect(events).toHaveBeenCalledWith(0n);
});

test("shows an empty state and recovers after reopening a failed lookup", async () => {
  const events = vi
    .fn()
    .mockRejectedValueOnce(new Error("RPC unavailable"))
    .mockResolvedValue([]);
  render(<WorldActivity reader={{ events } as unknown as LifeReadAdapter} />);
  openActivity();
  expect(await screen.findByRole("alert")).toHaveTextContent("RPC unavailable");
  const details = screen.getByText("Activity").closest("details")!;
  details.open = false;
  fireEvent(details, new Event("toggle"));
  await waitFor(() => expect(details.open).toBe(false));
  openActivity();
  expect(
    await screen.findByText("No generation transactions yet."),
  ).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
