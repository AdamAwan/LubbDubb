import type { GoalEnvironmentReachView, GoalGroupReach, GoalWatchView } from '../types.js';
import type { GoalPageView, GoalPartView, GoalTrack, PartGroup } from './goalPage.js';
import { inFlight, localValidationSaid } from './localValidation.js';

// → docs/spec/17-cockpit.md

export function buildGoalTrack(parts: readonly GoalPartView[]): GoalTrack {
  const count = (g: PartGroup) => parts.filter((p) => p.group === g).length;
  return {
    merged: count('merged'),
    now: count('now'),
    held: count('held'),
    waiting: count('waiting'),
    total: parts.length,
  };
}

export type GoalStageTone = 'green' | 'blue' | 'amber' | 'grey';

export interface GoalStage {
  reading: string;
  tone: GoalStageTone;
  done: number | null;
}

export function planStage(page: GoalPageView): GoalStage {
  /* A pull request waiting on the operator outranks how far the plan has got,
     because it is the one reading on this stage that is about them. The tab row
     said it and the track did not, and folding the two into one control is how a
     reading gets lost — so it is said here, where both now read from. */
  const court = page.openPullRequests.filter((pr) => pr.attention.status === 'you').length;
  if (court > 0) {
    return { reading: court === 1 ? '1 in your court' : `${court} in your court`, tone: 'amber', done: null };
  }
  if (page.plan === null) return { reading: 'not drawn', tone: 'grey', done: null };
  if (page.plan.status === 'planning') return { reading: 'being drawn', tone: 'blue', done: null };
  if (page.plan.status === 'awaiting_approval') return { reading: 'waiting on you', tone: 'amber', done: null };
  if (page.plan.status === 'abandoned') return { reading: 'abandoned', tone: 'grey', done: null };

  const track = buildGoalTrack(page.parts);
  if (track.total === 0) return { reading: 'one pull request', tone: 'grey', done: null };
  return {
    reading: `${track.merged}/${track.total} parts merged`,
    tone: track.merged === track.total ? 'green' : track.held > 0 ? 'amber' : track.now > 0 ? 'blue' : 'grey',
    done: (track.merged / track.total) * 100,
  };
}

export function validationStage(page: GoalPageView): GoalStage {
  /* A local check plan that is running outranks the set's own count, because it
     is the only thing on the goal that is happening right now — and with the
     header's chip gone this is the one place outside the pane that says so. */
  const local = page.issue.localValidation;
  if (local !== null && inFlight(local)) {
    return { reading: localValidationSaid(local), tone: 'blue', done: null };
  }
  const v = page.issue.validation;
  if (v === null || v.total === 0) {
    if (flaggedLocally(page)) return { reading: 'flagged locally', tone: 'amber', done: null };
    return { reading: 'no checks', tone: 'grey', done: null };
  }
  const settled = v.passed + v.waived;
  return {
    reading: `${settled} of ${v.total} done`,
    tone: v.state === 'clear' ? 'green' : v.failed > 0 ? 'amber' : 'blue',
    done: (settled / v.total) * 100,
  };
}

/**
 * One place the goal's work can be. A declared group stands for its members and an
 * environment in none stands for itself, in the order the environments are configured — so
 * three regions of production are one reading here rather than three, exactly as they are
 * one reading to the gate that waits on them.
 *
 * It computes no verdict: a group's status is the roll-up the server already shipped.
 * → docs/spec/24-environments.md#groups
 *
 * @public the seam the Environments card and the close-out's reading are drawn from
 */
export interface GoalReachBand {
  name: string;
  environments: string[];
  status: GoalEnvironmentReachView['status'];
  landed: number;
  total: number;
  grouped: boolean;
}

export function reachBands(page: GoalPageView): GoalReachBand[] {
  const byMember = new Map<string, GoalGroupReach>();
  for (const group of page.groups) for (const name of group.environments) byMember.set(name, group);
  const out: GoalReachBand[] = [];
  const drawn = new Set<string>();
  for (const env of page.environments) {
    const group = byMember.get(env.environment);
    if (group === undefined) {
      out.push({
        name: env.environment,
        environments: [env.environment],
        status: env.status,
        landed: env.landed,
        total: env.total,
        grouped: false,
      });
      continue;
    }
    if (drawn.has(group.group)) continue;
    drawn.add(group.group);
    out.push({
      name: group.group,
      environments: group.environments,
      status: group.status,
      landed: group.landed,
      total: group.total,
      grouped: true,
    });
  }
  return out;
}

/**
 * What the close-out is waiting on. It reads the delivery and the tail first — the obligation
 * this tab *is* — and falls back to the reach the close is owed against, because a goal that
 * has arrived nowhere is not a goal whose close-out is outstanding, it is one whose close-out
 * cannot be asked for yet. → docs/spec/24-environments.md#the-bench-asks-for-one-thing-at-a-time
 */
