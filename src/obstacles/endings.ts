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
 * How an obstacle ends: the four endings, as the readings behind each of them.
 *
 * A row that only ever arrives is a board that only ever grows, and a board that
 * only grows is read past — which is the failure the store this replaces died of
 * from the other direction (`docs/spec/27-obstacles.md#what-went-wrong-last-time`).
 * The four are deliberately unlike each other, because each covers what the others
 * cannot see:
 *
 * - **A condition the harness can evaluate**, written by the harness and never by
 *   an agent. Settling one means reading a world object pulse after pulse, and the
 *   only party that can promise to do that is the one already reading it.
 * - **The owner landing**, read off the existing landing sweep and never off the
 *   merge itself — the merge SHA has a `closedPrWindowMs` shelf life, so a hook on
 *   the transition loses the landing to any restart that straddles it
 *   (`docs/spec/24-environments.md#recording-a-landing`).
 * - **A clock, as a backstop and never as the mechanism.** A timer alone either
 *   drops an obstacle while it is still true, and the fleet rediscovers it, or
 *   keeps one alive after the fix landed, which teaches every agent to disbelieve a
 *   check that is now genuinely broken. Both silent.
 * - **Decay**, for everything no reading and no owner ever settled.
 *
 * Pure — no I/O, no clock, no store: the world, the landings and the instant all
 * arrive as arguments. → `docs/spec/27-obstacles.md#how-an-obstacle-ends`
 */

/**
 * A condition the harness is about to promise to watch, before it has an id.
 *
 * Not exported: the desk hands one straight to `Store.watchObstacleCondition` and
 * nothing else names the shape.
 */
interface ConditionToWatch {
  obstacleId: string;
  kind: 'check-green';
  checkName: string;
  branch: string;
}

/**
 * The conditions the harness can promise to watch for this board, right now.
 *
 * One kind to start: **the named check going green on the named branch.** Both
 * halves come from the harness's own reading and neither from a sentence — the
 * check is a *binding* `check` key of the row, and the branch is one the world says
 * that check is failing on this minute. A condition naming a branch nothing is red
 * on would be a condition met the instant it was written.
 *
 * The binding half is the suggestion rule arriving here rather than a second
 * policy: a key that may not resolve an obstacle may not decide that one is over
 * either, or "does not bind" would mean *binds when convenient*.
 *
 * Only rows that reach agents, and only obstacles. A `sighted` row reaches nobody,
 * so there is nothing to end; a **note** is not a thing a check clears, and it ends
 * by being written down instead.
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
 * Whether one condition is met by this reading of the world.
 *
 * Three ways to meet it, and they are one question rather than three special
 * cases: *is this check still failing on that branch?*
 *
 * - **It went green.** The condition as written.
 * - **It stopped being reported.** A check the branch no longer runs is not a
 *   check that is red on it.
 * - **The pull request left the open set.** A branch nothing has open is a branch
 *   nothing is waiting on.
 *
 * **`pending` does not meet it**, and that is the case worth stating: a re-run in
 * flight is not a green one, and reading it as one would resolve an obstacle on
 * precisely the reading that says nobody knows yet.
 *
 * A provider reporting no per-check detail at all (`ciChecks` absent) also does not
 * meet it. That is the three-verdict discipline
 * (`docs/spec/24-environments.md#the-three-verdicts`) arriving here: *no detail*
 * and *no longer reported* fail the same way and only the second is about this
 * check, so folding them together would resolve every condition on the board of a
 * deployment that has per-check detail switched off.
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
 * Whether every condition on a row is met — and there is at least one.
 *
 * **Every**, not any. An obstacle red on two branches is not over when one of them
 * goes green, and a row resolved on a partial reading is one the fleet pays for
 * again the next time an agent hits the branch nobody looked at.
 */
export function conditionsSettled(conditions: readonly ObstacleCondition[], openPrs: readonly PullRequest[]): boolean {
  return conditions.length > 0 && conditions.every((condition) => conditionMet(condition, openPrs));
}

/**
 * Whether the row's own owner has landed.
 *
 * **Off the landing sweep, never off the merge.** `unrecordedLandings` already
 * attributes every merge it can see to the goal it was for, and it is a *sweep*
 * precisely because the merge SHA has a `closedPrWindowMs` shelf life: a hook on
 * the transition loses the landing to any restart that straddles it, or to a person
 * merging in the web UI between two pulses. Asking the recorded landings instead
 * means any pulse inside the window ends the obstacle, and the row is not left
 * `owned` for ever by a ticket that shipped while nothing was watching.
 *
 * Only the **ticket** door is reachable this way, and that is a property of the
 * sweep rather than an omission here: it files a landing under the goal root the
 * work graph walks to, which is a bare `issue:<n>`. A repair dispatch owns a row as
 * `obstacle:<id>`, which is no goal, so its own ending is the condition it was
 * dispatched against — or, failing that, the clock and the decay below.
 */
export function ownerLanded(obstacle: Obstacle, landings: readonly GoalLanding[]): boolean {
  if (obstacle.ownerRef === null) return false;
  return landings.some((landing) => landing.goalRef === obstacle.ownerRef);
}

