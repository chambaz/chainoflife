import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createPubkeyAccount,
  Ed25519Signer,
  fromHex0x,
  toHex0x,
} from "@thruputchain/client";

/**
 * Loads `count` private accounts from a JSON file of hex seeds. With
 * `create`, a missing file is created with new random seeds; an existing file
 * is never replaced.
 */
export async function loadAccounts(
  path: string,
  count: number,
  create = false,
) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let seeds: unknown;
  try {
    seeds = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT")
      throw error;
    seeds = Array.from({ length: count }, () => toHex0x(randomBytes(32)));
    await writeFile(path, JSON.stringify(seeds), { mode: 0o600, flag: "wx" });
  }
  if (
    !Array.isArray(seeds) ||
    seeds.length !== count ||
    !seeds.every((seed) => /^0x[0-9a-f]{64}$/.test(seed))
  )
    throw new Error(`Invalid account file: ${path}`);
  return seeds.map((seed: string) => {
    const signer = Ed25519Signer.fromSeed(fromHex0x(seed));
    return { signer, account: createPubkeyAccount({ signer }) };
  });
}
