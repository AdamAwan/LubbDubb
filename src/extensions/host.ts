import { AsyncLocalStorage } from 'node:async_hooks';
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
import { EXTENSION_SLOTS, type ExtensionSlots } from './slots.js';

// → docs/spec/42-extensions.md#calling-a-slot

interface Bound {
  extension: string;
  run: SlotImplementation;
}

interface Scope {
  slot: string;
  bound: Bound;
  open: boolean;
  fault: (err: unknown) => void;
}

export class ExtensionHost<S extends SlotMap> {
  private readonly bound = new Map<string, Bound>();
  private readonly scope = new AsyncLocalStorage<Scope>();

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

  async call<K extends keyof S & string>(slot: K, input: S[K]['input']): Promise<SlotResult<S[K]['output']>> {
    const bound = this.bound.get(slot);
    if (!bound) return { ok: false, detail: `no extension fills the "${slot}" slot` };
    const definition = this.opts.book[slot];
    const controller = new AbortController();
    let fault: (err: unknown) => void = () => {};
    const faulted = new Promise<never>((_, reject) => {
      fault = reject;
    });
    const scope: Scope = { slot, bound, open: true, fault };
    const running = this.scope.run(scope, () =>
      Promise.resolve().then(() => bound.run(input, { repoRoot: this.opts.repoRoot, signal: controller.signal })),
    );
    try {
      const value = await withDeadline(
        Promise.race([running, faulted]),
        definition.timeoutMs,
        `it did not answer within ${definition.timeoutMs} ms`,
      );
      const refused = definition.check(value);
      if (refused !== null) return this.failed(slot, bound, controller, `it answered with the wrong shape: ${refused}`);
      return { ok: true, value: value as S[K]['output'] };
    } catch (err) {
      return this.failed(slot, bound, controller, thrownText(err), thrownStack(err));
    } finally {
      scope.open = false;
    }
  }

  contain(err: unknown): boolean {
    const scope = this.scope.getStore();
    if (scope === undefined) return false;
    if (scope.open) {
      scope.fault(err);
      return true;
    }
    this.opts.errors.record({
      source: 'runtime',
      message: `extension "${scope.bound.extension}" threw after its "${scope.slot}" slot ended: ${thrownText(err)}`,
      detail: thrownStack(err),
    });
    return true;
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
  return new ExtensionHost({ book: EXTENSION_SLOTS, extensions: loaded ?? [], repoRoot: config.repoRoot, errors });
}
