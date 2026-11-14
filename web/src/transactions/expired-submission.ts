import {
  bytesEqual,
  deserializeSignedTransaction,
  fromHex0x,
  hashSignedTransaction,
  toHex0x,
  type CoreThruputClient,
} from "@thruputchain/client";

/** Signed transaction bytes, saved before broadcast. */
export function submissionEvidenceKey(networkId: string, hash: string): string {
  return `chain-of-life:submission:v1:${networkId}:${hash}`;
}

// An unknown status alone cannot establish failure. Require the signed expiry
// and complete indexed root history through that height before releasing a write.
// The caller must first confirm that the client is on the expected network.
export async function isExpiredUncommitted(
  client: CoreThruputClient,
  networkId: string,
  hash: string,
  signal: AbortSignal,
): Promise<boolean> {
  const raw = localStorage.getItem(submissionEvidenceKey(networkId, hash));
  if (raw === null) return false;
  const evidence = JSON.parse(raw);
  if (
    evidence.hash !== hash ||
    evidence.networkId !== networkId ||
    typeof evidence.signedTransaction !== "string"
  )
    throw new Error(
      "Saved transaction evidence does not match this submission",
    );
  const signed = deserializeSignedTransaction(
    fromHex0x(evidence.signedTransaction),
  );
  const transactionHash = hashSignedTransaction(signed);
  if (toHex0x(transactionHash) !== hash)
    throw new Error("Saved transaction hash does not match its signed bytes");
  const expiry = signed.tx.uniquifier.block_expiry_height;
  const tip = await client.getChainTip({}, { signal });
  if (tip.blockHeight <= expiry) return false;
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
                anchor: { kind: "atHeight" as const, blockHeight: 0n },
              },
            }),
      },
      { signal },
    );
    if (
      page.oldestIndexedBlockHeight !== 0n ||
      page.latestIndexedBlockHeight <= expiry
    )
      return false;
    if (
      page.transactions.some((entry) =>
        bytesEqual(entry.transactionHash, transactionHash),
      )
    )
      return false;
    if (page.nextCursor === null) return true;
    if (seen.has(page.nextCursor))
      throw new Error("Transaction history repeated a page");
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}
