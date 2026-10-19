// A fixed-capacity ring buffer: pushing onto a full buffer evicts the oldest
// item.
export class RingBuffer<T> {
  readonly #items: (T | undefined)[];
  #start = 0; // index of the oldest item
  #size = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`capacity must be a positive integer, got ${String(capacity)}`);
    }
    this.#items = new Array<T | undefined>(capacity);
  }

  get size(): number {
    return this.#size;
  }

  push(item: T): void {
    if (this.#size < this.capacity) {
      this.#items[(this.#start + this.#size) % this.capacity] = item;
      this.#size += 1;
    } else {
      this.#items[this.#start] = item;
      this.#start = (this.#start + 1) % this.capacity;
    }
  }

  // The newest item, or undefined when empty.
  last(): T | undefined {
    if (this.#size === 0) return undefined;
    return this.#items[(this.#start + this.#size - 1) % this.capacity];
  }

  // Replaces the newest item. Throws when empty.
  replaceLast(item: T): void {
    if (this.#size === 0) throw new RangeError('replaceLast on an empty ring buffer');
    this.#items[(this.#start + this.#size - 1) % this.capacity] = item;
  }

  // The newest n items (all by default), oldest first.
  toArray(n: number = this.#size): T[] {
    const count = Math.max(0, Math.min(Math.floor(n), this.#size));
    const result: T[] = [];
    for (let i = this.#size - count; i < this.#size; ++i) {
      result.push(this.#items[(this.#start + i) % this.capacity] as T);
    }
    return result;
  }

  clear(): void {
    this.#items.fill(undefined);
    this.#start = 0;
    this.#size = 0;
  }
}
