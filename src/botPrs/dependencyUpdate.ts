import type { DependencyUpdate, UpdateKind } from '../types.js';

// → docs/spec/37-bot-prs.md#reading-the-update

const TITLE =
  /^(?:[\w-]+(?:\([^)]*\))?!?:\s*)?update (?:dependency |module |package )?(\S+?)(?: to v?(\S+?))?(?:\s*\((major|minor|patch)\))?\s*$/i;
const CHANGE = /`v?([^`\s]+)`\s*(?:->|→)\s*`v?([^`\s]+)`/;
const UPDATE_CELL = /\|\s*(major|minor|patch)\s*\|/i;

export function readDependencyUpdate(title: string, body?: string): DependencyUpdate {
  const titled = TITLE.exec(title.trim());
  const change = body === undefined ? null : CHANGE.exec(body);
  const from = change?.[1] ?? null;
  const to = change?.[2] ?? titled?.[2] ?? null;
  return {
    kind: statedKind(titled?.[3], body) ?? kindOf(from, to),
    packageName: titled?.[1] ?? null,
    from,
    to,
  };
}

function statedKind(inTitle: string | undefined, body: string | undefined): UpdateKind | undefined {
  const stated = inTitle ?? (body === undefined ? undefined : UPDATE_CELL.exec(body)?.[1]);
  return stated?.toLowerCase() as UpdateKind | undefined;
}

function kindOf(from: string | null, to: string | null): UpdateKind {
  if (to === null) return 'unknown';
  const next = numericParts(to);
  if (from === null) return next.length === 1 ? 'major' : 'unknown';
  const prev = numericParts(from);
  if (prev.length === 0 || next.length === 0) return 'unknown';
  if (prev[0] !== next[0]) return 'major';
  if ((prev[1] ?? 0) !== (next[1] ?? 0)) return 'minor';
  return 'patch';
}

function numericParts(version: string): number[] {
  const core = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version);
  if (!core) return [];
  return core.slice(1).flatMap((part) => (part === undefined ? [] : [Number(part)]));
}
