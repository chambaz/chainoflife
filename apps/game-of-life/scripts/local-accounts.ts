import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createPubkeyAccount,
  Ed25519Signer,
  fromHex0x,
  toHex0x,
} from "@thruputchain/client";

export const localRoot = resolve(
  process.env.CHAIN_OF_LIFE_LOCAL_DIR ?? "../../tmp/chain-of-life",
);
export const rpcUrl = process.env.THRUPUT_RPC_URL ?? "http://127.0.0.1:9545";

export async function localAccounts(create = false) {
  await mkdir(localRoot, { recursive: true, mode: 0o700 });
  const path = resolve(localRoot, "accounts.json");
  let seeds: string[];
  try {
    seeds = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT")
      throw error;
    seeds = Array.from({ length: 3 }, () => toHex0x(randomBytes(32)));
    await writeFile(path, JSON.stringify(seeds), { mode: 0o600, flag: "wx" });
  }
  if (
    !Array.isArray(seeds) ||
    seeds.length !== 3 ||
    !seeds.every((s) => /^0x[0-9a-f]{64}$/.test(s))
  )
    throw new Error("Invalid local account file");
  return seeds.map((seed) => {
    const signer = Ed25519Signer.fromSeed(fromHex0x(seed));
    return {
      signer,
      account: createPubkeyAccount({ signer }),
    };
  });
}
