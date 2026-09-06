import type {
  GoalLanding,
  Obstacle,
  ObstacleCondition,
  ObstacleStanding,
  ObstacleWriteUpOutcome,
  PullRequest,
  WorkNode,
} from '../types.js';
import { reachesAgents } from './lifecycle.js';

/**
 * How an obstacle ends: a condition the harness can evaluate, the owner
 * landing (read off the landing sweep, never the merge), a clock as backstop
 * only, and decay for everything else. Pure.
 * → `docs/spec/27-obstacles.md#how-an-obstacle-ends`
 */

/** A condition the harness is about to promise to watch, before it has an id. */
interface ConditionToWatch {
  obstacleId: string;
  kind: 'check-green';
  checkName: string;
  branch: string;
}

/**
 * The conditions the harness can promise to watch for this board, right now.
 * One kind: the named check going green on the named branch. Only rows that
 * reach agents, and only obstacles — a note ends by being written down.
 */
export function conditionsToWatch(
  board: readonly ObstacleStanding[],
  openPrs: readonly PullRequest[],
): ConditionToWatch[] {
  const out: ConditionToWatch[] = [];
  for (const row of board) {
    if (row.obstacle.kind !== 'obstacle' || !reachesAgents(row.obstacle.state)) continue;
    const names = new Set(row.keys.filter((key) => key.kind === 'check' && key.binds).map((key) => key.value));
    if (names.size === 0) continue;
    for (const pr of openPrs) {
      for (const check of pr.ciChecks ?? []) {
        if (check.status !== 'failing' || !names.has(check.name)) continue;
        out.push({ obstacleId: row.obstacle.id, kind: 'check-green', checkName: check.name, branch: pr.branch });
      }
    }
  }
  return out;
}

/**
 * Whether one condition is met: is this check still failing on that branch?
 * Met by going green, by no longer being reported, or by the PR leaving the
 * open set. `pending` does not meet it, nor does `ciChecks` absent — no
 * detail and no longer reported must not fold together.
 * (`docs/spec/24-environments.md#the-three-verdicts`)
 */
export function conditionMet(condition: ObstacleCondition, openPrs: readonly PullRequest[]): boolean {
  const pr = openPrs.find((candidate) => candidate.branch === condition.branch);
  if (pr === undefined) return true;
  if (pr.ciChecks === undefined) return false;
  const check = pr.ciChecks.find((candidate) => candidate.name === condition.checkName);
  if (check === undefined) return true;
  return check.status === 'passing';
}

/**
 * Whether every condition on a row is met, and there is at least one. Every,
 * not any — an obstacle red on two branches is not over when one goes green.
 */
export function conditionsSettled(conditions: readonly ObstacleCondition[], openPrs: readonly PullRequest[]): boolean {
  return conditions.length > 0 && conditions.every((condition) => conditionMet(condition, openPrs));
}

/**
 * Whether the row's own owner has landed — off the landing sweep, never the
 * merge, since the merge SHA has a `closedPrWindowMs` shelf life. Only
 * ticket owners are reachable this way; a repair dispatch owns as
 * `obstacle:<id>`, which is no goal, and ends on its condition, the clock or
 * decay. (`docs/spec/24-environments.md#recording-a-landing`)
 */
export function ownerLanded(obstacle: Obstacle, landings: readonly GoalLanding[]): boolean {
  if (obstacle.ownerRef === null) return false;
  return landings.some((landing) => landing.goalRef === obstacle.ownerRef);
}

/**
 * Whether the reporter's own `until` has run out on a row nothing else
 * settled. A backstop, never the mechanism: an owned row is exempt, and a
 * row re-reported after its deadline has outlived the estimate, so the
 * clock stops applying — stamped once, from the first report.
 */
export function clockExpired(obstacle: Obstacle, now: number): boolean {
  if (obstacle.until === null || obstacle.ownerRef !== null) return false;
  if (obstacle.state !== 'sighted' && obstacle.state !== 'standing') return false;
  const until = Date.parse(obstacle.until);
  return until <= now && Date.parse(obstacle.lastSeenAt) < until;
}

/**
 * Whether nothing has re-reported this row inside `obstacleDormantMs`.
 * `lastSeenAt`, never `updatedAt` — every sighting stamps it, including ones
 * that move no state. An owned row never decays. Keys survive decay, so a
 * matching report reopens the row at `standing` with its history.
 */
export function decayed(obstacle: Obstacle, now: number, dormantMs: number): boolean {
  if (obstacle.ownerRef !== null) return false;
  if (obstacle.state !== 'sighted' && obstacle.state !== 'standing') return false;
  return now - Date.parse(obstacle.lastSeenAt) >= dormantMs;
}

