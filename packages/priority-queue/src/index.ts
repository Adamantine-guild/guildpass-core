/**
 * A single queued entry. `seq` is the insertion sequence number used purely
 * for deterministic tie-breaking between equal-priority entries; it is never
 * exposed as part of the public API surface.
 */
interface HeapNode<T> {
  readonly id: string;
  priority: number;
  readonly seq: bigint;
  payload: T;
}

/**
 * Behaviour when {@link PriorityQueue.enqueue} is called with an identifier
 * that is already present in the queue.
 *
 * - `'reject'` (default): throw a {@link DuplicateIdError}.
 * - `'replace'`: remove the existing entry and insert the new one, treating
 *   it as a brand-new item — it gets a fresh insertion-order sequence number
 *   and therefore sorts after any existing equal-priority items.
 */
export type DuplicateIdPolicy = 'reject' | 'replace';

export interface PriorityQueueOptions {
  /**
   * Controls what happens when `enqueue` is called with an id that already
   * exists in the queue. Defaults to `'reject'`.
   */
  readonly onDuplicateId?: DuplicateIdPolicy;
}

export interface PriorityQueueEntry<T> {
  readonly id: string;
  readonly priority: number;
  readonly payload: T;
}

/**
 * Thrown when `enqueue` is called with an id already present in the queue
 * and the queue's duplicate-id policy is `'reject'`.
 */
export class DuplicateIdError extends Error {
  constructor(public readonly id: string) {
    super(`PriorityQueue: id "${id}" already exists`);
    this.name = 'DuplicateIdError';
  }
}

/**
 * Thrown when an operation references an id that does not exist in the
 * queue (e.g. `updatePriority` on an unknown id).
 */
export class UnknownIdError extends Error {
  constructor(public readonly id: string) {
    super(`PriorityQueue: id "${id}" does not exist`);
    this.name = 'UnknownIdError';
  }
}

/**
 * Generic, stable, mutable-priority binary heap.
 *
 * Priority ordering: **lower numeric priority values are dequeued first**
 * (min-heap semantics — the same convention as Dijkstra's algorithm, where
 * priority 0 is "most urgent"). Equal-priority entries preserve FIFO
 * insertion order (stable ordering), broken by a per-instance monotonic
 * insertion sequence counter (a `bigint`, so it cannot silently overflow
 * and is never shared across instances).
 *
 * All operations that mutate or query a single entry by id (`updatePriority`,
 * `remove`, `has`) run in O(log n) — an id -> heap-index map is maintained
 * alongside the heap array so the queue never needs a linear scan or a full
 * re-sort. `enqueue` and `dequeue` are also O(log n); `peek`, `size`, and
 * `has` are O(1).
 */
export class PriorityQueue<T> {
  private readonly heap: Array<HeapNode<T>> = [];
  private readonly indexById = new Map<string, number>();
  private readonly onDuplicateId: DuplicateIdPolicy;
  private nextSeq: bigint = 0n;

  constructor(options?: PriorityQueueOptions) {
    this.onDuplicateId = options?.onDuplicateId ?? 'reject';
  }

  /** Number of entries currently in the queue. */
  public size(): number {
    return this.heap.length;
  }

  /** Whether the queue currently contains an entry with the given id. */
  public has(id: string): boolean {
    return this.indexById.has(id);
  }

  /**
   * Inserts a new entry with the given id, priority and payload.
   *
   * If `id` already exists, behaviour is governed by the queue's
   * `onDuplicateId` policy (default `'reject'`, which throws
   * {@link DuplicateIdError}).
   */
  public enqueue(id: string, priority: number, payload: T): void {
    if (!Number.isInteger(priority)) {
      throw new RangeError(`PriorityQueue: priority must be an integer, received ${priority}`);
    }

    if (this.indexById.has(id)) {
      if (this.onDuplicateId === 'reject') {
        throw new DuplicateIdError(id);
      }
      // 'replace': drop the old entry, then fall through to a fresh insert.
      this.removeInternal(this.indexById.get(id)!);
    }

    const node: HeapNode<T> = {
      id,
      priority,
      seq: this.nextSeq,
      payload,
    };
    this.nextSeq += 1n;

    const index = this.heap.length;
    this.heap.push(node);
    this.indexById.set(id, index);
    this.siftUp(index);
  }

