import type { Obstacle, ObstacleKey } from '../types.js';
import { reachesAgents } from './lifecycle.js';

/**
 * The first of the two channels: **at dispatch, scoped to the keys**.
 *
 * The obstacles whose keys intersect this dispatch — the checks it is about, the
 * paths its goal touches — go into the task prompt. Everything here is keyed, and
 * a keyed thing is delivered to the dispatches it is about; there is no
 * fleet-wide block, because blanket context is the wrong instrument at the sizes
 * this harness runs against.
 *
 * **Appended to the rendered prompt, never interpolated.** `loadPromptTemplates`
 * rejects only *unknown* placeholders, so an override written before this existed
 * would silently drop an `{obstacles}` token — on exactly the deployments that
 * customised most (`docs/spec/05-dispatcher.md#prompt-templates`).
 *
 * Pure — no I/O, no clock, no store: what the board holds and what the dispatch is
 * about both arrive as arguments. → `docs/spec/27-obstacles.md#delivery`
 */

/** One row as delivery reads it: the claim, and the ways into it. */
export interface DeliverableObstacle {
  obstacle: Obstacle;
  keys: readonly ObstacleKey[];
}

/** The budget for the whole note, header and drop line included. */
const MAX_OBSTACLE_CHARS = 1_400;

/**
 * The obstacles this dispatch is about.
 *
 * **Only rows that reach agents.** `reachesAgents` is the lifecycle's own
 * spelling of *standing or owned*, asked here rather than restated, so the states
 * that reach a prompt and the states the intake answers `it is not yours` on
 * cannot drift. A `sighted` row reaches nobody — one report is not evidence, and
 * it is the case the harness cannot tell apart from an agent mis-diagnosing its
 * own breakage.
 *
 * **`scopes` is `dispatchFactScopes`' answer and never a second computation of
 * it** (`src/knowledge/block.ts`). It is the existing reading of *which scopes
 * this dispatch matches*, so the scope a row is delivered on and the scope it is
 * judged against are one reading rather than two that agree today. `paths` is the
 * other half the document names — what the goal has actually touched, which is
 * `Store.listGoalFiles`, the same list the intake grounds a key against.
 *
 * A `signature` or a `cmd` key delivers nothing, and that is the suggestion rule
 * arriving here rather than a second policy: a key that may not resolve an
 * obstacle may not decide who is told about one either.
 */
export function obstaclesForDispatch(input: {
  rows: readonly DeliverableObstacle[];
  scopes: readonly string[];
  paths: readonly string[];
}): DeliverableObstacle[] {
  const scopes = new Set(input.scopes);
  const paths = new Set(input.paths.map((path) => path.toLowerCase()));
  return input.rows.filter(
    (row) => reachesAgents(row.obstacle.state) && row.keys.some((key) => keyMatches(key, scopes, paths)),
  );
}

/** Whether one key puts its row in front of a dispatch with these scopes and files. */
function keyMatches(key: ObstacleKey, scopes: ReadonlySet<string>, paths: ReadonlySet<string>): boolean {
  // Exact and never a prefix, which is `priorRemedies`' choice and the same
  // fragility accepted for the same reason: a check name is a provider
  // identifier, and a prefix match puts another job's history in front of an
  // agent under a name it reads as its own.
  if (key.kind === 'check') return scopes.has(`check:${key.value}`);
  if (key.kind === 'test' || key.kind === 'path') return paths.has(fileHalf(key.value).toLowerCase());
  return false;
}

/** The file half of a `test` key, which for a `path` key is the whole of it. */
function fileHalf(value: string): string {
  return value.split(/[\s>#]|::/)[0] ?? value;
}

/**
 * What the dispatch is told, or `''` when the board says nothing about it — which
 * is most dispatches, and then the prompt is byte-identical to a build without
 * this.
 *
 * It frames what follows as **something already known and already handled**
 * rather than as work: the whole saving is the agent not spending ten turns
 * rediscovering it, and an agent that reads this list as a task list has been
 * given the fleet's obstacles to fix. The directives the intake answers with say
 * the same thing in the same words, because an agent that reads one here and a
 * different one from the tool has two harnesses talking to it.
 *
 * Bounded and **saying what it dropped**, for the knowledge note's reason: an
 * agent that reads a partial record as a whole one concludes something from an
 * absence that was merely trimmed.
 */
export function renderObstacleNote(rows: readonly DeliverableObstacle[]): string {
  if (rows.length === 0) return '';
  const header =
    `\n\n---\n\nWhat the fleet has already hit on the checks and files in front of you. Each of these was ` +
    `seen by **two independent voices**, so it is not your doing and not your task: do not go fixing one. ` +
    `Work around it, and say so in what you conclude. If you hit something that is *not* here, report it ` +
    `with \`raise\` — one call, and it answers with what everyone else saw.\n\n`;

  const lines: string[] = [];
  let used = header.length;
  let cut = rows.length;
  for (const [i, row] of rows.entries()) {
    const line = renderObstacle(row);
    // The prefix that fits, not the subset that fits — the block's rule, and the
    // order is the store's: newest-seen first, so what a cap cuts is the stalest.
    if (used + line.length > MAX_OBSTACLE_CHARS) {
      cut = i;
      break;
    }
    lines.push(line);
    used += line.length;
  }
  if (lines.length === 0) return '';
  const dropped = rows.length - cut;
  const tail =
    dropped > 0
      ? `\n${dropped} further obstacle${dropped === 1 ? '' : 's'} on these checks and files ${
          dropped === 1 ? 'is' : 'are'
        } not shown.\n`
      : '';
  return header + lines.join('') + tail;
}

/**
 * One obstacle: the claim, the ways in, and who has it.
 *
 * The keys are on the line because they are what an agent matches its own
 * symptom against — a claim in somebody else's words is exactly what this store
 * exists because agents cannot match on.
 */
function renderObstacle(row: DeliverableObstacle): string {
  const claim = row.obstacle.what.replace(/\s+/g, ' ').trim();
  const keys = row.keys
    .filter((key) => key.kind === 'check' || key.kind === 'test' || key.kind === 'path')
    .map((key) => `\`${key.value}\``)
    .join(', ');
  const owner =
    row.obstacle.state === 'owned' && row.obstacle.ownerRef !== null
      ? ` — ${row.obstacle.ownerRef} owns it`
      : ' — nothing owns it yet';
  return `- ${claim}${keys === '' ? '' : ` (${keys})`}${owner}\n`;
}