/**
 * Whether the reporter's own clock has run out on a row nothing else settled.
 *
 * **A backstop and never the mechanism.** The intake's `until` is an agent saying
 * *I expect what I saw to last about this long*, and nothing else in the harness
 * reads that field. It expires a row no condition and no owner settled; it cannot
 * resolve one early, which is why an owned row is exempt — something is fixing it,
 * and a clock that could take the row out from under its own repair would tell
 * every agent the thing is over while the fix was still in review.
 *
 * **A row said again after its deadline has outlived the estimate**, and the clock
 * stops applying to it. The alternative is worse than useless: the deadline is
 * stamped once, from the first report, so a row that reopens after it — which is
 * exactly the fleet hitting the thing again — would be expired by the very next
 * pulse, and the re-report an agent paid a session to make would buy nothing.
 */
export function clockExpired(obstacle: Obstacle, now: number): boolean {
  if (obstacle.until === null || obstacle.ownerRef !== null) return false;
  if (obstacle.state !== 'sighted' && obstacle.state !== 'standing') return false;
  const until = Date.parse(obstacle.until);
  return until <= now && Date.parse(obstacle.lastSeenAt) < until;
}

/**
 * Whether nothing has re-reported this row inside `obstacleDormantMs`.
 *
 * `lastSeenAt` and never `updatedAt`: the store stamps it on **every** sighting,
 * including the ones that move no state, so a row re-reported daily and never
 * promoted is not dormant — and a row whose state has not changed is not a row
 * nothing has said. An owned row never decays: something is fixing it, and the
 * fleet not having hit it again is what a repair in progress looks like.
 *
 * **The keys survive**, which is the whole of why decay is safe: a matching report
 * reopens the row at `standing` with its history rather than filing a second one,
 * so a fix that did not stick is visible as a recurrence.
 */
export function decayed(obstacle: Obstacle, now: number, dormantMs: number): boolean {
  if (obstacle.ownerRef !== null) return false;
  if (obstacle.state !== 'sighted' && obstacle.state !== 'standing') return false;
  return now - Date.parse(obstacle.lastSeenAt) >= dormantMs;
}

/**
 * The notes owed a documentation change: `standing`, and never written up before.
 *
 * A note is not something a fix ends — it is something true of the repository that
 * the repository does not say — so it ends by being **written into the tree**, and
 * on merge it is `resolved` and leaves every prompt, because from then on an agent
 * reads it where it belongs. Keeping it delivered after that pays for one sentence
 * twice.
 *
 * `standing` and not `sighted`, for the reason `sighted` reaches nobody at all: one
 * report is not evidence, and committing one agent's reading to the repository
 * through an agent would be the auto-promotion this design refuses, arriving
 * through the one door that ends outside the harness.
 */
export function notesToWriteUp(board: readonly ObstacleStanding[], written: ReadonlySet<string>): ObstacleStanding[] {
  return board.filter(
    (row) => row.obstacle.kind === 'note' && row.obstacle.state === 'standing' && !written.has(row.obstacle.id),
  );
}

/**
 * What became of one note's documentation change, read from the **work graph**.
 *
 * The graph and never the world, for the sweep's own reason one step further on:
 * `closedPullRequests` forgets a merge after `closedPrWindowMs` and the graph is
 * upsert-only, so a note whose write-up merged during a restart is still settled by
 * the first pulse after it.
 *
 * **`unknown` is a verdict and is never folded into either of the others.** A pull
 * request the graph marks merged by *inference* — it vanished without ever being
 * seen closed — settles nothing: acting on it takes a note out of every prompt for
 * a change that may never have landed. Nothing here guesses, and an unsettled note
 * decays like any other row.
 */
export function writeUpReading(jobId: string, nodes: readonly WorkNode[]): ObstacleWriteUpOutcome | 'unknown' | null {
  const jobRef = `job:${jobId}`;
  // The job's **direct** pull-request children, which is what the graph's fold
  // produces. Not the whole subtree: a pull request adopted further down belongs to
  // some other piece of work.
  const prs = nodes.filter((node) => node.kind === 'pr' && node.parentRef === jobRef);
  if (prs.length === 0) {
    // A job cancelled without ever opening a pull request is over. Anything else —
    // queued, dispatched, an agent still writing — is simply not finished yet, and
    // a documentation job with no pull request means nothing happened, which the
    // template says in as many words.
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
 * Everything a note's documentation change is composed from: the job's title, the
 * `docs-change` template's variables, and the passage **appended** to what that
 * template renders.
 *
 * One composer rather than one per caller, because there are two — the endings
 * desk on the pulse, and an operator's *write it down* on the cockpit's own token
 * — and a note written up two ways is two documents claiming to be the fleet's one
 * statement of the same thing. The rendering itself stays with each caller,
 * because the template book is the deployment's.
 *
 * Appended and never interpolated, which is CLAUDE.md's rule under "Prompts and
 * templates": `loadPromptTemplates` rejects only *unknown* placeholders, so an
 * override written before this existed would silently drop a new `{token}` — on
 * exactly the deployments that customised most.
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
 * What the note is *about*, said as a phrase a sentence can contain — never parsed
 * back. Its binding keys are the harness’s own statement of that, and a note with
 * none is about working this repository at all.
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
