/**
 * A fixed-size map. Writes re-insert the key, so eviction removes the least
 * recently written entry. Reads do not change eviction order.
 */
export class BoundedCache<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(private readonly limit: number) {}

  get(key: K): V | undefined {
    return this.entries.get(key);
  }

  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.entries.delete(oldest);
    }
  }

  delete(key: K): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
