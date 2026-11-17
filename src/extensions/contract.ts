// → docs/spec/42-extensions.md

export const EXTENSION_API_VERSION = 1;

export interface SlotSignature {
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
