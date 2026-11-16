import type { Agent, AskGoalPart } from '../types.js';
import type { NeedRow } from './needsYou.js';
import { KIND_LABEL } from './askKinds.js';

// → docs/spec/17-cockpit.md#one-ask-at-a-time

export const LOOK_ID = 'focus:look';
export const LOOK_TITLE = 'Worth a look';

/** A stop on the queue: an ask, or null for the leads that end it. */
export type FocusStop = NeedRow | null;

interface FocusCursor {
  id: string;
  at: number;
}

/** The asks in the server's one-at-a-time order, shipped as each row's `focusRank`. */
export function focusRows(needsYou: readonly NeedRow[]): NeedRow[] {
  return [...needsYou].sort((a, b) => a.focusRank - b.focusRank);
}

/** How many parts are stalled behind the whole set. */
export function partsHeld(rows: readonly NeedRow[]): number {
  return rows.reduce((sum, row) => sum + row.holding, 0);
}

export function focusStops(rows: readonly NeedRow[]): FocusStop[] {
  return [...rows, null];
}

export function stopId(stop: FocusStop): string {
  return stop?.id ?? LOOK_ID;
}

/** The cursor's id resolved back to an index; where it is gone, the position it held, clamped to the queue. */
export function cursorIndex(stops: readonly FocusStop[], cursor: FocusCursor | null): number {
  const found = cursor === null ? -1 : stops.findIndex((s) => stopId(s) === cursor.id);
  return Math.min(found === -1 ? (cursor?.at ?? 0) : found, stops.length - 1);
}

export function stopAriaLabel(stop: FocusStop, i: number, total: number): string {
  return stop === null
    ? `${i + 1} of ${total} — ${LOOK_TITLE}`
    : `${i + 1} of ${total} — ${KIND_LABEL[stop.kind]}: ${stop.title}`;
}

export function stopTitle(stop: FocusStop): string {
  return stop === null ? LOOK_TITLE : `${KIND_LABEL[stop.kind]} — ${stop.title}`;
}

/** The foot of an ask: what is left after it, or that the leads come next. */
export function focusRest(after: number, held: number): string {
  return after === 0
    ? 'last ask — what is worth a look is next'
    : `${after} after this · ${held} ${held === 1 ? 'part' : 'parts'} held in total`;
}

export function mergedParts(parts: readonly AskGoalPart[]): number {
  return parts.filter((p) => p.group === 'merged').length;
}

export function runningAgents(agents: readonly Agent[]): number {
  return agents.filter((a) => a.status === 'running').length;
}

export function readingsCount(n: number): string {
  return n === 1 ? '1 reading' : `${n} readings`;
}
