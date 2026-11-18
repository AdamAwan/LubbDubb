import { EventEmitter } from 'node:events';
import { sameItem } from './sameItem.js';
import type { ListenItem, ListenerState, ListenerView } from '../types.js';

// → docs/spec/44-needs-you.md#the-wait

export const LISTEN_WAIT_MS = 10 * 60_000;
export const LISTEN_GRACE_MS = 60_000;
const SENT_KEPT_MS = 24 * 60 * 60_000;

export interface ListenClock {
  now(): number;
  /** Runs `fn` after `ms`; the returned function cancels it. */
  after(ms: number, fn: () => void): () => void;
}

const realListenClock: ListenClock = {
  now: () => Date.now(),
  after: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

export interface WaitResult {
  item: ListenItem | null;
  superseded?: true;
}

/** Whether a sent item still stands, read off the snapshot only for what is in `sent`: one that does not is dropped. */
export type ListenStanding = (item: ListenItem) => boolean;

interface Waiter {
  answer(result: WaitResult): void;
}

interface Sent {
  item: ListenItem;
  sentAt: number;
}

export class Listener extends EventEmitter {
  private waiter: Waiter | null = null;
  private queue: Sent[] = [];
  private working: ListenItem | null = null;
  private sent: Sent[] = [];
  private lastEmptyReturn: number | null = null;
  private cancelGrace: (() => void) | null = null;
  private lastEmitted = '';

  constructor(private readonly clock: ListenClock = realListenClock) {
    super();
  }

  override on(event: 'changed', listener: () => void): this {
    return super.on(event, listener);
  }

  override emit(event: 'changed'): boolean {
    return super.emit(event);
  }

  wait(): Promise<WaitResult> {
    this.waiter?.answer({ item: null, superseded: true });
    this.working = null;
    this.lastEmptyReturn = null;
    this.stopGrace();
    const head = this.queue.shift();
    if (head !== undefined) {
      this.handOut(head);
      this.changed();
      return Promise.resolve({ item: head.item });
    }
    return new Promise((resolve) => {
      const cancelTimeout = this.clock.after(LISTEN_WAIT_MS, () => {
        if (this.waiter !== waiter) return;
        this.waiter = null;
        this.returnedEmpty();
        resolve({ item: null });
      });
      const waiter: Waiter = {
        answer: (result) => {
          cancelTimeout();
          if (this.waiter === waiter) this.waiter = null;
          resolve(result);
        },
      };
      this.waiter = waiter;
      this.changed();
    });
  }

  send(item: ListenItem): { sent: boolean } {
    if (this.working !== null && sameItem(this.working, item)) return { sent: false };
    if (this.queue.some((q) => sameItem(q.item, item))) return { sent: false };
    const entry = { item, sentAt: this.clock.now() };
    const waiter = this.waiter;
    if (waiter === null) this.queue.push(entry);
    else {
      this.handOut(entry);
      waiter.answer({ item });
    }
    this.changed();
    return { sent: true };
  }

  view(stands: ListenStanding): ListenerView {
    if (this.sent.length > 0) {
      const since = this.clock.now() - SENT_KEPT_MS;
      this.sent = this.sent.filter((s) => s.sentAt > since && stands(s.item));
    }
    return this.current();
  }

  private current(): ListenerView {
    return {
      state: this.state(),
      on: this.working,
      queued: this.queue.length,
      sent: this.sent.map((s) => ({ item: s.item, sentAt: new Date(s.sentAt).toISOString() })),
    };
  }

  private changed(): void {
    const seen = JSON.stringify(this.current());
    if (seen === this.lastEmitted) return;
    this.lastEmitted = seen;
    this.emit('changed');
  }

  private state(): ListenerState {
    if (this.waiter !== null) return 'listening';
    if (this.working !== null) return 'busy';
    if (this.lastEmptyReturn !== null && this.clock.now() - this.lastEmptyReturn < LISTEN_GRACE_MS) return 'listening';
    return 'off';
  }

  private handOut(entry: Sent): void {
    this.working = entry.item;
    this.sent = [entry, ...this.sent.filter((s) => !sameItem(s.item, entry.item))];
  }

  private returnedEmpty(): void {
    this.lastEmptyReturn = this.clock.now();
    this.armGrace(LISTEN_GRACE_MS);
    this.changed();
  }

  private armGrace(ms: number): void {
    this.stopGrace();
    this.cancelGrace = this.clock.after(ms, () => {
      this.cancelGrace = null;
      const left = this.lastEmptyReturn === null ? 0 : this.lastEmptyReturn + LISTEN_GRACE_MS - this.clock.now();
      if (this.waiter === null && left > 0) this.armGrace(left);
      else this.changed();
    });
  }

  private stopGrace(): void {
    this.cancelGrace?.();
    this.cancelGrace = null;
  }
}
