import type { RunningConfigEntry, RunningConfigGroup, RunningConfigPayload } from '../types.js';
import { isStateColour } from '../stateColour.js';
import type { Staged } from './ConfigValues.js';

function asColourMap(value: unknown): Record<string, string> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [state, colour] of Object.entries(value)) {
    if (!isStateColour(colour)) return null;
    out[state] = colour;
  }
  return out;
}

export function readColourMap(raw: string): Record<string, string> | null {
  try {
    return asColourMap(JSON.parse(raw));
  } catch {
    return null;
  }
}

export interface Unmet {
  entry: RunningConfigEntry;
  group: string;
  because: string;
}

export function unmetRequirements(payload: RunningConfigPayload, staged: Staged): Unmet[] {
  const out: Unmet[] = [];
  for (const group of payload.groups) {
    for (const entry of group.entries) {
      const need = entry.requiredWhen;
      if (!need) continue;
      const raiser = find(payload, need.path);
      if (!raiser || staged.clear.includes(need.path)) continue;
      const on = Object.hasOwn(staged.set, need.path) ? staged.set[need.path] : raiser.value;
      if (on === need.unless) continue;
      const held = staged.clear.includes(entry.path)
        ? entry.fromProject
          ? 'project'
          : ''
        : Object.hasOwn(staged.set, entry.path)
          ? staged.set[entry.path]
          : entry.value;
      if (typeof held === 'string' && held.trim() !== '') continue;
      out.push({ entry, group: group.title, because: `${need.path} is “${String(on)}”` });
    }
  }
  return out;
}

function find(payload: RunningConfigPayload, path: string): RunningConfigEntry | undefined {
  for (const group of payload.groups) {
    const hit = group.entries.find((entry) => entry.path === path);
    if (hit) return hit;
  }
  return undefined;
}

export function stagedFor(staged: Staged, path: string): 'set' | 'cleared' | null {
  if (staged.clear.includes(path)) return 'cleared';
  return Object.hasOwn(staged.set, path) ? 'set' : null;
}

export function chosenIn(group: RunningConfigGroup | undefined): number {
  return (group?.entries ?? []).filter((entry) => !entry.isDefault).length;
}

export function configured(payload: RunningConfigPayload, path: string): string {
  const hit = find(payload, path);
  return hit ? rawOf(hit.value) : '—';
}

export function rawOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return value.join('\n');
  return JSON.stringify(value, null, 2);
}

export function render(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : JSON.stringify(value);
}
export function parseValue(entry: RunningConfigEntry, raw: string): { value: unknown; error: string | null } {
  switch (entry.type) {
    case 'number': {
      const parsed = Number(raw);
      const ok = raw.trim() !== '' && Number.isFinite(parsed);
      return { value: ok ? parsed : null, error: ok ? null : 'not a number' };
    }
    case 'boolean':
      return { value: raw === 'true', error: null };
    case 'enum':
      return {
        value: raw,
        error: (entry.options ?? []).includes(raw) ? null : `not one of ${(entry.options ?? []).join(', ')}`,
      };
    case 'stringList':
      return {
        value: raw
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== ''),
        error: null,
      };
    case 'json':
      try {
        return { value: JSON.parse(raw), error: null };
      } catch (err) {
        return { value: null, error: (err as Error).message };
      }
    case 'colourMap':
      return parseColourMap(raw);
    default:
      return { value: raw, error: null };
  }
}

function parseColourMap(raw: string): { value: unknown; error: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { value: null, error: (err as Error).message };
  }
  const map = asColourMap(parsed);
  return map ? { value: map, error: null } : { value: null, error: 'each state needs a #rrggbb colour' };
}
