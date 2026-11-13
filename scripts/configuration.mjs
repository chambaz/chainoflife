import { lstatSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { resolve } from "node:path";

/** @param {string} file */
export function readConfiguration(file) {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error(`${file} must be a regular, non-symlinked file`);
  return parseEnv(readFileSync(file, "utf8"));
}

/**
 * @param {string} file
 * @param {NodeJS.ProcessEnv} inherited
 * @returns {NodeJS.ProcessEnv}
 */
export function configurationEnvironment(file, inherited = process.env) {
  const environment = { ...inherited };
  for (const key of Object.keys(environment))
    if (key.startsWith("VITE_")) delete environment[key];
  return {
    ...environment,
    ...readConfiguration(file),
    GAME_OF_LIFE_CONFIG: resolve(file),
  };
}
