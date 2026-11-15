import {
  fromHex0x,
  hashSignedTransaction,
  prepareTransaction,
  serializeSignedTransaction,
  signTransaction,
  toHex0x,
  type CoreThruputClient,
} from "@thruputchain/client";
import { gasAmount, networkHash, sha256Hash } from "@thruputchain/protocol";
import { expect, test, vi } from "vitest";
import { GameOfLife } from "@/contracts/game-of-life";
import { walletFromSeed } from "@/wallet/visitor-wallet";
import { EXPIRY_BLOCKS, isExpiredUncommitted } from "./expired-submission";
import { createWriteBoundary } from "./write-boundary";

const networkId = "00".repeat(32);
const wallet = walletFromSeed(`0x${"01".repeat(32)}`);

async function fixture() {
  const network = networkHash(sha256Hash(fromHex0x(`0x${networkId}`)));
  const getChainTip = vi.fn().mockResolvedValue({ blockHeight: 100n });
  const tx = await prepareTransaction({ getChainTip }, wallet.account, {
    invocation: GameOfLife.v0_1.resize.invocation(
      wallet.account.address,
      gasAmount(100n),
      { size: 7400n },
    ),
    expiryBlocks: EXPIRY_BLOCKS,
  });
  const signed = await signTransaction(tx, wallet.account.signers, network);
  const transactionHash = hashSignedTransaction(signed);
  const hash = toHex0x(transactionHash);
  // Signed at tip 100, so only blocks 100 to 132 can include it.
  const evidence = {
    transactionHash: hash,
    signedTransaction: toHex0x(serializeSignedTransaction(signed)),
  };
  getChainTip.mockResolvedValue({ blockHeight: 200n });
  const page = {
    oldestIndexedBlockHeight: 0n,
    latestIndexedBlockHeight: 200n,
    transactions: [],
    nextCursor: null,
  };
  const client = {
    getNetworkInfo: vi.fn().mockResolvedValue({ networkHash: network }),
    getChainTip,
    getTransactionsByRootAddress: vi.fn().mockResolvedValue(page),
    getTransactionReceipt: vi.fn().mockResolvedValue(null),
    getTransactionStatus: vi.fn().mockResolvedValue({ status: "unknown" }),
  };
  const connection = client as unknown as CoreThruputClient;
  return {
    client,
    connection,
    page,
    hash,
    evidence,
    transactionHash,
    boundary: createWriteBoundary({ networkId }, wallet, connection),
  };
}

test("releases an unknown expired submission after complete history from signing", async () => {
  const { boundary, client, hash, evidence } = await fixture();
  await expect(boundary.observe(evidence)).resolves.toMatchObject({
    kind: "invalid",
    hash,
    message: expect.stringMatching(/expired/),
  });
  expect(client.getTransactionsByRootAddress).toHaveBeenCalledWith(
    expect.objectContaining({
      start: {
        order: "ascending",
        anchor: { kind: "atHeight", blockHeight: 100n },
      },
    }),
    expect.anything(),
  );
});

test.each(["retry", "dropped"])(
  "treats a %s status as not committed without waiting for expiry",
  async (status) => {
    const { boundary, client, hash, evidence } = await fixture();
    client.getTransactionStatus.mockResolvedValue({
      status,
      error: { source: "executor", code: 3 },
    });
    await expect(boundary.observe(evidence)).resolves.toMatchObject({
      kind: "invalid",
      hash,
      message: expect.stringMatching(/Another visitor/),
    });
    expect(client.getTransactionsByRootAddress).not.toHaveBeenCalled();
  },
);

test("needs indexed history only from the signing height", async () => {
  const { boundary, client, page, evidence } = await fixture();
  client.getTransactionsByRootAddress.mockResolvedValue({
    ...page,
    oldestIndexedBlockHeight: 100n,
  });
  await expect(boundary.observe(evidence)).resolves.toMatchObject({
    kind: "invalid",
  });
});

