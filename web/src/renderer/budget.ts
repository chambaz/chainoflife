/** Decoded tiles kept in memory across both snapshots, including prefetched tiles. */
export const CPU_TILE_CACHE_BYTES = 32 * 1024 * 1024;
/** Tiles each deck.gl layer keeps with GPU resources; deck evicts hidden tiles beyond it. */
export const GPU_TILE_CACHE_BYTES = 16 * 1024 * 1024;

export class ByteBudget<T> {
  private readonly entries = new Map<string, { value: T; bytes: number }>();
  private used = 0;
  private readonly pinned = new Set<string>();
  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit <= 0)
      throw new RangeError("budget must be positive");
  }
  get byteLength(): number {
    return this.used;
  }
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  set(key: string, value: T, bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.limit)
      throw new RangeError("resource exceeds budget");
    this.delete(key, true);
    this.entries.set(key, { value, bytes });
    this.used += bytes;
    while (this.used > this.limit) {
      const oldest = [...this.entries.keys()].find(
        (candidate) => !this.pinned.has(candidate),
      );
      if (oldest === undefined) {
        this.delete(key, true);
        throw new RangeError("pinned resources exceed budget");
      }
      this.delete(oldest);
    }
  }
  pin(key: string): void {
    this.pinned.add(key);
  }
  unpin(key: string): void {
    this.pinned.delete(key);
  }
  delete(key: string, force = false): boolean {
    if (!force && this.pinned.has(key)) return false;
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.used -= entry.bytes;
    return true;
  }
  clear(): void {
    this.pinned.clear();
    for (const key of [...this.entries.keys()]) this.delete(key, true);
  }
  deletePrefix(prefix: string): void {
    for (const key of [...this.entries.keys()])
      if (key.startsWith(prefix)) this.delete(key, true);
  }
}
