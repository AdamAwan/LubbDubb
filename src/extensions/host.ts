import type { ErrorRecorder } from '../errorLog.js';
import type { Config } from '../config/config.js';
import { withDeadline } from '../primitives.js';
import type { LoadedExtension, SlotBook, SlotImplementation, SlotMap, SlotResult } from './contract.js';
import { EXTENSION_SLOTS, type ExtensionSlots } from './slots.js';

// → docs/spec/42-extensions.md#calling-a-slot

interface Bound {
  extension: string;
  run: SlotImplementation;
}

export class ExtensionHost<S extends SlotMap> {
  private readonly bound = new Map<string, Bound>();

  constructor(
    private readonly opts: {
      book: SlotBook<S>;
      extensions: readonly LoadedExtension[];
      repoRoot: string;
      errors: ErrorRecorder;
    },
  ) {
    for (const extension of opts.extensions)
      for (const [slot, run] of extension.slots) this.bound.set(slot, { extension: extension.name, run });
  }

  names(): string[] {
    return this.opts.extensions.map((extension) => extension.name);
  }

  provider(slot: keyof S & string): string | null {
    return this.bound.get(slot)?.extension ?? null;
  }

  async call<K extends keyof S & string>(slot: K, input: S[K]['input']): Promise<SlotResult<S[K]['output']>> {
    const bound = this.bound.get(slot);
    if (!bound) return { ok: false, detail: `no extension fills the "${slot}" slot` };
    const definition = this.opts.book[slot];
    const controller = new AbortController();
    try {
      const value = await withDeadline(
        Promise.resolve().then(() => bound.run(input, { repoRoot: this.opts.repoRoot, signal: controller.signal })),
        definition.timeoutMs,
        `it did not answer within ${definition.timeoutMs} ms`,
      );
      const refused = definition.check(value);
      if (refused !== null) return this.failed(slot, bound, controller, `it answered with the wrong shape: ${refused}`);
      return { ok: true, value: value as S[K]['output'] };
    } catch (err) {
      const { why, stack } = thrown(err);
      return this.failed(slot, bound, controller, why, stack);
    }
  }

  private failed(
    slot: string,
    bound: Bound,
    controller: AbortController,
    why: string,
    stack: string | null = null,
  ): SlotResult<never> {
    controller.abort();
    const detail = `extension "${bound.extension}" failed the "${slot}" slot: ${why}`;
    this.opts.errors.record({ source: 'runtime', message: detail, detail: stack });
    return { ok: false, detail };
  }
}

function thrown(err: unknown): { why: string; stack: string | null } {
  try {
    if (err instanceof Error) return { why: err.message, stack: err.stack ?? null };
    const { message, stack } = (err ?? {}) as { message?: unknown; stack?: unknown };
    return {
      why: typeof message === 'string' ? message : String(err),
      stack: typeof stack === 'string' ? stack : null,
    };
  } catch {
    return { why: 'it threw a value that cannot be read', stack: null };
  }
}

export function buildExtensionHost(
  config: Config,
  loaded: readonly LoadedExtension[] | undefined,
  errors: ErrorRecorder,
): ExtensionHost<ExtensionSlots> {
  const missing = config.extensions.filter((path) => !loaded?.some((extension) => extension.path === path));
  if (missing.length > 0)
    throw new Error(
      `Refusing to start: config names extension(s) that were not loaded: ${missing.join(', ')} — ` +
        'call loadExtensions before buildSystem and pass what it returns as opts.extensions.',
    );
  return new ExtensionHost({ book: EXTENSION_SLOTS, extensions: loaded ?? [], repoRoot: config.repoRoot, errors });
}
