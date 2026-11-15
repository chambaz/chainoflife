import {
  createWalletClient,
  fromHex0x,
  hashFromHex,
  toHex0x,
  TransactionExecutionError,
  TransactionObservationError,
  UnsupportedRpcValue,
  type CoreThruputClient,
  type TransactionReceipt,
} from "@thruputchain/client";
import {
  gasAmount,
  networkHash,
  sha256Hash,
  type Invocation,
} from "@thruputchain/protocol";
import type { AppConfig, TransactionPolicy } from "@/config";
import type { VisitorWallet } from "@/wallet/visitor-wallet";
import {
  EXPIRY_BLOCKS,
  isExpiredUncommitted,
  type SubmissionEvidence,
} from "./expired-submission";

export type WriteResult =
  | { readonly kind: "preSubmissionFailure"; readonly message: string }
  | {
      readonly kind: "invalid";
      readonly hash: string;
      readonly message: string;
    }
  | {
      readonly kind: "committedSuccess";
      readonly hash: string;
      readonly receipt: TransactionReceipt;
    }
  | { readonly kind: "committedFailure"; readonly hash: string }
  | {
      readonly kind: "indeterminate";
      readonly evidence: SubmissionEvidence;
      readonly message: string;
    };

// Each observation is one quick check; pending writes are checked again later.
const OBSERVATION_TIMEOUT_MS = 10_000;
// Wait briefly for a receipt. A pending write is then observed by its hash.
// A write that loses the exclusive world lock to another visitor reports
// "retry" for about half a minute, so observation must start within that time.
const EXECUTION_TIMEOUT_MS = 20_000;
const NOT_COMMITTED =
  "The network did not commit this transaction. Another visitor may have changed the world first. You can try again.";

export interface WriteBoundary {
  execute(
    target: Invocation,
    policy: TransactionPolicy,
    observer: {
      /** Called before broadcast; the caller must save the evidence. */
      readonly onSigned: (evidence: SubmissionEvidence) => void;
    },
  ): Promise<WriteResult>;
  observe(evidence: SubmissionEvidence): Promise<WriteResult>;
}

export function createWriteBoundary(
  config: Pick<AppConfig, "networkId">,
  visitor: VisitorWallet,
  connection: CoreThruputClient | Promise<CoreThruputClient>,
): WriteBoundary {
  const { account } = visitor;

  function committed(
    receipt: TransactionReceipt,
    evidence: SubmissionEvidence,
  ): WriteResult {
    const hash = evidence.transactionHash;
    if (receipt.execution instanceof UnsupportedRpcValue)
      return {
        kind: "indeterminate",
        evidence,
        message:
          "The node returned an unsupported receipt. Check the transaction again.",
      };
    return receipt.execution.result === "return"
      ? { kind: "committedSuccess", hash, receipt }
      : { kind: "committedFailure", hash };
  }

  return {
    async execute(invocation, policy, observer) {
      let evidence: SubmissionEvidence | null = null;
      try {
        const client = await connection;
        const wallet = createWalletClient({
          client,
          account,
          networkHash: networkHash(
            sha256Hash(fromHex0x(`0x${config.networkId}`)),
          ),
          // The SDK awaits this callback, and broadcasts once only if it
          // returns. A failed save therefore leaves nothing broadcast.
          onSigned(signed) {
            const saved = {
              transactionHash: toHex0x(signed.transactionHash),
              signedTransaction: toHex0x(signed.signedTransaction),
            };
            observer.onSigned(saved);
            evidence = saved;
          },
        });
        const result = await wallet.executeAndWait(
          {
            invocation,
            gasLimit: gasAmount(policy.transactionGasLimit),
            expiryBlocks: EXPIRY_BLOCKS,
          },
          { timeoutMs: EXECUTION_TIMEOUT_MS },
        );
        // A receipt exists only for a broadcast transaction, which was signed.
        return committed(result.receipt, evidence!);
      } catch (error) {
        if (error instanceof TransactionExecutionError && evidence !== null)
          return committed(error.receipt, evidence);
        if (evidence === null)
          return {
            kind: "preSubmissionFailure",
            message:
              error instanceof Error
                ? error.message
                : "Transaction preparation failed",
          };
        return { kind: "indeterminate", evidence, message: describe(error) };
      }
    },
    async observe(evidence) {
      const hash = evidence.transactionHash;
      try {
        const client = await connection;
        const signal = AbortSignal.timeout(OBSERVATION_TIMEOUT_MS);
        const transactionHash = hashFromHex(hash);
        const network = await client.getNetworkInfo({}, { signal });
        if (toHex0x(network.networkHash) !== `0x${config.networkId}`)
          throw new Error("The observation endpoint is on a different network");
        const receipt = await client.getTransactionReceipt(
          { transactionHash },
          { signal },
        );
        if (receipt) return committed(receipt, evidence);
        const status = await client.getTransactionStatus(
          { transactionHash },
          { signal },
        );
        // The mempool never retries "retry" on its own, and this app never
        // broadcasts again, so neither outcome can commit.
        if (
          !(status instanceof UnsupportedRpcValue) &&
          (status.status === "retry" || status.status === "dropped")
        )
          return { kind: "invalid", hash, message: NOT_COMMITTED };
        if (
          !(status instanceof UnsupportedRpcValue) &&
          status.status !== "committed" &&
          (await isExpiredUncommitted(client, evidence, signal))
        )
          return {
            kind: "invalid",
            hash,
            message: `The transaction expired. ${NOT_COMMITTED}`,
          };
        return {
          kind: "indeterminate",
          evidence,
          message:
            status instanceof UnsupportedRpcValue
              ? "The node returned an unsupported transaction status. Keep the saved transaction."
              : `Node status: ${status.status}. No receipt is available. Observe again to check the original transaction.`,
        };
      } catch (error) {
        return {
          kind: "indeterminate",
          evidence,
          message:
            error instanceof Error
              ? error.message
              : "Transaction observation failed",
        };
      }
    },
  };
}

function describe(error: unknown): string {
  const parts =
    error instanceof TransactionObservationError
      ? [error.message, error.submissionCause, error.cause]
      : [error];
  return (
    parts
      .map((part) =>
        part instanceof Error
          ? part.message
          : typeof part === "string"
            ? part
            : null,
      )
      .filter(Boolean)
      .join(" · ") || "Submission failed after signing"
  );
}