  /**
   * Removes and returns the highest-priority entry (lowest numeric
   * priority; ties broken by insertion order). Returns `undefined` if the
   * queue is empty.
   */
  public dequeue(): PriorityQueueEntry<T> | undefined {
    if (this.heap.length === 0) {
      return undefined;
    }
    const top = this.heap[0]!;
    this.removeInternal(0);
    return { id: top.id, priority: top.priority, payload: top.payload };
  }

  /**
   * Returns the highest-priority entry without removing it. Returns
   * `undefined` if the queue is empty.
   */
  public peek(): PriorityQueueEntry<T> | undefined {
    const top = this.heap[0];
    if (!top) {
      return undefined;
    }
    return { id: top.id, priority: top.priority, payload: top.payload };
  }

  /**
   * Updates the priority of an existing entry, repositioning it to
   * preserve heap ordering. The entry keeps its original insertion
   * sequence number, so among items that end up at the same new priority
   * it still sorts by its original FIFO position.
   *
   * Throws {@link UnknownIdError} if `id` is not present.
   */
  public updatePriority(id: string, priority: number): void {
    if (!Number.isInteger(priority)) {
      throw new RangeError(`PriorityQueue: priority must be an integer, received ${priority}`);
    }
    const index = this.indexById.get(id);
    if (index === undefined) {
      throw new UnknownIdError(id);
    }

    const node = this.heap[index]!;
    const oldPriority = node.priority;
    node.priority = priority;

    if (priority < oldPriority) {
      this.siftUp(index);
    } else if (priority > oldPriority) {
      this.siftDown(index);
    }
  }

  /**
   * Removes the entry with the given id, if present. Returns the removed
   * entry, or `undefined` if no entry with that id exists.
   */
  public remove(id: string): PriorityQueueEntry<T> | undefined {
    const index = this.indexById.get(id);
    if (index === undefined) {
      return undefined;
    }
    const node = this.heap[index]!;
    this.removeInternal(index);
    return { id: node.id, priority: node.priority, payload: node.payload };
  }

  // --- internal heap mechanics -------------------------------------------------

  private removeInternal(index: number): void {
    const lastIndex = this.heap.length - 1;
    const removed = this.heap[index]!;
    this.indexById.delete(removed.id);

    if (index === lastIndex) {
      this.heap.pop();
      return;
    }

    const moved = this.heap.pop()!;
    this.heap[index] = moved;
    this.indexById.set(moved.id, index);

    // The moved node came from the end, so it may need to travel in either
    // direction to restore the heap property.
    const parentIndex = PriorityQueue.parentOf(index);
    if (index > 0 && this.isHigherPriority(moved, this.heap[parentIndex]!)) {
      this.siftUp(index);
    } else {
      this.siftDown(index);
    }
  }

  private siftUp(startIndex: number): void {
    let index = startIndex;
    const node = this.heap[index]!;

    while (index > 0) {
      const parentIndex = PriorityQueue.parentOf(index);
      const parent = this.heap[parentIndex]!;
      if (!this.isHigherPriority(node, parent)) {
        break;
      }
      this.heap[index] = parent;
      this.indexById.set(parent.id, index);
      index = parentIndex;
    }

    this.heap[index] = node;
    this.indexById.set(node.id, index);
  }

  private siftDown(startIndex: number): void {
    let index = startIndex;
    const node = this.heap[index]!;
    const length = this.heap.length;

    for (;;) {
      const leftIndex = index * 2 + 1;
      const rightIndex = leftIndex + 1;
      let bestIndex = index;
      let best = node;

      if (leftIndex < length && this.isHigherPriority(this.heap[leftIndex]!, best)) {
        bestIndex = leftIndex;
        best = this.heap[leftIndex]!;
      }
      if (rightIndex < length && this.isHigherPriority(this.heap[rightIndex]!, best)) {
        bestIndex = rightIndex;
        best = this.heap[rightIndex]!;
      }
      if (bestIndex === index) {
        break;
      }

      this.heap[index] = best;
      this.indexById.set(best.id, index);
      index = bestIndex;
    }

    this.heap[index] = node;
    this.indexById.set(node.id, index);
  }

  /** True if `a` should sit closer to the root than `b`. */
  private isHigherPriority(a: HeapNode<T>, b: HeapNode<T>): boolean {
    if (a.priority !== b.priority) {
      return a.priority < b.priority;
    }
    return a.seq < b.seq;
  }

  private static parentOf(index: number): number {
    return (index - 1) >> 1;
  }
}
