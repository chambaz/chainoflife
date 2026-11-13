import { describe, expect, test, vi } from "vitest";
import {
  prepareVisitorWallet,
  visitorWalletKey,
  type FundingClient,
} from "./visitor-wallet";

const network = "aa".repeat(32);

function fixture() {
  let funded = false;
  const balance = vi.fn(async () => ({
    rawBalance: funded ? 100_000_000n : 0n,
  }));
  const airdrop = vi.fn(async () => {
    const saved = JSON.parse(localStorage.getItem(visitorWalletKey(network))!);
    expect(saved.seed).toMatch(/^0x[0-9a-f]{64}$/);
    expect(saved.funding.nonce).toMatch(/^0x[0-9a-f]{32}$/);
    funded = true;
    return {
      attemptStatus: "succeeded",
      transactionHash: new Uint8Array(32),
      execution: { result: "return" },
    };
  });
  const receipt = vi.fn(async () => ({ execution: { result: "return" } }));
  const client = {
    getBalance: balance,
    requestAirdropAttempt: airdrop,
    waitForTransactionReceipt: receipt,
  } as unknown as FundingClient;
  return {
    client,
    balance,
    airdrop,
    receipt,
    fund: () => {
      funded = true;
    },
  };
}

describe("visitor wallet", () => {
  test("does not repeat uncertain funding when an existing balance is below the budget", async () => {
    const { client, balance, airdrop } = fixture();
    balance.mockResolvedValue({ rawBalance: 10n });
    airdrop.mockRejectedValueOnce(new Error("Connection lost"));
    await expect(prepareVisitorWallet(network, client, 100n)).rejects.toThrow(
      "Connection lost",
    );
    for (let attempt = 0; attempt < 2; attempt += 1)
      await expect(prepareVisitorWallet(network, client, 100n)).rejects.toThrow(
        /not provide enough/,
      );
    expect(airdrop).toHaveBeenCalledOnce();
  });
  test("requests the full transaction budget once and reuses the funded wallet", async () => {
    const { client, balance, airdrop } = fixture();
    let rawBalance = 0n;
    balance.mockImplementation(async () => ({ rawBalance }));
    const requestFunding = vi.fn(async (request) => {
      expect(
        JSON.parse(localStorage.getItem(visitorWalletKey(network))!).funding
          .rawAmount,
      ).toBe(request.rawAmount.toString());
      rawBalance += request.rawAmount;
      return {
        recipient: request.recipient,
        rawAmount: request.rawAmount,
        transactionHash: new Uint8Array(32),
        signedTransaction: new Uint8Array([1]),
      };
    });
    const fundingClient = { ...client, requestFunding };
    await prepareVisitorWallet(network, fundingClient, 10_010_000_000n);
    await prepareVisitorWallet(network, fundingClient, 10_010_000_000n);
    expect(requestFunding).toHaveBeenCalledOnce();
    expect(airdrop).not.toHaveBeenCalled();
    expect(rawBalance).toBe(100_101_000_000n);
  });
  test("saves the key and funding nonce before an airdrop and reuses the funded wallet", async () => {
    const { client, airdrop } = fixture();
    const first = await prepareVisitorWallet(network, client);
    const reloaded = await prepareVisitorWallet(network, client);
    expect(reloaded.address).toBe(first.address);
    expect(airdrop).toHaveBeenCalledOnce();
  });

  test("creates a distinct wallet for a new visitor", async () => {
    const first = await prepareVisitorWallet(network, fixture().client);
    localStorage.clear();
    const second = await prepareVisitorWallet(network, fixture().client);
    expect(second.address).not.toBe(first.address);
  });

  test("does not replace a malformed saved wallet", async () => {
    localStorage.setItem(visitorWalletKey(network), "{}");
    const { client, airdrop } = fixture();
    await expect(prepareVisitorWallet(network, client)).rejects.toThrow(
      /has not been replaced/,
    );
    expect(localStorage.getItem(visitorWalletKey(network))).toBe("{}");
    expect(airdrop).not.toHaveBeenCalled();
  });

  test("does not request funding when the wallet cannot be saved", async () => {
    const { client, airdrop } = fixture();
    const save = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("Storage full");
      });
    try {
      await expect(prepareVisitorWallet(network, client)).rejects.toThrow(
        "Storage full",
      );
      expect(airdrop).not.toHaveBeenCalled();
    } finally {
      save.mockRestore();
    }
  });

  test("checks balance without repeating an ambiguous airdrop after reload", async () => {
    const { client, airdrop, fund } = fixture();
    airdrop.mockRejectedValueOnce(new Error("Connection lost"));
    await expect(prepareVisitorWallet(network, client)).rejects.toThrow(
      "Connection lost",
    );
    const saved = localStorage.getItem(visitorWalletKey(network));
    await expect(prepareVisitorWallet(network, client)).rejects.toThrow(
      /Funding is not confirmed/,
    );
    expect(localStorage.getItem(visitorWalletKey(network))).toBe(saved);
    fund();
    await expect(prepareVisitorWallet(network, client)).resolves.toHaveProperty(
      "address",
    );
    expect(airdrop).toHaveBeenCalledOnce();
  });

  test("persists a pending hash before observation and recovers without a second airdrop", async () => {
    const { client, airdrop, receipt, fund } = fixture();
    airdrop.mockResolvedValueOnce({
      attemptStatus: "pending",
      transactionHash: new Uint8Array(32),
    } as Awaited<ReturnType<typeof airdrop>>);
    receipt.mockImplementationOnce(async () => {
      expect(
        JSON.parse(localStorage.getItem(visitorWalletKey(network))!).funding
          .hash,
      ).toBe("11111111111111111111111111111111");
      throw new Error("Observation timed out");
    });
    await expect(prepareVisitorWallet(network, client)).rejects.toThrow(
      "Observation timed out",
    );
    receipt.mockImplementationOnce(async () => {
      fund();
      return { execution: { result: "return" } };
    });
    await expect(prepareVisitorWallet(network, client)).resolves.toHaveProperty(
      "address",
    );
    expect(airdrop).toHaveBeenCalledOnce();
    expect(receipt).toHaveBeenCalledTimes(2);
  });
});