/**
 * The notes owed a documentation change: `standing`, never written up
 * before. A note ends by being written into the tree; on merge it's
 * `resolved` and leaves every prompt. `standing` not `sighted` — one report
 * is not evidence enough to commit to the repository.
 */
export function notesToWriteUp(board: readonly ObstacleStanding[], written: ReadonlySet<string>): ObstacleStanding[] {
  return board.filter(
    (row) => row.obstacle.kind === 'note' && row.obstacle.state === 'standing' && !written.has(row.obstacle.id),
  );
}

/**
 * What became of one note's documentation change, read from the work graph
 * and never the world — the graph is upsert-only, so a write-up merged
 * during a restart is still settled. `unknown` is never folded into the
 * others: a merge known only by inference settles nothing.
 */
export function writeUpReading(jobId: string, nodes: readonly WorkNode[]): ObstacleWriteUpOutcome | 'unknown' | null {
  const jobRef = `job:${jobId}`;
  // Direct pull-request children only — one adopted further down the subtree
  // belongs to some other piece of work.
  const prs = nodes.filter((node) => node.kind === 'pr' && node.parentRef === jobRef);
  if (prs.length === 0) {
    // A job cancelled without ever opening a PR is over; anything else is
    // simply not finished yet.
    return nodes.some((node) => node.ref === jobRef && node.status === 'cancelled') ? 'abandoned' : null;
  }
  const verdicts = prs.map(prVerdict);
  if (verdicts.includes('landed')) return 'landed';
  if (verdicts.includes(null)) return null;
  if (verdicts.includes('unknown')) return 'unknown';
  return 'abandoned';
}

function prVerdict(node: WorkNode): ObstacleWriteUpOutcome | 'unknown' | null {
  if (node.status === 'merged') return node.provenance === 'observed' ? 'landed' : 'unknown';
  return node.terminal ? 'abandoned' : null;
}

/** How much of one voice's sentence rides the write-up prompt. */
const MAX_WORDS_CHARS = 1_000;

/** How many voices ride it. A note two goals said is two sentences, not a transcript. */
const MAX_VOICES = 6;

/**
 * Everything a note's documentation change is composed from: the job's
 * title, the `docs-change` template's variables, and the passage appended
 * to what that template renders. One composer for both callers; appended,
 * never interpolated, so an old template override cannot drop it.
 */
export function noteWriteUpFields(row: ObstacleStanding): {
  title: string;
  vars: Record<string, string>;
  note: string;
} {
  const claim = row.obstacle.what.replace(/\s+/g, ' ').trim();
  return {
    title: `Document: ${claim}`.slice(0, TITLE_CHARS),
    vars: { ref: keyPhrase(row), summary: claim, originRef: row.goalRefs[0] ?? 'an untracked task' },
    note: noteWriteUpNote(row),
  };
}

/** A job title stays a line. The prompt carries everything worth reading. */
const TITLE_CHARS = 80;

/**
 * What the note is *about*, as a phrase a sentence can contain — never parsed back. A
 * note with no binding keys is about working this repository at all.
 */
function keyPhrase(row: ObstacleStanding): string {
  const keys = row.keys.filter((key) => key.binds).map((key) => `\`${key.value}\``);
  return keys.length === 0 ? 'working this repository' : keys.join(', ');
}

function noteWriteUpNote(row: ObstacleStanding): string {
  const seen = row.words
    .slice(0, MAX_VOICES)
    .map((words) => `- ${words.replace(/\s+/g, ' ').trim().slice(0, MAX_WORDS_CHARS)}`);
  const more = row.words.length - seen.length;
  const keys = row.keys
    .filter((key) => key.binds)
    .map((key) => `\`${key.value}\``)
    .join(', ');
  return [
    '## This came from the fleet, and merging it is what ends it',
    '',
    'It is a **note** on the harness’s obstacle board: agents working this repository wrote down something ' +
      'true of it that the repository itself does not say, and two independent voices said it. While it is ' +
      'on the board it is put in front of every dispatch its keys match. When the pull request you open is ' +
      'merged the note leaves every prompt for good, because from then on an agent reads it here — so what ' +
      'the document ends up saying has to carry the whole of it. A thinner sentence than the ones below is ' +
      'a net loss, not a tidy-up.',
    '',
    ...(keys === '' ? [] : [`It identifies as: ${keys}.`, '']),
    `${row.voices === 1 ? 'One voice has' : `${row.voices} independent voices have`} said it. In their own words:`,
    '',
    ...seen,
    ...(more > 0 ? ['', `(${more} further ${more === 1 ? 'voice' : 'voices'} said much the same.)`] : []),
    '',
    '**Check it against the code before you write a word of it**, and if it does not hold in general, say so ' +
      'and stop. Stopping is a good outcome: it costs one dispatch and saves a false line in a document ' +
      'nothing would ever have gone red about.',
  ].join('\n');
}
