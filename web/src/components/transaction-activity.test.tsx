import type { ThruputClient } from "@thruputchain/client";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AppConfig } from "@/config";
import { walletFromSeed } from "@/wallet/visitor-wallet";
import { observeCompletions } from "@/transactions/observer";
import {
  requestStorageKey,
  saveCranks,
  saveRequests,
  transactionScope,
  type AcceptedRequest,
} from "@/transactions/records";
import { TransactionActivity } from "./transaction-activity";
import { advance, recoverCrank, recoverRequest } from "@/transactions/workflow";

vi.mock("@/transactions/workflow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/transactions/workflow")>()),
  advance: vi.fn(),
  recoverRequest: vi.fn(),
  recoverCrank: vi.fn(),
}));

const emptyBatch = {
  scanned: new Set<string>(),
  completed: new Set<string>(),
  retentionGaps: new Set<string>(),
  observedThroughBlock: null,
};

vi.mock("@/transactions/observer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/transactions/observer")>()),
  observeCompletions: vi.fn(),
}));

const config = {
  networkId: "11".repeat(32),
  contractAddress: `0x${"22".repeat(32)}`,
  transactionProfiles: {
    request: {
      transactionGasLimit: 100_000n,
      targetGasLimit: 100_000n,
      expiryBlocks: 64n,
      observationTimeoutMs: 30_000,
    },
    crank: {
      transactionGasLimit: 10_010_000_000n,
      targetGasLimit: 10_000_000_000n,
      expiryBlocks: 2n,
      observationTimeoutMs: 300_000,
    },
  },
} as Readonly<AppConfig>;
const wallet = walletFromSeed(`0x${"01".repeat(32)}`);

