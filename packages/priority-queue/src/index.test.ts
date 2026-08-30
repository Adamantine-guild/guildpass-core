import { describe, it, expect } from 'vitest';
import { PriorityQueue, DuplicateIdError, UnknownIdError } from './index';

describe('PriorityQueue basics', () => {
  it('starts empty and reports size', () => {
    const q = new PriorityQueue<string>();
    expect(q.size()).toBe(0);
    expect(q.peek()).toBeUndefined();
    expect(q.dequeue()).toBeUndefined();
  });

  it('dequeues lower numeric priority first', () => {
    const q = new PriorityQueue<string>();
    q.enqueue('a', 5, 'A');
    q.enqueue('b', 1, 'B');
    q.enqueue('c', 3, 'C');

    expect(q.peek()?.id).toBe('b');
    expect(q.dequeue()).toEqual({ id: 'b', priority: 1, payload: 'B' });
    expect(q.dequeue()).toEqual({ id: 'c', priority: 3, payload: 'C' });
    expect(q.dequeue()).toEqual({ id: 'a', priority: 5, payload: 'A' });
    expect(q.dequeue()).toBeUndefined();
  });

  it('preserves FIFO order among equal-priority entries', () => {
    const q = new PriorityQueue<string>();
    q.enqueue('a', 1, 'A');
    q.enqueue('b', 1, 'B');
    q.enqueue('c', 1, 'C');
    q.enqueue('d', 1, 'D');

    expect(q.dequeue()?.id).toBe('a');
    expect(q.dequeue()?.id).toBe('b');
    expect(q.dequeue()?.id).toBe('c');
    expect(q.dequeue()?.id).toBe('d');
  });

  it('preserves FIFO order among equal-priority entries interleaved with other priorities', () => {
    const q = new PriorityQueue<string>();
    q.enqueue('a', 2, 'A');
    q.enqueue('b', 1, 'B');
    q.enqueue('c', 2, 'C');
    q.enqueue('d', 1, 'D');
    q.enqueue('e', 2, 'E');

    // priority 1 group: b, d (insertion order)
    // priority 2 group: a, c, e (insertion order)
    expect(q.dequeue()?.id).toBe('b');
    expect(q.dequeue()?.id).toBe('d');
    expect(q.dequeue()?.id).toBe('a');
    expect(q.dequeue()?.id).toBe('c');
    expect(q.dequeue()?.id).toBe('e');
  });

  it('tracks size accurately across enqueue/dequeue/remove', () => {
    const q = new PriorityQueue<number>();
    expect(q.size()).toBe(0);
    q.enqueue('a', 1, 1);
    q.enqueue('b', 2, 2);
    expect(q.size()).toBe(2);
    q.remove('a');
    expect(q.size()).toBe(1);
    q.dequeue();
    expect(q.size()).toBe(0);
  });

  it('has() reflects membership', () => {
    const q = new PriorityQueue<number>();
    q.enqueue('a', 1, 1);
    expect(q.has('a')).toBe(true);
    expect(q.has('b')).toBe(false);
    q.dequeue();
    expect(q.has('a')).toBe(false);
  });

  it('rejects non-integer priorities', () => {
    const q = new PriorityQueue<number>();
    expect(() => q.enqueue('a', 1.5, 1)).toThrow(RangeError);
    q.enqueue('a', 1, 1);
    expect(() => q.updatePriority('a', 2.2)).toThrow(RangeError);
  });
});

describe('PriorityQueue duplicate id policy', () => {
  it('rejects duplicate ids by default', () => {
    const q = new PriorityQueue<string>();
    q.enqueue('a', 1, 'A');
    expect(() => q.enqueue('a', 2, 'A2')).toThrow(DuplicateIdError);
    expect(q.size()).toBe(1);
    expect(q.peek()?.payload).toBe('A');
  });

  it('replaces existing entries when policy is "replace"', () => {
    const q = new PriorityQueue<string>({ onDuplicateId: 'replace' });
    q.enqueue('a', 5, 'A');
    q.enqueue('b', 1, 'B');
    q.enqueue('a', 0, 'A2');

    expect(q.size()).toBe(2);
    expect(q.dequeue()).toEqual({ id: 'a', priority: 0, payload: 'A2' });
    expect(q.dequeue()).toEqual({ id: 'b', priority: 1, payload: 'B' });
  });

  it('replace treats the item as newly inserted for tie-breaking', () => {
    const q = new PriorityQueue<string>({ onDuplicateId: 'replace' });
    q.enqueue('a', 1, 'A');
    q.enqueue('b', 1, 'B');
    // Re-insert 'a' at the same priority; it should now sort after 'b'.
    q.enqueue('a', 1, 'A2');

    expect(q.dequeue()?.id).toBe('b');
    expect(q.dequeue()).toEqual({ id: 'a', priority: 1, payload: 'A2' });
  });
});

