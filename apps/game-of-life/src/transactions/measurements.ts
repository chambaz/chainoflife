import type { AppConfig } from "@/config";

export interface WorldMeasurement {
  readonly kind: "advance" | "reset";
  readonly size: number;
  readonly epoch: string;
  readonly generation: string;
  readonly digest: string;
  readonly hash: string;
  readonly submittedAt: number;
  readonly confirmedAt: number;
  readonly readyAt: number | null;
  readonly gasUsed: string;
}
type Scope = Pick<AppConfig, "networkId" | "contractAddress">;
const changed = "chain-of-life:measurement";
const key = (scope: Scope) =>
  `chain-of-life:measurements:v1:${scope.networkId}:${scope.contractAddress}`;

export function loadMeasurements(scope: Scope): WorldMeasurement[] {
  const raw = localStorage.getItem(key(scope));
  if (raw === null) return [];
  const value: unknown = JSON.parse(raw);
  if (
    !Array.isArray(value) ||
    value.some(
      (entry) =>
        !entry ||
        !["advance", "reset"].includes(entry.kind) ||
        !Number.isInteger(entry.size) ||
        entry.size < 100 ||
        entry.size > 10_000 ||
        ![entry.submittedAt, entry.confirmedAt].every(Number.isFinite) ||
        !(entry.readyAt === null || Number.isFinite(entry.readyAt)) ||
        ![entry.epoch, entry.generation, entry.gasUsed].every(
          (field) =>
            typeof field === "string" && /^(0|[1-9][0-9]*)$/.test(field),
        ) ||
        ![entry.digest, entry.hash].every(
          (field) =>
            typeof field === "string" && /^0x[0-9a-f]{64}$/.test(field),
        ),
    )
  )
    throw new Error("Stored timing measurements are invalid");
  return value as WorldMeasurement[];
}

function save(scope: Scope, entries: WorldMeasurement[]): void {
  localStorage.setItem(key(scope), JSON.stringify(entries.slice(-20)));
  window.dispatchEvent(new Event(changed));
}

export function recordMeasurement(
  scope: Scope,
  measurement: WorldMeasurement,
): void {
  const entries = loadMeasurements(scope);
  if (entries.some(({ hash }) => hash === measurement.hash)) return;
  save(scope, [...entries, measurement]);
}

export function markBoardReady(scope: Scope, digest: string): void {
  const entries = loadMeasurements(scope);
  if (
    !entries.some((entry) => entry.digest === digest && entry.readyAt === null)
  )
    return;
  save(
    scope,
    entries.map((entry) =>
      entry.digest === digest && entry.readyAt === null
        ? { ...entry, readyAt: Date.now() }
        : entry,
    ),
  );
}

export function subscribeMeasurements(
  scope: Scope,
  listener: () => void,
): () => void {
  const storage = (event: StorageEvent) => {
    if (event.key === key(scope) || event.key === null) listener();
  };
  window.addEventListener(changed, listener);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(changed, listener);
    window.removeEventListener("storage", storage);
  };
}