describe("transaction activity", () => {
  test("disables Advance while a reset is in progress", () => {
    render(
      <TransactionActivity
        config={config}
        profiles={config.transactionProfiles!}
        wallet={wallet}
        client={{} as ThruputClient}
        onCrankCommitted={vi.fn()}
        worldSize={10_000}
        resetting
      />,
    );
    const advanceButton = screen.getByRole("button", {
      name: "Resetting world...",
    });
    expect(advanceButton).toBeDisabled();
    fireEvent.click(advanceButton);
    expect(advance).not.toHaveBeenCalled();
  });
  test("advances once and shows why the action did not advance the world", async () => {
    vi.mocked(observeCompletions).mockResolvedValue(emptyBatch);
    vi.mocked(advance).mockResolvedValue({
      requests: [],
      cranks: [],
      message: "Offline",
    });
    render(
      <TransactionActivity
        config={config}
        profiles={config.transactionProfiles!}
        wallet={wallet}
        client={{} as ThruputClient}
        onCrankCommitted={vi.fn()}
        worldSize={10_000}
      />,
    );
    expect(screen.queryByLabelText("Auto process")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Advance 100,000,000 cells" }),
    );
    await waitFor(() => expect(advance).toHaveBeenCalledOnce());
    expect(await screen.findByRole("alert")).toHaveTextContent("Offline");
  });
  test("shows one check action for each pending request and crank", async () => {
    vi.mocked(observeCompletions).mockResolvedValue(emptyBatch);
    vi.mocked(recoverRequest).mockResolvedValue({
      requests: [],
      cranks: [],
      message: null,
    });
    vi.mocked(recoverCrank).mockResolvedValue({
      requests: [],
      cranks: [],
      message: null,
    });
    const scope = transactionScope(config, wallet.addressHex);
    saveRequests(scope, [
      { localId: "signing", status: "signing" },
      acceptedRequest(),
      { localId: "failed", status: "failed", transactionHash: null },
    ]);
    saveCranks(scope, [
      {
        localId: "crank",
        status: "indeterminate",
        transactionHash: `0x${"66".repeat(32)}`,
      },
    ]);
    render(
      <TransactionActivity
        config={config}
        profiles={config.transactionProfiles!}
        wallet={wallet}
        client={{} as ThruputClient}
        onCrankCommitted={vi.fn()}
        worldSize={10_000}
      />,
    );
    expect(screen.getAllByRole("button", { name: /^Check/ })).toHaveLength(2);
    expect(screen.queryByText(/I confirm/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check request" }));
    await waitFor(() =>
      expect(recoverRequest).toHaveBeenCalledWith(expect.anything(), "signing"),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Check crank / }));
    await waitFor(() =>
      expect(recoverCrank).toHaveBeenCalledWith(expect.anything(), "crank"),
    );
  });
  test("updates the advance count when the on-chain board size changes", () => {
    const props = {
      config,
      profiles: config.transactionProfiles!,
      wallet,
      client: {} as ThruputClient,
      onCrankCommitted: vi.fn(),
    };
    const { rerender } = render(
      <TransactionActivity {...props} worldSize={100} />,
    );
    expect(
      screen.getByRole("button", { name: "Advance 10,000 cells" }),
    ).toBeInTheDocument();
    rerender(<TransactionActivity {...props} worldSize={7400} />);
    expect(
      screen.getByRole("button", { name: "Advance 54,760,000 cells" }),
    ).toBeInTheDocument();
    rerender(<TransactionActivity {...props} worldSize={null} />);
    expect(
      screen.getByRole("button", { name: "Advance world" }),
    ).toBeInTheDocument();
  });
  test("preserves the read surface and reports malformed durable storage", () => {
    const scope = transactionScope(config, wallet.addressHex);
    localStorage.setItem(requestStorageKey(scope), "malformed");
    render(
      <TransactionActivity
        config={config}
        profiles={config.transactionProfiles!}
        wallet={wallet}
        client={{} as ThruputClient}
        onCrankCommitted={vi.fn()}
        worldSize={10_000}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/invalid/);
    expect(
      screen.getByRole("button", { name: "Advance 100,000,000 cells" }),
    ).toBeEnabled();
    expect(localStorage.getItem(requestStorageKey(scope))).toBe("malformed");
  });

  test("clears an observer error after a successful no-op scan", async () => {
    const scope = transactionScope(config, wallet.addressHex);
    saveRequests(scope, [acceptedRequest()]);
    vi.mocked(observeCompletions)
      .mockRejectedValueOnce(new Error("observer unavailable"))
      .mockResolvedValueOnce(emptyBatch);
    let rescan: (() => Promise<void>) | null = null;
    vi.spyOn(window, "setInterval").mockImplementation((handler) => {
      rescan ??= handler as () => Promise<void>;
      return {} as ReturnType<typeof setInterval>;
    });

    render(
      <TransactionActivity
        config={config}
        profiles={config.transactionProfiles!}
        wallet={wallet}
        client={{} as ThruputClient}
        onCrankCommitted={vi.fn()}
        worldSize={10_000}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "observer unavailable",
    );

    await act(() => Promise.resolve());
    await act(async () => {
      await rescan!();
    });
    expect(observeCompletions).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("does not clear a newer storage error when an older scan succeeds", async () => {
    const scope = transactionScope(config, wallet.addressHex);
    saveRequests(scope, [acceptedRequest()]);
    let resolveObservation!: (
      value: Awaited<ReturnType<typeof observeCompletions>>,
    ) => void;
    vi.mocked(observeCompletions).mockImplementation(
      () => new Promise((resolve) => (resolveObservation = resolve)),
    );

    render(
      <TransactionActivity
        config={config}
        profiles={config.transactionProfiles!}
        wallet={wallet}
        client={{} as ThruputClient}
        onCrankCommitted={vi.fn()}
        worldSize={10_000}
      />,
    );
    await vi.waitFor(() => expect(observeCompletions).toHaveBeenCalledOnce());

    act(() => {
      localStorage.setItem(requestStorageKey(scope), "malformed");
      window.dispatchEvent(
        new StorageEvent("storage", { key: requestStorageKey(scope) }),
      );
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/invalid/);

    await act(async () => {
      resolveObservation(emptyBatch);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/invalid/);
  });
});

afterEach(() => {
  vi.mocked(advance).mockReset();
  vi.mocked(recoverRequest).mockReset();
  vi.mocked(recoverCrank).mockReset();
  vi.mocked(observeCompletions).mockReset();
  vi.restoreAllMocks();
});

function acceptedRequest(): AcceptedRequest {
  return {
    localId: "request-1",
    status: "accepted",
    transactionHash: `0x${"44".repeat(32)}`,
    requestId: `0x${"55".repeat(32)}`,
    epoch: "0",
    receiptBlock: "7",
    observedThroughBlock: null,
  };
}
