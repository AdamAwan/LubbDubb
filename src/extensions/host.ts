import type { ErrorRecorder } from '../errorLog.js';
import type { Config } from '../config/config.js';
import { withDeadline } from '../primitives.js';
import { thrownStack, thrownText } from './thrown.js';
import {
  extensionClash,
  type LoadedExtension,
  type SlotBook,
  type SlotImplementation,
  type SlotMap,
  type SlotResult,
} from './contract.js';
import { extensionSlotBook, type ExtensionSlots } from './slots.js';

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
    const clash = extensionClash(opts.extensions);
    if (clash !== null) throw new Error(`Refusing to start: ${clash}.`);
    for (const extension of opts.extensions)
      for (const [slot, run] of extension.slots) this.bound.set(slot, { extension: extension.name, run });
  }

  names(): string[] {
    return this.opts.extensions.map((extension) => extension.name);
  }

  provider(slot: keyof S & string): string | null {
    return this.bound.get(slot)?.extension ?? null;
  }

  async call<K extends keyof S & string>(
    slot: K,
    input: S[K]['input'],
    onProgress?: (line: string) => void,
  ): Promise<SlotResult<S[K]['output']>> {
    const bound = this.bound.get(slot);
    if (!bound) return { ok: false, detail: `no extension fills the "${slot}" slot` };
    const definition = this.opts.book[slot];
    const controller = new AbortController();
    let open = true;
    const progress = (line: string): void => {
      if (!open || onProgress === undefined) return;
      try {
        onProgress(String(line));
      } catch (err) {
        this.opts.errors.record({
          source: 'runtime',
          message: `a progress line from extension "${bound.extension}" on the "${slot}" slot was not shown: ${thrownText(err)}`,
          detail: thrownStack(err),
        });
      }
    };
    try {
      const value = await withDeadline(
        Promise.resolve().then(() =>
          bound.run(input, { repoRoot: this.opts.repoRoot, signal: controller.signal, progress }),
        ),
        definition.timeoutMs,
        `it did not answer within ${definition.timeoutMs} ms`,
      ).finally(() => {
        open = false;
      });
      const refused = definition.check(value);
      if (refused !== null) return this.failed(slot, bound, controller, `it answered with the wrong shape: ${refused}`);
      return { ok: true, value: value as S[K]['output'] };
    } catch (err) {
      return this.failed(slot, bound, controller, thrownText(err), thrownStack(err));
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

export function checkLoadedExtensions(config: Config, loaded: readonly LoadedExtension[] = []): void {
  const loadedPaths = loaded.map((extension) => extension.path);
  const missing = config.extensions.filter((path) => !loadedPaths.includes(path));
  const extra = loadedPaths.filter((path) => !config.extensions.includes(path));
  if (missing.length > 0 || extra.length > 0)
    throw new Error(
      `Refusing to start: the extensions passed to buildSystem are not the ones config names` +
        (missing.length > 0 ? ` — not loaded: ${missing.join(', ')}` : '') +
        (extra.length > 0 ? ` — not in config: ${extra.join(', ')}` : '') +
        '. Pass what loadExtensions returned for config.extensions as opts.extensions.',
    );
  const clash = extensionClash(loaded);
  if (clash !== null) throw new Error(`Refusing to start: ${clash}.`);
}

export function buildExtensionHost(
  config: Config,
  loaded: readonly LoadedExtension[] | undefined,
  errors: ErrorRecorder,
): ExtensionHost<ExtensionSlots> {
  return new ExtensionHost({
    book: extensionSlotBook(config.remoteValidation.tenantTimeoutMs),
    extensions: loaded ?? [],
    repoRoot: config.repoRoot,
    errors,
  });
}
