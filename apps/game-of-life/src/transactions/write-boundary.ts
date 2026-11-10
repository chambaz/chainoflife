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
import { isExpiredUncommitted } from "./expired-submission";

export type WriteResult =
  | {
      readonly kind: "preSubmissionFailure";
      readonly hash: null;
      readonly message: string;
    }
  | { readonly kind: "invalid"; readonly hash: string; readonly reason: string }
  | {
      readonly kind: "committedSuccess" | "committedFailure";
      readonly hash: string;
      readonly receipt: TransactionReceipt;
    }
  | {
      readonly kind: "indeterminate";
      readonly hash: string | null;
      readonly message?: string;
      readonly reason:
        "recentFailure" | "unknown" | "other" | "timeout" | "disconnect";
    };

export interface WriteBoundary {
  execute(
    target: Invocation,
    policy: TransactionPolicy,
    observer: { readonly onSigned: (hash: string) => void },
  ): Promise<WriteResult>;
  observe(hash: string, timeoutMs?: number): Promise<WriteResult>;
}

export function createWriteBoundary(
  config: Pick<AppConfig, "networkId">,
  visitor: VisitorWallet,
  connection: CoreThruputClient | Promise<CoreThruputClient>,
): WriteBoundary {
  const { account } = visitor;

  function committed(receipt: TransactionReceipt, hash: string): WriteResult {
    if (receipt.execution instanceof UnsupportedRpcValue)
      return { kind: "indeterminate", hash, reason: "other" };
    return {
      kind:
        receipt.execution.result === "return"
          ? "committedSuccess"
          : "committedFailure",
      hash,
      receipt,
    };
  }

  return {
    async execute(invocation, policy, observer) {
      let hash: string | null = null;
      const client = await connection;
      const wallet = createWalletClient({
        client,
        account,
        networkHash: networkHash(
          sha256Hash(fromHex0x(`0x${config.networkId}`)),
        ),
        onSigned(evidence) {
          hash = toHex0x(evidence.transactionHash);
          // Preserve the exact approved bytes before the SDK broadcasts once.
          localStorage.setItem(
            `chain-of-life:submission:${config.networkId}:${hash}`,
            JSON.stringify({
              hash,
              networkId: config.networkId,
              account: visitor.address,
              signedTransaction: toHex0x(evidence.signedTransaction),
            }),
          );
          observer.onSigned(hash);
        },
      });
      try {
        const result = await wallet.executeAndWait(
          {
            invocation,
            gasLimit: gasAmount(policy.transactionGasLimit),
            expiryBlocks: policy.expiryBlocks,
          },
          { timeoutMs: policy.observationTimeoutMs },
        );
        return committed(result.receipt, toHex0x(result.transactionHash));
      } catch (error) {
        if (error instanceof TransactionExecutionError)
          return committed(error.receipt, hash!);
        if (
          error instanceof TransactionObservationError &&
          error.phase !== "beforeSubmission"
        )
          return {
            kind: "indeterminate",
            hash: toHex0x(error.transactionHash),
            reason: "unknown",
            message: [error.message, error.submissionCause, error.cause]
              .map((part) =>
                part instanceof Error
                  ? part.message
                  : typeof part === "string"
                    ? part
                    : null,
              )
              .filter(Boolean)
              .join(" · "),
          };
        if (hash !== null)
          return {
            kind: "indeterminate",
            hash,
            reason: "other",
            message:
              error instanceof Error
                ? error.message
                : "Submission failed after signing",
          };
        return {
          kind: "preSubmissionFailure",
          hash: null,
          message:
            error instanceof Error
              ? error.message
              : "Transaction preparation failed",
        };
      }
    },
    async observe(hash, timeoutMs = 30_000) {
      try {
        const client = await connection;
        const signal = AbortSignal.timeout(Math.min(timeoutMs, 10_000));
        const transactionHash = hashFromHex(hash);
        const network = await client.getNetworkInfo({}, { signal });
        if (toHex0x(network.networkHash) !== `0x${config.networkId}`)
          throw new Error("The observation endpoint is on a different network");
        const receipt = await client.getTransactionReceipt(
          { transactionHash },
          { signal },
        );
        if (receipt) return committed(receipt, hash);
        const status = await client.getTransactionStatus(
          { transactionHash },
          { signal },
        );
        if (
          !(status instanceof UnsupportedRpcValue) &&
          status.status !== "committed" &&
          (await isExpiredUncommitted(client, config.networkId, hash, signal))
        )
          return {
            kind: "invalid",
            hash,
            reason:
              "The signed transaction expired without committing. You can submit a new resize.",
          };
        return {
          kind: "indeterminate",
          hash,
          reason: "unknown",
          message:
            status instanceof UnsupportedRpcValue
              ? "The node returned an unsupported transaction status. Keep the saved transaction."
              : `Node status: ${status.status}. No receipt is available. Observe again to check the original transaction.`,
        };
      } catch (error) {
        return {
          kind: "indeterminate",
          hash,
          reason: "unknown",
          message:
            error instanceof Error
              ? error.message
              : "Transaction observation failed",
        };
      }
    },
  };
}
