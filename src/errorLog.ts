import { EventEmitter } from 'node:events';
import type { Store } from './store/store.js';
import type { ErrorLogEntry, ErrorLogInput } from './types.js';

/**
 * The narrow "record a failure" seam handed to anything that can fail — providers,
 * the harness, the agent manager. Narrower than {@link ErrorLog} so consumers stay
 * decoupled from the emitter (and tests can pass a plain capture object).
 */
export interface ErrorRecorder {
  record(input: ErrorLogInput): ErrorLogEntry;
}

/**
 * The central error-recording path. Every failure the system catches — cycle
 * exceptions, provider snapshot errors, agent crashes, route 500s — funnels
 * through {@link record}, which (1) persists the entry so it survives reloads,
 * (2) mirrors it to stderr so headless runs still see it, and (3) emits a
 * `logged` event the Hub fans out over WS so the cockpit's Errors panel updates
 * live. (Not named `error` — that event name is fatal on an unlistened
 * EventEmitter, and recording a failure must never throw.)
 */
interface ErrorLogEvents {
  logged: [ErrorLogEntry];
}

export class ErrorLog extends EventEmitter implements ErrorRecorder {
  constructor(
    private readonly store: Store,
    private readonly mirror: (entry: ErrorLogEntry) => void = (e) =>
      console.error(`[lubbdubb:error] ${e.source}: ${e.message}${e.detail ? `\n${e.detail}` : ''}`),
  ) {
    super();
  }

  record(input: ErrorLogInput): ErrorLogEntry {
    const entry = this.store.recordError(input);
    this.mirror(entry);
    this.emit('logged', entry);
    return entry;
  }

  // Typed emit/on overrides for a nicer call site (repo convention).
  override emit<K extends keyof ErrorLogEvents>(event: K, ...args: ErrorLogEvents[K]): boolean {
    return super.emit(event, ...args);
  }
  override on<K extends keyof ErrorLogEvents>(event: K, listener: (...args: ErrorLogEvents[K]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
}