test.each([
  { oldestIndexedBlockHeight: 101n, latestIndexedBlockHeight: 200n },
  { oldestIndexedBlockHeight: 0n, latestIndexedBlockHeight: 132n },
])(
  "keeps an expired submission blocked when history is incomplete: %#",
  async (coverage) => {
    const { boundary, client, page, evidence } = await fixture();
    client.getTransactionsByRootAddress.mockResolvedValue({
      ...page,
      ...coverage,
    });
    await expect(boundary.observe(evidence)).resolves.toMatchObject({
      kind: "indeterminate",
    });
  },
);

test("checks every page and keeps a committed transaction blocked until its receipt is available", async () => {
  const { boundary, client, page, evidence, transactionHash } = await fixture();
  client.getTransactionsByRootAddress
    .mockResolvedValueOnce({ ...page, nextCursor: "next" })
    .mockResolvedValueOnce({
      ...page,
      transactions: [{ transactionHash, blockHeight: 120n }],
    });
  await expect(boundary.observe(evidence)).resolves.toMatchObject({
    kind: "indeterminate",
  });
  expect(client.getTransactionsByRootAddress).toHaveBeenCalledTimes(2);
});

test("stops reading history after the expiry height", async () => {
  const { connection, client, page, evidence } = await fixture();
  client.getTransactionsByRootAddress.mockResolvedValue({
    ...page,
    transactions: [
      { transactionHash: new Uint8Array(32), blockHeight: 120n },
      { transactionHash: new Uint8Array(32), blockHeight: 133n },
    ],
    nextCursor: "later",
  });
  await expect(
    isExpiredUncommitted(connection, evidence, AbortSignal.timeout(1000)),
  ).resolves.toBe(true);
  expect(client.getTransactionsByRootAddress).toHaveBeenCalledOnce();
});

test("does not release a transaction before or at expiry", async () => {
  const { connection, client, evidence } = await fixture();
  client.getChainTip.mockResolvedValue({ blockHeight: 132n });
  await expect(
    isExpiredUncommitted(connection, evidence, AbortSignal.timeout(1000)),
  ).resolves.toBe(false);
  expect(client.getTransactionsByRootAddress).not.toHaveBeenCalled();
});

test("committed receipt takes precedence over expiry", async () => {
  const { boundary, client, hash, evidence } = await fixture();
  client.getTransactionReceipt.mockResolvedValue({
    execution: { result: "return" },
  });
  await expect(boundary.observe(evidence)).resolves.toMatchObject({
    kind: "committedSuccess",
  });
  expect(client.getTransactionsByRootAddress).not.toHaveBeenCalled();
});

test("a committed status without a receipt cannot be released", async () => {
  const { boundary, client, hash, evidence } = await fixture();
  client.getTransactionStatus.mockResolvedValue({
    status: "committed",
    blockHeight: 150n,
  });
  await expect(boundary.observe(evidence)).resolves.toMatchObject({
    kind: "indeterminate",
  });
  expect(client.getTransactionsByRootAddress).not.toHaveBeenCalled();
});

test("rejects a different network before interpreting a receipt", async () => {
  const { boundary, client, hash, evidence } = await fixture();
  client.getNetworkInfo.mockResolvedValue({
    networkHash: fromHex0x(`0x${"11".repeat(32)}`),
  });
  await expect(boundary.observe(evidence)).resolves.toMatchObject({
    kind: "indeterminate",
    message: expect.stringMatching(/different network/),
  });
  expect(client.getTransactionReceipt).not.toHaveBeenCalled();
});

test("rejects mismatched signed evidence and repeated history pages", async () => {
  const { boundary, client, evidence, page } = await fixture();
  client.getTransactionsByRootAddress.mockResolvedValue({
    ...page,
    nextCursor: "loop",
  });
  await expect(boundary.observe(evidence)).resolves.toMatchObject({
    kind: "indeterminate",
    message: expect.stringMatching(/repeated a page/),
  });
  await expect(
    boundary.observe({
      ...evidence,
      transactionHash: `0x${"55".repeat(32)}`,
    }),
  ).resolves.toMatchObject({
    kind: "indeterminate",
    message: expect.stringMatching(/does not match/),
  });
});
