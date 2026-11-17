// → docs/spec/42-extensions.md

export const EXTENSION_API_VERSION = 1;

interface SlotSignature {
  input: unknown;
  output: unknown;
}

export type SlotMap = Record<string, SlotSignature>;

interface SlotContext {
  repoRoot: string;
  signal: AbortSignal;
}

export type SlotImplementation = (input: unknown, context: SlotContext) => unknown;

interface SlotDefinition {
  timeoutMs: number;
  /** A refusal in the operator's words, or null where the value is the shape the slot promised. */
  check: (value: unknown) => string | null;
}

export type SlotBook<S extends SlotMap> = { readonly [K in keyof S & string]: SlotDefinition };

export interface LoadedExtension {
  name: string;
  path: string;
  slots: ReadonlyMap<string, SlotImplementation>;
}

export type SlotResult<O> = { ok: true; value: O } | { ok: false; detail: string };

export function extensionClash(extensions: readonly LoadedExtension[]): string | null {
  const paths = new Set<string>();
  const names = new Map<string, string>();
  const owners = new Map<string, LoadedExtension>();
  for (const extension of extensions) {
    if (paths.has(extension.path)) return `the extension at ${extension.path} is loaded twice`;
    paths.add(extension.path);
    const named = names.get(extension.name);
    if (named !== undefined)
      return `the extensions at ${named} and ${extension.path} are both named "${extension.name}"`;
    names.set(extension.name, extension.path);
    for (const slot of extension.slots.keys()) {
      const owner = owners.get(slot);
      if (owner !== undefined)
        return (
          `extensions "${owner.name}" (${owner.path}) and "${extension.name}" (${extension.path}) both fill ` +
          `the "${slot}" slot — a slot has one owner`
        );
      owners.set(slot, extension);
    }
  }
  return null;
}
