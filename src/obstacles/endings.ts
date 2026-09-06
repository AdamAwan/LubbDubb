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

// → docs/spec/27-obstacles.md

interface ConditionToWatch {
  obstacleId: string;
  kind: 'check-green';
  checkName: string;
  branch: string;
}

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

export function conditionMet(condition: ObstacleCondition, openPrs: readonly PullRequest[]): boolean {
  const pr = openPrs.find((candidate) => candidate.branch === condition.branch);
  if (pr === undefined) return true;
  if (pr.ciChecks === undefined) return false;
  const check = pr.ciChecks.find((candidate) => candidate.name === condition.checkName);
  if (check === undefined) return true;
  return check.status === 'passing';
}

export function conditionsSettled(conditions: readonly ObstacleCondition[], openPrs: readonly PullRequest[]): boolean {
  return conditions.length > 0 && conditions.every((condition) => conditionMet(condition, openPrs));
}

export function ownerLanded(obstacle: Obstacle, landings: readonly GoalLanding[]): boolean {
  if (obstacle.ownerRef === null) return false;
  return landings.some((landing) => landing.goalRef === obstacle.ownerRef);
}

export function clockExpired(obstacle: Obstacle, now: number): boolean {
  if (obstacle.until === null || obstacle.ownerRef !== null) return false;
  if (obstacle.state !== 'sighted' && obstacle.state !== 'standing') return false;
  const until = Date.parse(obstacle.until);
  return until <= now && Date.parse(obstacle.lastSeenAt) < until;
}

export function decayed(obstacle: Obstacle, now: number, dormantMs: number): boolean {
  if (obstacle.ownerRef !== null) return false;
  if (obstacle.state !== 'sighted' && obstacle.state !== 'standing') return false;
  return now - Date.parse(obstacle.lastSeenAt) >= dormantMs;
}

export function notesToWriteUp(board: readonly ObstacleStanding[], written: ReadonlySet<string>): ObstacleStanding[] {
  return board.filter(
    (row) => row.obstacle.kind === 'note' && row.obstacle.state === 'standing' && !written.has(row.obstacle.id),
  );
}

export function writeUpReading(jobId: string, nodes: readonly WorkNode[]): ObstacleWriteUpOutcome | 'unknown' | null {
  const jobRef = `job:${jobId}`;
  const prs = nodes.filter((node) => node.kind === 'pr' && node.parentRef === jobRef);
  if (prs.length === 0) {
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

const MAX_WORDS_CHARS = 1_000;

const MAX_VOICES = 6;

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

const TITLE_CHARS = 80;

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
