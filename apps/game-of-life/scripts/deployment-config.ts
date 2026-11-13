import assert from "node:assert/strict";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

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
  assert(
    ["local", "futurenet", "devnet"].includes(values.preset),
    "Preset must be local or futurenet (devnet is an alias)",
  );
  const preset = values.preset === "devnet" ? "futurenet" : values.preset;
  const mode = values.mode ?? (preset === "local" ? "configurable" : "fixed");
  assert(
    mode === "configurable" || mode === "fixed",
    "Mode must be configurable or fixed",
  );
  const size = Number(values.size ?? (preset === "local" ? "10000" : "2900"));
  assert(
    Number.isInteger(size) && size >= 100 && size <= 10_000 && size % 100 === 0,
    "Size must be a multiple of 100 between 100 and 10000",
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
    (loopback ? "../../data/runtime/runtime-manifest.json" : undefined);
  const stateDir = resolve(
    values["state-dir"] ??
      env.CHAIN_OF_LIFE_LOCAL_DIR ??
      `../../tmp/chain-of-life${preset === "local" ? "" : `-${preset}`}`,
  );
  const fullBudget = mode === "configurable" || size > 3000;
  return {
    preset,
    mode,
    size,
    seed: seed.toString(),
    rpcUrl,
    stateDir,
    output: resolve(
      values.output ?? (preset === "local" ? ".env.local" : ".env.futurenet"),
    ),
    manifest: manifest ? resolve(manifest) : null,
    journal: resolve(
      stateDir,
      env.GAME_OF_LIFE_DEPLOYMENT_JOURNAL ?? "deployment.json",
    ),
    deploymentGas: fullBudget ? 60_000_000_000n : 950_000_000n,
    deploymentTargetGas: fullBudget ? 59_000_000_000n : 945_000_000n,
    crankGas: fullBudget ? 10_010_000_000n : 950_000_000n,
    crankTargetGas: fullBudget ? 10_000_000_000n : 945_000_000n,
    resume: values.resume,
    help: values.help,
  };
}
