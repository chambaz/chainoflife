import {
  bytesEqual,
  deserializeSignedTransaction,
  fromHex0x,
  hashSignedTransaction,
  toHex0x,
  type CoreThruputClient,
} from "@thruputchain/client";

/**
 * Blocks from signing to expiry. The SDK sets the expiry to the chain tip it
 * observes before signing plus this number, so only the blocks after that tip
 * and up to the expiry can include the transaction.
 */
export const EXPIRY_BLOCKS = 32n;

/** The exact signed bytes of one write, saved before broadcast. */
export interface SubmissionEvidence {
  readonly transactionHash: string;
  readonly signedTransaction: string;
}

// An unknown status alone cannot establish failure. Require the signed expiry
// and complete indexed root history for every block that could include the
// transaction. The caller must first confirm that the client is on the
// expected network.
export async function isExpiredUncommitted(
  client: CoreThruputClient,
  evidence: SubmissionEvidence,
  signal: AbortSignal,
): Promise<boolean> {
  const signed = deserializeSignedTransaction(
    fromHex0x(evidence.signedTransaction),
  );
  const transactionHash = hashSignedTransaction(signed);
  if (toHex0x(transactionHash) !== evidence.transactionHash)
    throw new Error("Saved transaction hash does not match its signed bytes");
  const expiry = signed.tx.uniquifier.block_expiry_height;
  const tip = await client.getChainTip({}, { signal });
  if (tip.blockHeight <= expiry) return false;
  const earliest = expiry > EXPIRY_BLOCKS ? expiry - EXPIRY_BLOCKS : 0n;
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await client.getTransactionsByRootAddress(
      {
        address: signed.tx.invocation.invoked_address,
        limit: 200,
        ...(cursor
          ? { cursor }
          : {
              start: {
                order: "ascending" as const,
                anchor: { kind: "atHeight" as const, blockHeight: earliest },
              },
            }),
      },
      { signal },
    );
    if (
      page.oldestIndexedBlockHeight > earliest ||
      page.latestIndexedBlockHeight <= expiry
    )
      return false;
    for (const entry of page.transactions) {
      if (bytesEqual(entry.transactionHash, transactionHash)) return false;
      // Pages are ascending, so no later entry can include the transaction.
      if (entry.blockHeight > expiry) return true;
    }
    if (page.nextCursor === null) return true;
    if (seen.has(page.nextCursor))
      throw new Error("Transaction history repeated a page");
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}
