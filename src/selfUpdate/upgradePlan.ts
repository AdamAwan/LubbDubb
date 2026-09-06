import type { UpgradeIntent } from '../types.js';
import type { BuildStanding } from './buildStanding.js';

// → docs/spec/21-self-update.md

export interface SelfUpdatePolicy {
  enabled: boolean;
  remote: string;
  branch: string;
  checkIntervalMs: number;
  autoUpdate: boolean;
  drainDeadlineMs: number;
  projectAutoPull: boolean;
  snoozeMs: number;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

export const IDLE_INTENT: UpgradeIntent = { state: 'idle', targetSha: null, requestedAt: null, pausedByDrain: false };

/**
 * Whether an update can be applied at all, and why not when it cannot.
 *
 * @public shipped on {@link BuildReading.projectPull}, which the build panel's
 * project section reads to decide whether to draw its Pull control and what to say
 * instead.
 */
export interface Upgradability {
  can: boolean;
  blocked: string | null;
}

export function upgradability(standing: BuildStanding, project?: BuildStanding | null): Upgradability {
  if (standing.unavailable) return { can: false, blocked: standing.unavailable };
  if (standing.behind === 0) return { can: false, blocked: 'this build is current — there is nothing to take' };
  if (standing.dirty)
    return {
      can: false,
      blocked: 'the install directory has uncommitted changes to tracked files; commit or stash them before upgrading',
    };
  if (project?.dirty === true)
    return {
      can: false,
      blocked:
        'the project checkout has uncommitted changes to tracked files — an upgrade restarts the harness and ' +
        'interrupts the agents working from it; commit or stash them first',
    };
  if (standing.ahead > 0)
    return {
      can: false,
      blocked:
        `this build carries ${plural(standing.ahead, 'commit')} of its own, so the update is not a fast-forward — ` +
        'merge or rebase it by hand',
    };
  return { can: true, blocked: null };
}

export function projectPullability(standing: BuildStanding | null, branch: string): Upgradability {
  if (standing === null) return { can: false, blocked: 'no project checkout is being watched' };
  if (standing.unavailable) return { can: false, blocked: standing.unavailable };
  if (standing.branch !== branch)
    return {
      can: false,
      blocked:
        `the project checkout is on ${standing.branch === null ? 'a detached HEAD' : standing.branch}, not ${branch} — ` +
        'a pull here would merge into that instead of fast-forwarding, so switch it by hand first',
    };
  if (standing.behind === 0)
    return { can: false, blocked: 'the project checkout is up to date — there is nothing to pull' };
  if (standing.dirty)
    return {
      can: false,
      blocked: 'the project checkout has uncommitted changes to tracked files; commit or stash them before pulling',
    };
  if (standing.ahead > 0)
    return {
      can: false,
      blocked:
        `the project checkout carries ${plural(standing.ahead, 'commit')} of its own, so the pull is not a ` +
        'fast-forward — merge or rebase it by hand',
    };
  return { can: true, blocked: null };
}

export interface BuildReading {
  state: 'unknown' | 'current' | 'behind' | 'draining' | 'ready';
  label: string;
  live: number;
  upgradable: boolean;
  blocked: string | null;
  supervised: boolean;
  standing: BuildStanding;
  intent: UpgradeIntent;
  project: BuildStanding | null;
  projectPull: Upgradability;
  projectAutoPull: boolean;
  snoozedUntil: SnoozeStamps;
}

export type SnoozeTarget = 'upgrade' | 'projectPull';

export type SnoozeStamps = Record<SnoozeTarget, string | null>;

export function buildReading(opts: {
  standing: BuildStanding;
  intent: UpgradeIntent;
  live: number;
  supervised: boolean;
  project?: BuildStanding | null;
  projectBranch?: string;
  projectAutoPull?: boolean;
  snoozedUntil?: SnoozeStamps;
}): BuildReading {
  const { standing, intent, live, supervised } = opts;
  const project = opts.project ?? null;
  const { can, blocked } = upgradability(standing, project);
  const projectPull = projectPullability(project, opts.projectBranch ?? '');
  const base = {
    live,
    upgradable: can,
    blocked,
    supervised,
    standing,
    intent,
    project,
    projectPull,
    projectAutoPull: opts.projectAutoPull ?? false,
    snoozedUntil: opts.snoozedUntil ?? NO_SNOOZE,
  };

  if (intent.state === 'draining')
    return {
      ...base,
      state: 'draining',
      label: live > 0 ? `draining ${live}` : 'draining',
    };
  if (intent.state === 'ready' || intent.state === 'applying')
    return { ...base, state: 'ready', label: intent.state === 'applying' ? 'applying' : 'ready' };
  if (standing.unavailable) return { ...base, state: 'unknown', label: 'unknown' };
  if (standing.behind === 0) return { ...base, state: 'current', label: 'current' };
  return { ...base, state: 'behind', label: `${standing.behind} behind` };
}

const NO_SNOOZE: SnoozeStamps = { upgrade: null, projectPull: null };

export type UpgradeTransition = { ok: true; intent: UpgradeIntent } | { ok: false; error: string };

export type UpgradeAction = 'drain' | 'cancel' | 'apply';

export function applyUpgradeAction(
  intent: UpgradeIntent,
  request: { action: UpgradeAction; interrupt?: boolean },
  ctx: { upgradable: Upgradability; live: number; alreadyPaused: boolean; targetSha: string | null; now: string },
): UpgradeTransition {
  const { action } = request;

  if (action === 'cancel') {
    if (intent.state === 'idle') return { ok: false, error: 'no upgrade is in progress' };
    if (intent.state === 'applying')
      return { ok: false, error: 'this process is already going down for the upgrade; it is too late to cancel' };
    return { ok: true, intent: IDLE_INTENT };
  }

  if (action === 'drain') {
    if (intent.state !== 'idle') return { ok: false, error: `an upgrade is already ${intent.state}` };
    if (!ctx.upgradable.can) return { ok: false, error: ctx.upgradable.blocked ?? 'this build cannot be upgraded' };
    return {
      ok: true,
      intent: {
        state: ctx.live > 0 ? 'draining' : 'ready',
        targetSha: ctx.targetSha,
        requestedAt: ctx.now,
        pausedByDrain: !ctx.alreadyPaused,
      },
    };
  }

  if (intent.state === 'applying') return { ok: false, error: 'the upgrade is already being applied' };
  if (!ctx.upgradable.can) return { ok: false, error: ctx.upgradable.blocked ?? 'this build cannot be upgraded' };
  if (ctx.live > 0 && !request.interrupt)
    return {
      ok: false,
      error:
        `${ctx.live} agent(s) are still running — drain first, or apply with interrupt to stop them now ` +
        '(they are restored automatically on the way back up)',
    };
  return {
    ok: true,
    intent: {
      state: 'applying',
      targetSha: intent.targetSha ?? ctx.targetSha,
      requestedAt: intent.requestedAt ?? ctx.now,
      pausedByDrain: intent.state === 'idle' ? !ctx.alreadyPaused : intent.pausedByDrain,
    },
  };
}

interface AutoStep {
  action: UpgradeAction;
  interrupt?: boolean;
  why: string;
}

export function autoUpgradeStep(ctx: {
  intent: UpgradeIntent;
  upgradable: Upgradability;
  live: number;
  supervised: boolean;
  drainDeadlineMs: number;
  drainingForMs: number | null;
}): AutoStep | null {
  if (!ctx.supervised) return null;
  if (ctx.intent.state === 'applying') return null;
  if (ctx.intent.state === 'idle') return ctx.upgradable.can ? { action: 'drain', why: 'an update is waiting' } : null;
  if (ctx.intent.state === 'ready') return { action: 'apply', why: 'the fleet is clear' };
  if (ctx.drainDeadlineMs <= 0 || ctx.drainingForMs === null) return null;
  if (ctx.drainingForMs < ctx.drainDeadlineMs) return null;
  return {
    action: 'apply',
    interrupt: true,
    why:
      `the drain has waited ${Math.round(ctx.drainingForMs / 60_000)}m for ${ctx.live} agent(s) — ` +
      'interrupting them, and they are restored on the way back up',
  };
}