describe('PriorityQueue updatePriority', () => {
  it('repositions an item to the front when priority is lowered', () => {
    const q = new PriorityQueue<string>();
    q.enqueue('a', 10, 'A');
    q.enqueue('b', 20, 'B');
    q.enqueue('c', 30, 'C');

    q.updatePriority('c', 1);
    expect(q.dequeue()?.id).toBe('c');
    expect(q.dequeue()?.id).toBe('a');
    expect(q.dequeue()?.id).toBe('b');
  });

  it('repositions an item to the back when priority is raised', () => {
    const q = new PriorityQueue<string>();
    q.enqueue('a', 1, 'A');
    q.enqueue('b', 2, 'B');
    q.enqueue('c', 3, 'C');

    q.updatePriority('a', 100);
    expect(q.dequeue()?.id).toBe('b');
    expect(q.dequeue()?.id).toBe('c');
    expect(q.dequeue()?.id).toBe('a');
  });

  it('throws for unknown ids', () => {
    const q = new PriorityQueue<string>();
    expect(() => q.updatePriority('missing', 1)).toThrow(UnknownIdError);
  });

  it('keeps original insertion sequence when priority is updated to match an existing tier', () => {
    const q = new PriorityQueue<string>();
    q.enqueue('a', 1, 'A'); // seq 0
    q.enqueue('b', 5, 'B'); // seq 1
    q.enqueue('c', 1, 'C'); // seq 2

    // b moves into the priority-1 tier. Its *original* insertion sequence
    // (1) places it between a (seq 0) and c (seq 2), regardless of when
    // the update happened.
    q.updatePriority('b', 1);
    expect(q.dequeue()?.id).toBe('a');
    expect(q.dequeue()?.id).toBe('b');
    expect(q.dequeue()?.id).toBe('c');
  });
});

describe('PriorityQueue remove', () => {
  it('removes an arbitrary item by id and returns it', () => {
    const q = new PriorityQueue<string>();
    q.enqueue('a', 1, 'A');
    q.enqueue('b', 2, 'B');
    q.enqueue('c', 3, 'C');

    expect(q.remove('b')).toEqual({ id: 'b', priority: 2, payload: 'B' });
    expect(q.has('b')).toBe(false);
    expect(q.size()).toBe(2);
    expect(q.dequeue()?.id).toBe('a');
    expect(q.dequeue()?.id).toBe('c');
  });

  it('returns undefined when removing an unknown id', () => {
    const q = new PriorityQueue<string>();
    q.enqueue('a', 1, 'A');
    expect(q.remove('missing')).toBeUndefined();
    expect(q.size()).toBe(1);
  });

  it('removing the last remaining item empties the queue safely', () => {
    const q = new PriorityQueue<string>();
    q.enqueue('a', 1, 'A');
    expect(q.remove('a')).toEqual({ id: 'a', priority: 1, payload: 'A' });
    expect(q.size()).toBe(0);
    expect(q.peek()).toBeUndefined();
    expect(q.dequeue()).toBeUndefined();
  });
});

// --- Deterministic reference-model stress test ---------------------------
//
// A minimal xorshift32 PRNG keeps the whole run reproducible across machines
// and Node versions without depending on any external seeded-random package.
function makeRng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

/** Naive O(n log n)-per-op reference model used to validate the heap. */
class ReferenceQueue<T> {
  private entries: Array<{ id: string; priority: number; seq: number; payload: T }> = [];
  private seq = 0;

  enqueue(id: string, priority: number, payload: T): boolean {
    if (this.entries.some((e) => e.id === id)) {
      return false;
    }
    this.entries.push({ id, priority, seq: this.seq++, payload });
    return true;
  }

  private sorted() {
    return [...this.entries].sort((a, b) => a.priority - b.priority || a.seq - b.seq);
  }

  dequeue() {
    const sorted = this.sorted();
    const top = sorted[0];
    if (!top) return undefined;
    this.entries = this.entries.filter((e) => e.id !== top.id);
    return { id: top.id, priority: top.priority, payload: top.payload };
  }

  peek() {
    const top = this.sorted()[0];
    if (!top) return undefined;
    return { id: top.id, priority: top.priority, payload: top.payload };
  }

  updatePriority(id: string, priority: number): boolean {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return false;
    entry.priority = priority;
    return true;
  }

  remove(id: string) {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return undefined;
    this.entries = this.entries.filter((e) => e.id !== id);
    return { id: entry.id, priority: entry.priority, payload: entry.payload };
  }

  size() {
    return this.entries.length;
  }

  has(id: string) {
    return this.entries.some((e) => e.id === id);
  }
}

describe('PriorityQueue vs reference model (deterministic stress test)', () => {
  it('matches a naive reference implementation across thousands of randomized operations', () => {
    const rng = makeRng(0xc0ffee);
    const q = new PriorityQueue<number>();
    const ref = new ReferenceQueue<number>();

    const universeSize = 200;
    const ids = Array.from({ length: universeSize }, (_, i) => `id-${i}`);
    let created = 0;

    const OPS = 20_000;
    for (let i = 0; i < OPS; i++) {
      const roll = rng();
      const idIndex = Math.floor(rng() * universeSize);
      const id = ids[idIndex]!;
      const priority = Math.floor(rng() * 1000) - 500;

      if (roll < 0.45) {
        // enqueue
        const existedInRef = ref.has(id);
        if (existedInRef) {
          expect(() => q.enqueue(id, priority, created)).toThrow(DuplicateIdError);
        } else {
          q.enqueue(id, priority, created);
          const ok = ref.enqueue(id, priority, created);
          expect(ok).toBe(true);
          created++;
        }
      } else if (roll < 0.65) {
        // dequeue
        const expected = ref.dequeue();
        const actual = q.dequeue();
        expect(actual).toEqual(expected);
      } else if (roll < 0.75) {
        // peek
        expect(q.peek()).toEqual(ref.peek());
      } else if (roll < 0.9) {
        // updatePriority (only if present)
        if (ref.has(id)) {
          q.updatePriority(id, priority);
          ref.updatePriority(id, priority);
        } else {
          expect(() => q.updatePriority(id, priority)).toThrow();
        }
      } else {
        // remove
        const expected = ref.remove(id);
        const actual = q.remove(id);
        expect(actual).toEqual(expected);
      }

      expect(q.size()).toBe(ref.size());
    }

    // Drain both and confirm full agreement to the end.
    while (ref.size() > 0) {
      expect(q.dequeue()).toEqual(ref.dequeue());
    }
    expect(q.dequeue()).toBeUndefined();
    expect(q.size()).toBe(0);
  });
});
