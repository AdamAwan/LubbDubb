import { stripOwnFrame } from '../knowledge/frame.js';
import type { Obstacle, ObstacleKeyKind, ObstacleSighting, ObstacleState } from '../types.js';
import type { KeyCandidate } from './keys.js';
import { reachesAgents } from './lifecycle.js';
import type { NearCandidate } from './match.js';

// → docs/spec/27-obstacles.md

const OTHERS_SHOWN = 3;

const KEY_KINDS: ReadonlySet<string> = new Set<ObstacleKeyKind>(['check', 'test', 'path', 'signature', 'cmd']);

interface RaisedObstacle {
  blocksMe: boolean;
  what: string;
  words: string;
  whyNotMine: string;
  keys: KeyCandidate[];
  untilHours: number | null;
}

export function validateRaisedObstacle(
  raw: unknown,
  goalRef: string | null,
): { ok: true; report: RaisedObstacle } | { ok: false; error: string } {
  const args = (raw ?? {}) as Record<string, unknown>;
  const what = typeof args.what === 'string' ? args.what.trim() : '';
  if (what === '') return { ok: false, error: 'what is required: one line, in your own words, saying what you hit' };
  const whyNotMine = typeof args.why_not_mine === 'string' ? args.why_not_mine.trim() : '';
  if (whyNotMine === '') {
    return {
      ok: false,
      error:
        'why_not_mine is required: say why this is not your own change doing. Nothing validates it — writing ' +
        'it down is what makes you check.',
    };
  }
  const until = args.until;
  if (until !== undefined && until !== null && typeof until !== 'number') {
    return { ok: false, error: 'until must be a number of hours: how long you expect what you saw to last' };
  }
  const framed = stripOwnFrame(what, goalRef);
  return {
    ok: true,
    report: {
      what: framed.claim,
      words: what,
      whyNotMine,
      keys: parseKeyCandidates(args.keys),
      untilHours: typeof until === 'number' ? until : null,
      blocksMe: args.blocks_me === true,
    },
  };
}

export function parseKeyCandidates(raw: unknown): KeyCandidate[] {
  if (!Array.isArray(raw)) return [];
  const out: KeyCandidate[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const at = entry.indexOf(':');
    if (at <= 0) continue;
    const kind = entry.slice(0, at).trim().toLowerCase();
    const value = entry.slice(at + 1).trim();
    if (!KEY_KINDS.has(kind) || value === '') continue;
    out.push({ kind: kind as ObstacleKeyKind, value });
  }
  return out;
}

export function ownBreakage(keys: readonly KeyCandidate[], ownPaths: readonly string[]): string | null {
  const own = new Set(ownPaths.map((p) => p.toLowerCase()));
  for (const key of keys) {
    if (key.kind !== 'path' && key.kind !== 'test') continue;
    const file = key.value.split(/[\s>#]|::/)[0]!.toLowerCase();
    if (own.has(file)) return key.value.split(/[\s>#]|::/)[0]!;
  }
  return null;
}

function directiveFor(state: ObstacleState, ownerRef: string | null, blocksMe: boolean): string {
  if (blocksMe) {
    return (
      'You cannot finish. Conclude `blocked`, naming this obstacle by the id in this answer. Your goal ' +
      'is parked rather than failed, and comes back the moment this clears. Do not go fixing it.'
    );
  }
  if (state === 'owned' && ownerRef !== null) {
    return `${ownerRef} owns this. Do not fix it. Note it and return to your task.`;
  }
  if (reachesAgents(state)) {
    return 'Two independent voices have hit this. It is not yours. Recorded — return to your task.';
  }
  return (
    'Recorded. Nothing else has seen this, so it may be your own change: check your diff before deciding ' +
    'it is not. Either way, do not go fixing it.'
  );
}

interface ObstacleLookup {
  status: ObstacleState;
  seen_by: number;
  owner: string | null;
  directive: string;
  what_others_saw: string[];
  near: { id: string; what: string }[];
}

export function lookupFor(input: {
  obstacle: Obstacle;
  voices: number;
  sightings: readonly ObstacleSighting[];
  mine: string | null;
  near: readonly NearCandidate[];
  blocksMe: boolean;
}): ObstacleLookup {
  const others = reachesAgents(input.obstacle.state)
    ? input.sightings
        .filter((s) => s.id !== input.mine)
        .slice(-OTHERS_SHOWN)
        .map((s) => s.words)
    : [];
  return {
    status: input.obstacle.state,
    seen_by: input.voices,
    owner: input.obstacle.ownerRef,
    directive: directiveFor(input.obstacle.state, input.obstacle.ownerRef, input.blocksMe),
    what_others_saw: others,
    near: input.near.map((row) => ({ id: row.id, what: row.what })),
  };
}
