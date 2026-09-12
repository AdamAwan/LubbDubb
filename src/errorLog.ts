import { EventEmitter } from 'node:events';
import type { Store } from './store/store.js';
import type { ErrorLogEntry, ErrorLogInput } from './types.js';

// → docs/spec/18-observability.md

export interface ErrorRecorder {
  record(input: ErrorLogInput): ErrorLogEntry;
}

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
    const entry = this.store.errors.recordError(input);
    this.mirror(entry);
    this.emit('logged', entry);
    return entry;
  }

  override emit<K extends keyof ErrorLogEvents>(event: K, ...args: ErrorLogEvents[K]): boolean {
    return super.emit(event, ...args);
  }
  override on<K extends keyof ErrorLogEvents>(event: K, listener: (...args: ErrorLogEvents[K]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
}

function oneLine(value: string): string {
  return (
    value
      .replace(/\n/g, ' ')
      .replace(/\r/g, ' ')
      // Then the remaining control characters, which a terminal would interpret
      // rather than print.
      // eslint-disable-next-line no-control-regex -- the rule guards against control characters reaching a regex by accident; matching them is this function’s entire job.
      .replace(/[\u0000-\u001F\u007F]/g, '')
  );
}

function indented(value: string): string {
  return value.replace(/^/gm, '  ');
}
