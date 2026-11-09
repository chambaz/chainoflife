import {
  addressFromHex,
  fromHex0x,
  Ed25519Signer,
  toHex0x,
} from "@thruputchain/client";
import { type ContractAddress } from "@thruputchain/protocol";

const PERSONA_IDS = ["alice", "bob", "carol"] as const;
const HEX32 = /^0x[0-9a-f]{64}$/;

export type DevelopmentPersonaId = (typeof PERSONA_IDS)[number];

export interface DevelopmentPersona {
  readonly id: DevelopmentPersonaId;
  readonly label: string;
  readonly privateKeyHex: string;
  readonly signerPublicKeyHex: string;
  readonly walletRoot: ContractAddress;
  readonly walletRootHex: string;
  readonly expectedCaller: ContractAddress;
  readonly expectedCallerHex: string;
}

export type PublicDevelopmentPersona = Omit<
  DevelopmentPersona,
  "privateKeyHex" | "signerPublicKeyHex"
>;

export class DevelopmentPersonaError extends Error {
  constructor() {
    super("Development wallet configuration is invalid");
    this.name = "DevelopmentPersonaError";
  }
}

export function parseDevelopmentPersonas(
  serialized: string | undefined,
): readonly DevelopmentPersona[] | null {
  if (!serialized?.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new DevelopmentPersonaError();
  }
  if (!Array.isArray(parsed) || parsed.length !== PERSONA_IDS.length)
    throw new DevelopmentPersonaError();
  const ids = new Set<string>();
  const roots = new Set<string>();
  const keys = new Set<string>();
  const personas = parsed.map((value): DevelopmentPersona => {
    if (!isRecord(value)) throw new DevelopmentPersonaError();
    const {
      id,
      label,
      privateKey,
      signerPublicKey,
      walletRoot,
      expectedCaller,
      callerVerified,
    } = value;
    if (
      typeof id !== "string" ||
      !PERSONA_IDS.includes(id as DevelopmentPersonaId) ||
      typeof label !== "string" ||
      label.trim() === "" ||
      typeof privateKey !== "string" ||
      !HEX32.test(privateKey) ||
      typeof signerPublicKey !== "string" ||
      !HEX32.test(signerPublicKey) ||
      typeof walletRoot !== "string" ||
      !HEX32.test(walletRoot) ||
      typeof expectedCaller !== "string" ||
      !HEX32.test(expectedCaller) ||
      walletRoot !== expectedCaller ||
      callerVerified !== true ||
      ids.has(id) ||
      roots.has(walletRoot) ||
      keys.has(privateKey)
    )
      throw new DevelopmentPersonaError();
    const signer = Ed25519Signer.fromSeed(fromHex0x(privateKey));
    if (toHex0x(signer.publicKey.ed25519) !== signerPublicKey)
      throw new DevelopmentPersonaError();
    ids.add(id);
    roots.add(walletRoot);
    keys.add(privateKey);
    return Object.freeze({
      id: id as DevelopmentPersonaId,
      label: label.trim(),
      privateKeyHex: privateKey,
      signerPublicKeyHex: signerPublicKey,
      walletRoot: addressFromHex(walletRoot),
      walletRootHex: walletRoot,
      expectedCaller: addressFromHex(expectedCaller),
      expectedCallerHex: expectedCaller,
    });
  });
  if (PERSONA_IDS.some((id) => !ids.has(id)))
    throw new DevelopmentPersonaError();
  return Object.freeze(
    PERSONA_IDS.map((id) => personas.find((persona) => persona.id === id)!),
  );
}

export function publicDevelopmentPersona(
  persona: DevelopmentPersona,
): PublicDevelopmentPersona {
  const {
    privateKeyHex: _privateKeyHex,
    signerPublicKeyHex: _signerPublicKeyHex,
    ...publicPersona
  } = persona;
  return publicPersona;
}

export function selectedDevelopmentPersona(
  personas: readonly DevelopmentPersona[],
  selectedId: string | null,
): DevelopmentPersona {
  return personas.find(({ id }) => id === selectedId) ?? personas[0]!;
}

export function personaPreferenceKey(
  networkId: string,
  contractAddress: string,
): string {
  return `thruput-life:active-persona:v1:${networkId}:${contractAddress}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