export function closeStage(page: GoalPageView): GoalStage {
  const { issue } = page;
  if (issue.state !== 'open') return { reading: issue.state, tone: 'green', done: 100 };
  if (issue.shortfall) return { reading: 'fell short', tone: 'amber', done: null };
  /* What wants a person outranks how far the work got: a held gate is the operator's to
     release, and nothing is filed while it holds. */
  if (page.gateHold !== null) return { reading: 'gate held', tone: 'amber', done: null };
  if (issue.delivery) return { reading: 'delivered, ticket open', tone: 'blue', done: null };
  return reachStage(page);
}

/* Counted in places rather than in commands: a goal that has reached one region of production
   has not reached production. → docs/spec/24-environments.md#groups */
function reachStage(page: GoalPageView): GoalStage {
  const envs = reachBands(page);
  if (envs.length === 0) return { reading: 'not reached', tone: 'grey', done: null };
  const reached = envs.filter((e) => e.status === 'reached');
  const furthest = reached[reached.length - 1];
  if (furthest !== undefined) {
    return {
      reading: `reached ${furthest.name}`,
      tone: reached.length === envs.length ? 'green' : 'blue',
      /* The only denominator here that cannot grow: the environments are configuration,
         not plan. `total` below is `landings + unattributed + partsOwed`, so a meter drawn
         against it moves *backwards* the moment the plan decomposes further. */
      done: (reached.length / envs.length) * 100,
    };
  }
  /* Nothing has arrived, so there is nothing to check and nothing failing. A fraction here
     would read as a part-checked goal; what is true is that the goal is not checkable yet,
     and what an operator needs is what is still owed before it can be. */
  const partial = envs.find((e) => e.status === 'partial');
  if (partial !== undefined) {
    const owed = partial.total - partial.landed;
    return {
      /* Short enough to survive the tab's own width: the row ellipsizes, and a reading
         cut off mid-word is the reading lost. What it is owed *for* is the card below. */
      reading: owed === 1 ? '1 landing owed' : `${owed} landings owed`,
      tone: 'grey',
      done: null,
    };
  }
  if (envs.some((e) => e.status === 'unknown')) return { reading: 'not known', tone: 'grey', done: null };
  return { reading: 'not shipped', tone: 'grey', done: null };
}

/**
 * The Watch tab's reading: the windows this deployment's watched environments opened, each
 * folded by {@link watchFold} and the worst of them taken. A goal with no window open yet reads
 * what is true of the signals instead — a window that never opened and one that opened and read
 * nothing are different answers. → docs/spec/17-cockpit.md#the-panes
 */
export function watchStage(page: GoalPageView): GoalStage {
  const windows = page.watches.filter((w) => page.obligations.watch.includes(w.environment));
  const open = windows.filter((w) => w.checks.length > 0);
  if (open.length === 0) {
    const pending = page.signals.filter((s) => !s.live || s.proposal !== null).length;
    if (pending > 0) return { reading: `${pending} awaiting you`, tone: 'amber', done: null };
    if (page.signals.length === 0) return { reading: 'no signals', tone: 'grey', done: null };
    return { reading: 'not opened', tone: 'grey', done: null };
  }
  const said = open.map(watchFold);
  if (said.includes('regressed')) return { reading: 'regressed', tone: 'amber', done: null };
  if (said.some((s) => s !== 'clean')) return { reading: 'not read', tone: 'blue', done: null };
  const settled = open.every((w) => w.settledAt !== null);
  return { reading: settled ? 'clean' : 'clean so far', tone: 'green', done: settled ? 100 : null };
}

/**
 * One window's every check, folded to a word. The reduction is one-directional and that is the
 * whole of the care here: `regressed` first, then anything not `clean` reads *not read*, and only
 * a window whose every check came back clean says so. A reading with space for one word must never
 * fold an unread environment into an all-clear. → docs/spec/29-post-deploy-watch.md#in-the-cockpit
 */
function watchFold(window: GoalWatchView): 'regressed' | 'not read' | 'clean' {
  const verdicts = window.checks.map((c) => c.reading?.verdict ?? null);
  if (verdicts.includes('regressed')) return 'regressed';
  if (verdicts.some((v) => v !== 'clean')) return 'not read';
  return 'clean';
}

/* The ticket is the only entry with no stage behind it: nothing about it
   progresses, so it reads what was asked for rather than how far it has got. */
export function ticketReading(page: GoalPageView): { reading: string; tone: GoalStageTone; done: number | null } {
  const instructions = page.issue.instructions.length;
  if (instructions > 0) {
    return { reading: instructions === 1 ? '1 instruction' : `${instructions} instructions`, tone: 'blue', done: null };
  }
  return { reading: 'as filed', tone: 'grey', done: null };
}

export function flaggedLocally(page: GoalPageView): boolean {
  const local = page.issue.localValidation;
  return local !== null && (local.status === 'failed' || local.status === 'blocked');
}
