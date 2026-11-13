import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { repoRoot, repoPath } from "./paths.mjs";
import { configurationEnvironment } from "./configuration.mjs";

const { values } = parseArgs({
  options: { config: { type: "string", default: ".env.local" } },
});
const env = configurationEnvironment(repoPath(values.config));
const child = spawn(repoPath("node_modules/.bin/vite"), ["build"], {
  cwd: repoRoot,
  stdio: "inherit",
  env,
});
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
