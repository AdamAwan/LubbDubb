import { stripOwnFrame } from '../knowledge/frame.js';
import type { Obstacle, ObstacleKeyKind, ObstacleSighting, ObstacleState } from '../types.js';
import type { KeyCandidate } from './keys.js';
import { reachesAgents } from './lifecycle.js';
import type { NearCandidate } from './match.js';

/**
 * The intake, as everything except the tool wrapper.
 *
 * One tool, and the discriminator is a single boolean an agent can always answer —
 * *would a fix make this go away?* Not two tools: an agent choosing a shelf is an
 * agent choosing wrongly, which `docs/spec/27-knowledge.md` established at the cost
 * of finding out.
 *
 * Pure — no I/O, no clock, no store. → `docs/spec/32-obstacles.md#the-intake`
 */

/** How many prior sightings a standing row hands back. */
const OTHERS_SHOWN = 3;

/** The kinds an agent may name a key as. Anything else is dropped, never refused. */
const KEY_KINDS: ReadonlySet<string> = new Set<ObstacleKeyKind>(['check', 'test', 'path', 'signature', 'cmd']);

/** One report, validated at the boundary and nowhere else. */
interface RaisedObstacle {
  /** The reporter's own answer to whether this stops it finishing. Default false. */
  blocksMe: boolean;
  /** The claim, with the reporter's own frame stripped out of it. */
  what: string;
  /** The reporter's sentence exactly as it arrived, kept as the sighting's words. */
  words: string;
  /** Required, unvalidated, and read by nobody but an operator. */
  whyNotMine: string;
  /** What the agent named itself. It goes through the same three gates. */
  keys: KeyCandidate[];
  /** The reporter's clock, in hours. Null for most reports. */
  untilHours: number | null;
}

/**
 * Read one call.
 *
 * **`why_not_mine` is required and nothing reads it.** Asking the question is the
 * intervention: an agent that has to write down why this is not its doing checks
 * before it answers, and the sentence is what an operator reads later when the
 * routing turns out wrong. A field the harness validated would be a field the agent
 * games.
 *
 * A malformed `keys` entry is **dropped and the report kept**, which is the same
 * rule the three gates follow and for the same reason: a refusal an agent cannot
 * satisfy is a report that was never filed.
 */
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
  // The agent's own frame, out of the claim. *"test X is flaky and nothing to do
  // with PR 512"* is written for the reader of PR 512, which is the one place the
  // claim will never be needed again — and the ref inside it is what no other
  // agent's wording can match. The original sentence is kept verbatim beside it.
  const framed = stripOwnFrame(what, goalRef);
  return {
    ok: true,
    report: {
      what: framed.claim,
      words: what,
      whyNotMine,
      keys: parseKeyCandidates(args.keys),
      untilHours: typeof until === 'number' ? until : null,
      // Not validated and not second-guessed: whether this stops *this* task is a
      // fact about the task, which the harness has no reading of. Anything but an
      // explicit true is false, so an agent that says nothing carries on.
      blocksMe: args.blocks_me === true,
    },
  };
}

/**
 * `["check:test (windows)", "path/src/x.ts"]` → candidates, dropping what is not
 * one.
 *
 * Shared with the model desk rather than copied, because **every gate a model's
 * output passes is the same gate an agent's report passes**: a second reader of
 * the same spelling is a second thing to be wrong about, and the one that drifted
 * would be the one nothing tests.
 */
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

/**
 * The file an agent is trying to report as somebody else's, which its own session
 * wrote.
 *
 * This is the only enforcement of *an agent fixes what its own session broke and
 * nothing else* that is not a sentence in a prompt, and a sentence in a prompt is
 * not an enforcement. The harness holds the diff already (`src/fileOverlap.ts`
 * reads the same rows), so nothing is asked of the agent.
 */
export function ownBreakage(keys: readonly KeyCandidate[], ownPaths: readonly string[]): string | null {
  const own = new Set(ownPaths.map((p) => p.toLowerCase()));
  for (const key of keys) {
    if (key.kind !== 'path' && key.kind !== 'test') continue;
    const file = key.value.split(/[\s>#]|::/)[0]!.toLowerCase();
    if (own.has(file)) return key.value.split(/[\s>#]|::/)[0]!;
  }
  return null;
}

/**
 * The one imperative sentence, chosen by the harness and never by the agent.
 *
 * The point of the tool answering at all is that the agent does not have to decide
 * what its own report means. It is in pain, it called something, and what comes
 * back tells it what to do with the next ten turns.
 */
function directiveFor(state: ObstacleState, ownerRef: string | null, blocksMe: boolean): string {
  // First, because it is about the *reporter's* own task rather than about the
  // row: an agent that cannot finish is not helped by "return to your task", and
  // telling it to carry on makes it spin. It is the one thing here the harness
  // cannot judge for itself — whether this stops *this* task is a fact about the
  // task — so the agent says it, exactly as it says whether a fix would end the
  // thing. → `docs/spec/32-obstacles.md#blocked-is-an-answer`
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

/** What the pain call answers with. Reporting *is* the lookup — there is no search tool. */
interface ObstacleLookup {
  status: ObstacleState;
  /** How many independent voices have said it, this one included. */
  seen_by: number;
  owner: string | null;
  directive: string;
  /** Prior sightings in their authors' own words, or empty while the row is `sighted`. */
  what_others_saw: string[];
  /** Rows a suggestion linked but no key merged, so the agent may agree by id. */
  near: { id: string; what: string }[];
}

/**
 * Answer one report.
 *
 * **`what_others_saw` is withheld on a row that is not already standing**, and the
 * reason is not politeness: a second agent shown the first's sentence and then
 * counted as agreeing with it is not independent evidence, and the count cannot see
 * the difference. The promotion to `standing` is what unlocks them, and by then the
 * two voices that carried it there were independent.
 */
export function lookupFor(input: {
  obstacle: Obstacle;
  voices: number;
  sightings: readonly ObstacleSighting[];
  /** The sighting this call just wrote, which is never one of the others. */
  mine: string | null;
  near: readonly NearCandidate[];
  /** The reporter saying this stops it finishing — its own answer, about its own task. */
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
