import type { AppState, BuildReading } from '../types.js';
import type { NeedRow } from './needsYou.js';

/**
 * The two update asks, as rail rows — and the wording both they and the build
 * panel say them in.
 *
 * **Why the rail rather than the Overview's cards.** Upgrading is a request made
 * of the operator: no rule in the harness will ever answer it, which is the whole
 * membership test for `Needs you`. The cards said it on a surface an operator
 * *visits*, and being behind persists for weeks if nobody looks — so the deployment
 * furthest behind was the one whose card had been furniture the longest.
 *
 * **What keeps them out of the standing-condition trap** the cards were right about
 * is that each is raised at a moment and settles when answered. The upgrade ask
 * appears when there is something takeable and goes when it is taken or snoozed;
 * the project ask appears only where an auto-pull the harness would otherwise have
 * done on its own is refused, and clears itself the moment whatever is in the way
 * moves — no answer required.
 *
 * The wording lives here rather than in either surface because both say it: the
 * rail row and the panel headline are one sentence about one fact, and two copies
 * of it are two things to keep in step.
 * → docs/spec/21-self-update.md, docs/spec/17-cockpit.md
 */

/** Whether an ask is currently hidden by the operator's Snooze. */
function snoozed(until: string | null, nowIso: string): boolean {
  if (until === null) return false;
  const at = Date.parse(until);
  // An unparseable stamp reads as *not* snoozed. The safe direction is the one
  // that shows the ask: a hidden row nobody can un-hide is the failure this
  // queue exists to avoid.
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
  // The one clause worth adding to the count, because it is what decides which
  // control to press: with nothing running there is no drain to sit through, and
  // the row collapses to a single act.
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
 */
function projectName(state: AppState): string {
  const segments = state.config.desktopFolder.split(/[\\/]/).filter((s) => s !== '');
  return segments[segments.length - 1] ?? 'the project';
}

/**
 * Why the harness is not pulling the project checkout itself, in one line.
 *
 * The reason is `projectPullability`'s own sentence, quoted rather than re-derived
 * — it words all four refusals (dirty, wrong branch, ahead, unreadable) already,
 * and a second wording here would be a fifth version to keep in step. What this
 * adds is the subject: the operator has two checkouts and the sentence names
 * neither.
 */
function projectPullLine(state: AppState, blocked: string): string {
  // Its own sentence starts "the project checkout …", which reads as a stutter
  // after "for LubbDubb because". Trimmed to what follows it.
  const reason = blocked.replace(/^the project checkout /, '');
  return `Auto-pull is disabled for ${projectName(state)} because the checkout ${reason}`;
}

/**
 * When the upgrade ask reads as having been raised.
 *
 * The oldest commit the reading carries, so the row's age chip says how long this
 * deployment has been behind rather than when the check last ran — which is the
 * one number that separates a deployment a morning behind from one nobody has
 * touched since August, and the only reason a queue row for this is worth drawing.
 *
 * The list is capped at ten by the reading, so on a long-neglected build this is
 * the oldest of the ten it carries and the true age is older still. Understating
 * is the right direction: the row never claims an age the reading cannot show.
 */
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

  // The upgrade ask. Keyed on `upgradable`, which is the server's own verdict on
  // whether there is anything takeable — never on `behind > 0`, which is true of
  // a build whose install directory is dirty and whose upgrade would be refused.
  // A row offering an act the server will decline is worse than no row.
  if (build.upgradable && !snoozed(build.snoozedUntil.upgrade, nowIso)) {
    rows.push({
      id: 'upgrade',
      kind: 'upgrade',
      group: 'yours',
      title: upgradeHeadline(build),
      goalRef: null,
      originRef: null,
      // The build panel, which is where the changelog is — the row is a second and
      // far more reachable door to the surface that already answers *what changed*,
      // not a replacement for it.
      opens: 'build',
      agentId: null,
      agentLabel: null,
      holding: 0,
      raisedAt: behindSince(build),
    });
  }

  // The project ask, which exists only where the harness would have pulled and
  // could not. With auto-pull off there is nothing to report: a deployment that
  // pulls by hand has already decided that, and a daily row saying so would be the
  // harness reporting the operator's own decision back to them as news.
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
      // The reading's own stamp, and not the oldest commit's: what this row is
      // about is the *obstruction*, which the harness noticed when it looked, and
      // an age taken from a commit would date the row to somebody else's push.
      raisedAt: build.project.checkedAt,
    });
  }

  return rows;
}
