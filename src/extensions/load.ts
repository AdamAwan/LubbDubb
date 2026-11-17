import { pathToFileURL } from 'node:url';
import { failure } from '../primitives.js';
import {
  EXTENSION_API_VERSION,
  type LoadedExtension,
  type SlotBook,
  type SlotImplementation,
  type SlotMap,
} from './contract.js';

// → docs/spec/42-extensions.md#loading

const KNOWN_KEYS = new Set(['apiVersion', 'name', 'slots']);

export async function loadExtensions(opts: {
  paths: readonly string[];
  book: SlotBook<SlotMap>;
  importModule?: (url: string) => Promise<unknown>;
}): Promise<LoadedExtension[]> {
  const importModule = opts.importModule ?? ((url: string) => import(url) as Promise<unknown>);
  const loaded: LoadedExtension[] = [];
  for (const path of opts.paths) {
    let module: unknown;
    try {
      module = await importModule(pathToFileURL(path).href);
    } catch (err) {
      throw refusal(path, `it could not be loaded: ${failure(err)}`, err);
    }
    const extension = readExtension(path, module, opts.book);
    const clash = loaded.find((other) => other.name === extension.name);
    if (clash) throw refusal(path, `its name "${extension.name}" is already taken by ${clash.path}`);
    for (const slot of extension.slots.keys()) {
      const owner = loaded.find((other) => other.slots.has(slot));
      if (owner)
        throw refusal(
          path,
          `it fills the "${slot}" slot, which extension "${owner.name}" already fills — a slot has one owner`,
        );
    }
    loaded.push(extension);
  }
  return loaded;
}

function readExtension(path: string, module: unknown, book: SlotBook<SlotMap>): LoadedExtension {
  const value = (module as { default?: unknown } | null)?.default;
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw refusal(path, 'its default export is not an object — write `export default { apiVersion, name, slots }`');
  const raw = value as Record<string, unknown>;

  const unknown = Object.keys(raw).filter((key) => !KNOWN_KEYS.has(key));
  if (unknown.length > 0)
    throw refusal(
      path,
      `it exports ${list(unknown)}, which no extension carries; the keys are ${list([...KNOWN_KEYS])}`,
    );

  if (raw.apiVersion !== EXTENSION_API_VERSION)
    throw refusal(
      path,
      `it is written for apiVersion ${JSON.stringify(raw.apiVersion)} and this harness speaks ${EXTENSION_API_VERSION}`,
    );

  if (typeof raw.name !== 'string' || raw.name.trim() === '') throw refusal(path, 'it has no name');

  return { name: raw.name, path, slots: readSlots(path, raw.slots ?? {}, book) };
}

function readSlots(path: string, value: unknown, book: SlotBook<SlotMap>): Map<string, SlotImplementation> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw refusal(path, '"slots" is not an object of functions');
  const slots = new Map<string, SlotImplementation>();
  const known = Object.keys(book);
  for (const [slot, fn] of Object.entries(value)) {
    if (!Object.hasOwn(book, slot))
      throw refusal(
        path,
        `it fills the "${slot}" slot, which this harness does not have; ` +
          (known.length > 0 ? `the slots are ${list(known)}` : 'this harness has no slots yet'),
      );
    if (typeof fn !== 'function') throw refusal(path, `its "${slot}" slot is not a function`);
    slots.set(slot, fn as SlotImplementation);
  }
  return slots;
}

function refusal(path: string, why: string, cause?: unknown): Error {
  return new Error(
    `Refusing to start: the extension at ${path} — ${why}.`,
    cause === undefined ? undefined : { cause },
  );
}

function list(items: readonly string[]): string {
  return items.map((item) => `"${item}"`).join(', ');
}
