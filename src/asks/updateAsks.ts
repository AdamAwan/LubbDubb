import type { BuildReading } from '../selfUpdate/upgradePlan.js';
import type { AskDraft, AskInputs } from './queue.js';

// → docs/spec/17-cockpit.md#the-queue-rail--needs-you

function snoozed(until: string | null, nowIso: string): boolean {
  if (until === null) return false;
  const at = Date.parse(until);
  return !Number.isNaN(at) && at > Date.parse(nowIso);
}

/**
 * What state the upgrade is in, in words. The intent outranks the standing: an operator who asked
 * to drain wants to know what is left.
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
 * The project checkout named the way an operator names it: the last segment of `repoRoot`.
 *
 * @public the build panel names the same checkout in its project section.
 */
export function projectName(state: Pick<AskInputs, 'config'>): string {
  const segments = state.config.desktopFolder.split(/[\\/]/).filter((s) => s !== '');
  return segments[segments.length - 1] ?? 'the project';
}

function projectPullLine(state: AskInputs, blocked: string): string {
  const reason = blocked.replace(/^the project checkout /, '');
  return `Auto-pull is disabled for ${projectName(state)} because the checkout ${reason}`;
}

function behindSince(build: BuildReading): string {
  const commits = build.standing.commits;
  return commits.length === 0 ? build.standing.checkedAt : (commits[commits.length - 1]?.authoredAt ?? '');
}

const BUILD_ROW = {
  group: 'yours',
  goalRef: null,
  originRef: null,
  opens: 'build',
  agentId: null,
  agentLabel: null,
  holding: 0,
} as const;

/** Zero, one or two rows, both `yours`: nothing is parked and no slot is held. */
export function updateAskRows(state: AskInputs, nowIso: string): AskDraft[] {
  const build = state.build;
  const rows: AskDraft[] = [];

  if (build.upgradable && !snoozed(build.snoozedUntil.upgrade, nowIso)) {
    rows.push({
      ...BUILD_ROW,
      id: 'upgrade',
      kind: 'upgrade',
      subject: { type: 'build', target: 'upgrade' },
      title: upgradeHeadline(build),
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
      ...BUILD_ROW,
      id: 'project-pull',
      kind: 'project_pull',
      subject: { type: 'build', target: 'project_pull' },
      title: projectPullLine(state, projectBlocked),
      raisedAt: build.project.checkedAt,
    });
  }

  return rows;
}
