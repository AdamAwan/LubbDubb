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
      console.error(
        `[lubbdubb:error] ${oneLine(e.source)}: ${oneLine(e.message)}${e.detail ? `\n${indented(e.detail)}` : ''}`,
      ),
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

/**
 * The mirror writes one line per entry, so a value carrying a newline could end
 * that line early and forge a second `[lubbdubb:error]` one after it. Both halves
 * of the header reach here from outside: an agent id arrives from a request path
 * (`POST /api/agents/:id/complete`), and provider/exception text from the world.
 * Neither is ever legitimately multi-line — a `message` is a sentence by
 * contract — so flattening costs nothing and removes the forgery.
 *
 * Only the stderr mirror is treated this way. The stored entry keeps its exact
 * text: the store is structured rows, not a line-oriented stream, and the cockpit
 * renders it as DOM text, where a newline forges nothing.
 */
function oneLine(value: string): string {
  // Newlines first and explicitly — a forged line is the whole risk — then the
  // remaining control characters, which a terminal would otherwise interpret.
  // eslint-disable-next-line no-control-regex -- the rule guards against control characters reaching a regex by accident; matching them is this function’s entire job.
  return value.replace(/[\r\n]+/g, ' ').replace(/[\u0000-\u001F\u007F]/g, '');
}

/**
 * `detail` is deliberately multi-line — a stack, or an excerpt of an agent's own
 * output — so flattening it would cost the readability it exists for. Indenting
 * every line keeps that shape while making a forged header visibly a continuation
 * of this entry rather than the start of a new one.
 */
function indented(value: string): string {
  return value.replace(/^/gm, '  ');
}
