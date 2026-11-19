import assert from "node:assert/strict";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { repoPath } from "./paths.mjs";

// Every supported world deploys, resizes, and advances within the
// one-billion-gas transaction cap of Futurenet and a default local node.
const GAS_LIMIT = 1_000_000_000n;
const TARGET_GAS_LIMIT = 999_000_000n;

/** The largest world side the contract accepts. */
export const MAX_WORLD_SIZE = 17_400;

export function deploymentConfig(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  const { values } = parseArgs({
    args,
    options: {
      preset: { type: "string", default: "local" },
      "rpc-url": { type: "string" },
      mode: { type: "string" },
      size: { type: "string" },
      seed: { type: "string", default: "0" },
      output: { type: "string" },
      "state-dir": { type: "string" },
      "runtime-manifest": { type: "string" },
      resume: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  const preset = values.preset;
  assert(
    preset === "local" || preset === "futurenet",
    "Preset must be local or futurenet",
  );
  const mode = values.mode ?? (preset === "local" ? "configurable" : "fixed");
  assert(
    mode === "configurable" || mode === "fixed",
    "Mode must be configurable or fixed",
  );
  // Futurenet runs the largest world. Local nodes default to 10,000, whose
  // 12.5 MB advance fits a node's default 16 MiB transaction output.
  const size = Number(
    values.size ?? (preset === "futurenet" ? MAX_WORLD_SIZE : 10_000),
  );
  assert(
    Number.isInteger(size) &&
      size >= 100 &&
      size <= MAX_WORLD_SIZE &&
      size % 100 === 0,
    `Size must be a multiple of 100 between 100 and ${MAX_WORLD_SIZE}`,
  );
  assert(/^\d+$/.test(values.seed), "Seed must be an unsigned decimal integer");
  const seed = BigInt(values.seed);
  assert(seed <= 0xffff_ffff_ffff_ffffn, "Seed exceeds u64");
  const rpcUrl =
    values["rpc-url"] ??
    env.THRUPUT_RPC_URL ??
    (preset === "local"
      ? "http://127.0.0.1:9545"
      : "https://rpc.thruput.network");
  const url = new URL(rpcUrl);
  assert(
    ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.hash,
    "RPC URL must be credential-free HTTP(S)",
  );
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  const manifest =
    values["runtime-manifest"] ??
    env.THRUPUT_RUNTIME_MANIFEST ??
    (loopback ? repoPath("data/runtime/runtime-manifest.json") : undefined);
  const stateDir = resolve(
    values["state-dir"] ??
      env.CHAIN_OF_LIFE_LOCAL_DIR ??
      repoPath(".local/deployments", preset),
  );
  return {
    preset,
    mode,
    size,
    seed: seed.toString(),
    rpcUrl,
    stateDir,
    output: resolve(
      values.output ??
        repoPath(preset === "local" ? ".env.local" : ".env.futurenet"),
    ),
    manifest: manifest ? resolve(manifest) : null,
    journal: resolve(stateDir, "deployment.json"),
    gasLimit: GAS_LIMIT,
    targetGasLimit: TARGET_GAS_LIMIT,
    resume: values.resume,
    help: values.help,
  };
}
