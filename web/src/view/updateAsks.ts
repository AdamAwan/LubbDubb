import type { AppState, BuildReading } from '../types.js';
import type { NeedRow } from './needsYou.js';

// → docs/spec/17-cockpit.md

function snoozed(until: string | null, nowIso: string): boolean {
  if (until === null) return false;
  const at = Date.parse(until);
  return !Number.isNaN(at) && at > Date.parse(nowIso);
}

/**
 * What state the upgrade is in, in words rather than a status word.
 *
 * The intent outranks the standing, for {@link buildReading}'s reason: an operator
 * who asked to drain wants to know what is left, not a restatement of how far
 * behind they were when they asked.
 *
 * @public the build panel draws this as its headline; the rail draws it as a row.
 */
export function upgradeHeadline(build: BuildReading): string {
  const { standing, intent, live } = build;
  if (intent.state === 'applying') return 'Going down for the upgrade';
  if (intent.state === 'ready') return 'Ready to upgrade — nothing is running';
  if (intent.state === 'draining')
    return live > 0
      ? `Draining — waiting for ${live} agent${live === 1 ? '' : 's'} to finish`
      : 'Draining — the fleet is clear';
  if (standing.unavailable) return 'This build cannot be checked';
  if (standing.behind === 0) return 'This build is current';
  const commits = `${standing.behind} commit${standing.behind === 1 ? '' : 's'} waiting`;
  return live === 0 ? `${commits} — nothing is running, so this would apply now` : commits;
}

/**
 * The project checkout named the way an operator names it: the last segment of
 * `repoRoot`.
 *
 * Not the remote's `owner/repo`, which the cockpit is not shipped. The folder is
 * what an operator typed to get there and what their terminal prompt says, and a
 * row that has to name a repository is better naming it wrongly-shortened than not
 * at all.
 *
 * @public the build panel names the same checkout in its project section, and two
 * ways of shortening one path is two names for one thing.
 */
export function projectName(state: AppState): string {
  const segments = state.config.desktopFolder.split(/[\\/]/).filter((s) => s !== '');
  return segments[segments.length - 1] ?? 'the project';
}

function projectPullLine(state: AppState, blocked: string): string {
  const reason = blocked.replace(/^the project checkout /, '');
  return `Auto-pull is disabled for ${projectName(state)} because the checkout ${reason}`;
}

function behindSince(build: BuildReading): string {
  const commits = build.standing.commits;
  return commits.length === 0 ? build.standing.checkedAt : (commits[commits.length - 1]?.authoredAt ?? '');
}

/**
 * The rail's update rows. Zero, one or two.
 *
 * Both are `yours`, never `blocking`: nothing is parked and no slot is held. The
 * group is strictly about a held slot, and widening it for how much an operator
 * ought to do would cost it the only thing it means.
 *
 * @public merged into the queue by `buildNeedsYou`.
 */
export function updateAskRows(state: AppState, nowIso: string): NeedRow[] {
  const build = state.build;
  const rows: NeedRow[] = [];

  if (build.upgradable && !snoozed(build.snoozedUntil.upgrade, nowIso)) {
    rows.push({
      id: 'upgrade',
      kind: 'upgrade',
      group: 'yours',
      title: upgradeHeadline(build),
      goalRef: null,
      originRef: null,
      opens: 'build',
      agentId: null,
      agentLabel: null,
      holding: 0,
      raisedAt: behindSince(build),
    });
  }

  const projectBlocked = build.projectPull.blocked;
  if (
    build.projectAutoPull &&
    build.project !== null &&
    build.project.behind > 0 &&
    !build.projectPull.can &&
    projectBlocked !== null &&
    !snoozed(build.snoozedUntil.projectPull, nowIso)
  ) {
    rows.push({
      id: 'project-pull',
      kind: 'project_pull',
      group: 'yours',
      title: projectPullLine(state, projectBlocked),
      goalRef: null,
      originRef: null,
      opens: 'build',
      agentId: null,
      agentLabel: null,
      holding: 0,
      raisedAt: build.project.checkedAt,
    });
  }

  return rows;
}
