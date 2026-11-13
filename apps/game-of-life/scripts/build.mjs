import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { config: { type: "string" } } });
const env = { ...process.env };
if (values.config) env.GAME_OF_LIFE_CONFIG = resolve(values.config);
const child = spawn("node_modules/.bin/vite", ["build"], {
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
