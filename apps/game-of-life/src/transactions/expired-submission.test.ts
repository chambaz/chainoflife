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
import { isExpiredUncommitted } from "./expired-submission";
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
    expiryBlocks: 64n,
  });
  const signed = await signTransaction(tx, wallet.account.signers, network);
  const transactionHash = hashSignedTransaction(signed);
  const hash = toHex0x(transactionHash);
  const key = `chain-of-life:submission:${networkId}:${hash}`;
  localStorage.setItem(
    key,
    JSON.stringify({
      hash,
      networkId,
      signedTransaction: toHex0x(serializeSignedTransaction(signed)),
    }),
  );
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
    key,
    transactionHash,
    boundary: createWriteBoundary({ networkId }, wallet, connection),
  };
}

test("releases an unknown expired submission only after complete indexed history", async () => {
  const { boundary, client, hash } = await fixture();
  await expect(boundary.observe(hash, 300_000)).resolves.toMatchObject({
    kind: "invalid",
    hash,
    reason: expect.stringMatching(/expired without committing/),
  });
  expect(client.getTransactionsByRootAddress).toHaveBeenCalledWith(
    expect.objectContaining({
      start: {
        order: "ascending",
        anchor: { kind: "atHeight", blockHeight: 0n },
      },
    }),
    expect.anything(),
  );
});

test.each([
  { oldestIndexedBlockHeight: 1n, latestIndexedBlockHeight: 200n },
  { oldestIndexedBlockHeight: 0n, latestIndexedBlockHeight: 164n },
])(
  "keeps an expired submission blocked when history is incomplete: %#",
  async (coverage) => {
    const { boundary, client, page, hash } = await fixture();
    client.getTransactionsByRootAddress.mockResolvedValue({
      ...page,
      ...coverage,
    });
    await expect(boundary.observe(hash)).resolves.toMatchObject({
      kind: "indeterminate",
    });
  },
);

test("checks every page and keeps a committed transaction blocked until its receipt is available", async () => {
  const { boundary, client, page, hash, transactionHash } = await fixture();
  client.getTransactionsByRootAddress
    .mockResolvedValueOnce({ ...page, nextCursor: "next" })
    .mockResolvedValueOnce({
      ...page,
      transactions: [{ transactionHash, blockHeight: 160n }],
    });
  await expect(boundary.observe(hash)).resolves.toMatchObject({
    kind: "indeterminate",
  });
  expect(client.getTransactionsByRootAddress).toHaveBeenCalledTimes(2);
});

test("does not release a transaction before or at expiry", async () => {
  const { connection, client, hash } = await fixture();
  client.getChainTip.mockResolvedValue({ blockHeight: 164n });
  await expect(
    isExpiredUncommitted(
      connection,
      networkId,
      hash,
      AbortSignal.timeout(1000),
    ),
  ).resolves.toBe(false);
  expect(client.getTransactionsByRootAddress).not.toHaveBeenCalled();
});

test("committed receipt takes precedence over expiry", async () => {
  const { boundary, client, hash } = await fixture();
  client.getTransactionReceipt.mockResolvedValue({
    execution: { result: "return" },
  });
  await expect(boundary.observe(hash)).resolves.toMatchObject({
    kind: "committedSuccess",
  });
  expect(client.getTransactionsByRootAddress).not.toHaveBeenCalled();
});

test("a committed status without a receipt cannot be released", async () => {
  const { boundary, client, hash } = await fixture();
  client.getTransactionStatus.mockResolvedValue({
    status: "committed",
    blockHeight: 150n,
  });
  await expect(boundary.observe(hash)).resolves.toMatchObject({
    kind: "indeterminate",
  });
  expect(client.getTransactionsByRootAddress).not.toHaveBeenCalled();
});

test("missing evidence returns a prompt unknown result without clearing the write", async () => {
  const { boundary, hash, key } = await fixture();
  localStorage.removeItem(key);
  await expect(boundary.observe(hash, 300_000)).resolves.toMatchObject({
    kind: "indeterminate",
    message: expect.stringMatching(/Node status: unknown/),
  });
});

test("rejects a different network before interpreting a receipt", async () => {
  const { boundary, client, hash } = await fixture();
  client.getNetworkInfo.mockResolvedValue({
    networkHash: fromHex0x(`0x${"11".repeat(32)}`),
  });
  await expect(boundary.observe(hash)).resolves.toMatchObject({
    kind: "indeterminate",
    message: expect.stringMatching(/different network/),
  });
  expect(client.getTransactionReceipt).not.toHaveBeenCalled();
});

test("rejects mismatched signed evidence and repeated history pages", async () => {
  const { boundary, client, hash, key, page } = await fixture();
  client.getTransactionsByRootAddress.mockResolvedValue({
    ...page,
    nextCursor: "loop",
  });
  await expect(boundary.observe(hash)).resolves.toMatchObject({
    kind: "indeterminate",
    message: expect.stringMatching(/repeated a page/),
  });
  localStorage.setItem(
    key,
    JSON.stringify({ hash: "wrong", networkId, signedTransaction: "0x00" }),
  );
  await expect(boundary.observe(hash)).resolves.toMatchObject({
    kind: "indeterminate",
    message: expect.stringMatching(/does not match/),
  });
});
