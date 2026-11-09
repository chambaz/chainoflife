import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { localRoot, rpcUrl, writeAllocations } from "./local-accounts";

const url = new URL(rpcUrl);
if (url.hostname !== "127.0.0.1")
  throw new Error("The local node must use 127.0.0.1");
const allocations = await writeAllocations();
const child = spawn(
  process.env.THRUPUT_CLI ?? "thruput",
  [
    "node",
    "--port",
    url.port,
    "--data-dir",
    resolve(localRoot, "atomic-node"),
    "--network-config",
    "max_tx_gas=60000000000",
    "--block-driver",
    "interval",
    "--block-interval-ms",
    "1000",
    "--bootstrap-accounts",
    allocations,
    "--non-interactive",
    "--no-ui",
  ],
  { cwd: resolve("../.."), stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => child.kill(signal));
child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
