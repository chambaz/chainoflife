// @vitest-environment node
import { expect, test, vi } from "vitest";
import {
  toBase58,
  type RpcClient,
  type ThruputClient,
} from "@thruputchain/client";
import {
  fundSetupAccount,
  type FundingRecord,
} from "../../scripts/setup-funding";

const recipient = new Uint8Array(32).fill(1);
const faucet = new Uint8Array(32).fill(2);
const hash = new Uint8Array(32).fill(3);
const address = toBase58(recipient);

function fixture() {
  const records: Record<string, FundingRecord> = {};
  const saved: (typeof records)[] = [];
  const save = vi.fn(async () => {
    saved.push(structuredClone(records));
  });
  const getBalance = vi
    .fn<ThruputClient["getBalance"]>()
    .mockResolvedValue({ rawBalance: 0n } as never);
  const waitForTransactionReceipt = vi
    .fn<ThruputClient["waitForTransactionReceipt"]>()
    .mockResolvedValue({ execution: { result: "return" } } as never);
  const dev_fundAccount = vi
    .fn<RpcClient["dev_fundAccount"]>()
    .mockImplementation(async () => {
      expect(saved[0]?.[address]).toMatchObject({
        hash: null,
        complete: false,
      });
      return {
        transactionHash: hash,
        signedTransaction: new Uint8Array([1, 2, 3]),
      } as never;
    });
  return {
    recipient,
    faucet,
    records,
    saved,
    save,
    client: { getBalance, waitForTransactionReceipt },
    rpc: { dev_fundAccount },
  };
}

test("saves the funding request before sending and records evidence before observation", async () => {
  const params = fixture();
  params.client.waitForTransactionReceipt.mockImplementation(async () => {
    expect(params.saved.at(-1)?.[address]).toMatchObject({
      hash: toBase58(hash),
      signedTransaction: "0x010203",
      complete: false,
    });
    return { execution: { result: "return" } } as never;
  });
  await fundSetupAccount(params);
  expect(params.records[address]?.complete).toBe(true);
  expect(params.rpc.dev_fundAccount).toHaveBeenCalledWith(
    expect.objectContaining({
      recipient,
      faucet,
      rawAmount: 100_000_000_000n,
    }),
  );
  await fundSetupAccount(params);
  expect(params.rpc.dev_fundAccount).toHaveBeenCalledOnce();
  expect(params.client.waitForTransactionReceipt).toHaveBeenCalledOnce();
});

test("an explicit resume reuses the exact nonce and amount after a lost faucet response", async () => {
  const params = fixture();
  params.rpc.dev_fundAccount.mockRejectedValueOnce(new Error("Disconnected"));
  await expect(fundSetupAccount(params)).rejects.toThrow("Disconnected");
  const first = params.rpc.dev_fundAccount.mock.calls[0]![0];
  const resumed = { ...params, records: structuredClone(params.saved[0]!) };
  await fundSetupAccount(resumed);
  expect(params.rpc.dev_fundAccount.mock.calls[1]![0]).toEqual(first);
});

test("a saved hash is only observed after a receipt timeout", async () => {
  const params = fixture();
  params.client.waitForTransactionReceipt.mockRejectedValueOnce(
    new Error("Timed out"),
  );
  await expect(fundSetupAccount(params)).rejects.toThrow("Timed out");
  expect(params.records[address]?.complete).toBe(false);
  await fundSetupAccount(params);
  expect(params.rpc.dev_fundAccount).toHaveBeenCalledOnce();
  expect(params.client.waitForTransactionReceipt).toHaveBeenLastCalledWith(
    hash,
    { timeoutMs: 120_000 },
  );
});

test("does not call the faucet when the funding intent cannot be saved", async () => {
  const params = fixture();
  params.save.mockRejectedValueOnce(new Error("Disk full"));
  await expect(fundSetupAccount(params)).rejects.toThrow("Disk full");
  expect(params.rpc.dev_fundAccount).not.toHaveBeenCalled();
});

test("does not replace a failed funding transaction with another grant", async () => {
  const params = fixture();
  params.client.waitForTransactionReceipt.mockResolvedValue({
    execution: { result: "exception" },
  } as never);
  await expect(fundSetupAccount(params)).rejects.toThrow("Funding failed");
  await expect(fundSetupAccount(params)).rejects.toThrow("Funding failed");
  expect(params.rpc.dev_fundAccount).toHaveBeenCalledOnce();
  expect(params.records[address]?.complete).toBe(false);
});

test("preserves already funded accounts without requesting another grant", async () => {
  const params = fixture();
  params.client.getBalance.mockResolvedValue({
    rawBalance: 100_000_000_000n,
  } as never);
  await fundSetupAccount(params);
  expect(params.rpc.dev_fundAccount).not.toHaveBeenCalled();
  expect(params.save).not.toHaveBeenCalled();
});
