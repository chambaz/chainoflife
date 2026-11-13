import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { WorldWriteState } from "@/transactions/use-world-write";
import type { WorldWrite } from "@/transactions/world-write";
import { walletFromSeed } from "@/wallet/visitor-wallet";
import { TransactionActivity } from "./transaction-activity";

const wallet = walletFromSeed(`0x${"01".repeat(32)}`);

function writes(
  write: WorldWrite | null = null,
  overrides: Partial<WorldWriteState> = {},
): WorldWriteState {
  return {
    write,
    busy: false,
    error: null,
    pending: write?.status === "signing" || write?.status === "indeterminate",
    submit: vi.fn(async () => null),
    ...overrides,
  };
}

describe("advance control", () => {
  test("submits one advance transaction", () => {
    const state = writes();
    render(
      <TransactionActivity wallet={wallet} worldSize={10_000} writes={state} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Advance 100,000,000 cells" }),
    );
    expect(state.submit).toHaveBeenCalledOnce();
    expect(state.submit).toHaveBeenCalledWith({ kind: "advance" });
  });

  test("shows the world size, or a neutral label before metadata loads", () => {
    const state = writes();
    const { rerender } = render(
      <TransactionActivity wallet={wallet} worldSize={7400} writes={state} />,
    );
    expect(
      screen.getByRole("button", { name: "Advance 54,760,000 cells" }),
    ).toBeEnabled();
    rerender(
      <TransactionActivity wallet={wallet} worldSize={null} writes={state} />,
    );
    expect(screen.getByRole("button", { name: "Advance world" })).toBeEnabled();
  });

  test("disables Advance during a reset or a pending write", () => {
    const state = writes();
    const { rerender } = render(
      <TransactionActivity
        wallet={wallet}
        worldSize={10_000}
        writes={state}
        resetting
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Resetting world..." }));
    expect(state.submit).not.toHaveBeenCalled();
    const hash = `0x${"44".repeat(32)}`;
    rerender(
      <TransactionActivity
        wallet={wallet}
        worldSize={10_000}
        writes={writes({
          kind: "advance",
          status: "indeterminate",
          transactionHash: hash,
        })}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Advance 100,000,000 cells" }),
    ).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking transaction",
    );
  });

  test("shows why an advance failed and allows another attempt", () => {
    const state = writes({
      kind: "advance",
      status: "failed",
      message:
        "The transaction expired without committing. Another visitor may have changed the world first. You can try again.",
    });
    render(
      <TransactionActivity wallet={wallet} worldSize={10_000} writes={state} />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Another visitor may have changed the world first.",
    );
    expect(
      screen.getByRole("button", { name: "Advance 100,000,000 cells" }),
    ).toBeEnabled();
  });

  test("reports invalid stored evidence", () => {
    render(
      <TransactionActivity
        wallet={wallet}
        worldSize={10_000}
        writes={writes(null, {
          error: "Stored world-write evidence is invalid",
        })}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/invalid/);
  });
});
