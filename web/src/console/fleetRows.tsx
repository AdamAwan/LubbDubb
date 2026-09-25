import type { JSX } from 'react';
import type { CockpitView, DeskRun } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { Agent, EjectionView, ReadyingAction, ReadyingStepTiming, ReadyingStep } from '../types.js';
import { goalOfPr, standsFor } from '../view/goalRefs.js';
import { AsyncButton } from '../components/AsyncButton.js';
import { elapsed, fmtUsd, relTime, timeLeft } from '../components/util.js';
import { Ref, refLabel } from '../components/refs.js';
import type { PanelRowModel } from './PanelRow.js';
import { EjectionControls } from '../components/Ejection.js';

// → docs/spec/17-cockpit.md

/**
 * The lamp modifier an agent's status earns. Shared with the focus shape's lane,
 * so the two surfaces cannot come to disagree about what amber means.
 */
export function agentLamp(agent: Agent, view: CockpitView): string {
  if (view.escalationByAgent.has(agent.id)) return 'cn-lamp-ask';
  if (agent.endedAt !== null) return 'cn-off';
  return agent.status === 'waiting' ? 'cn-wait' : 'cn-run';
}

export function agentRow(agent: Agent, view: CockpitView, actions: CockpitActions): PanelRowModel {
  const task = view.taskFor(agent);
  const origin = task?.originRef ?? null;
  const done = agent.endedAt !== null;
  const limited = view.limitParked.has(agent.id);
  return {
    key: agent.id,
    lamp: <i className={`cn-lamp ${agentLamp(agent, view)}`} />,
    title: task?.title ?? agent.id,
    open: () => actions.select(agent.id),
    openTitle: "Open this agent's drawer",
    refs: <OnWhat origin={origin} view={view} />,
    facts: [
      { label: 'doing', value: limited ? 'Out of account limit' : (agent.note ?? agent.status), alarm: limited },
      { label: 'for', value: elapsed(agent.startedAt, agent.endedAt, view.now) },
      ...(agent.costUsd !== null ? [{ label: 'cost', value: fmtUsd(agent.costUsd) }] : []),
    ],
    ...agentState(agent, view),
    action: limited ? (
      <AsyncButton
        onClick={() => actions.resumeAgent(agent.id)}
        title={agent.waitingReason ?? 'Resume this agent now the limit has cleared'}
        pendingLabel="Resuming…"
      >
        Resume
      </AsyncButton>
    ) : undefined,
    spent: done,
  };
}

function agentState(agent: Agent, view: CockpitView): Pick<PanelRowModel, 'why' | 'whyLabel' | 'whyTone'> {
  const escalation = view.escalationByAgent.get(agent.id);
  if (escalation !== undefined) {
    return { whyLabel: 'question', whyTone: 'ask', why: escalation.prompt };
  }
  if (view.limitParked.has(agent.id)) {
    return {
      whyLabel: 'limit',
      whyTone: 'hold',
      why:
        (agent.waitingReason ?? 'The account’s usage limit is spent.') +
        ' It takes a fleet slot until it is resumed or ended.',
    };
  }
  const stallExpiry = view.stallExpiryByAgent.get(agent.id);
  if (stallExpiry !== undefined) {
    return {
      whyLabel: 'stalled',
      whyTone: 'hold',
      why:
        'It stopped without saying so. The harness records it done by itself ' +
        `${timeLeft(stallExpiry, view.now)} unless it speaks again.`,
    };
  }
  if (agent.status === 'waiting') {
    return { whyLabel: 'blocked', whyTone: 'hold', why: agent.waitingReason };
  }
  if (ENDED_BADLY[agent.status] !== undefined) {
    return { whyLabel: ENDED_BADLY[agent.status], whyTone: 'quiet', why: agent.waitingReason };
  }
  return {};
}

const ENDED_BADLY: Partial<Record<Agent['status'], string>> = {
  failed: 'failed',
  crashed: 'crashed',
  killed: 'killed',
  interrupted: 'stopped',
};

function OnWhat({ origin, view }: { origin: string | null; view: CockpitView }): JSX.Element {
  const stood = standsFor(view.state, origin);
  const pr = stood === null ? null : /^pr:(\d+)/.exec(stood);
  const goal = pr ? goalOfPr(view.state, Number(pr[1])) : null;
  return (
    <>
      {origin !== null && <Ref to={origin} />}
      {/* Position says the relation, not a word between them — each ref's own
          hover carries the sentence. */}
      {stood !== null && stood !== origin && (
        <Ref to={stood} title={`Open the work this job is standing in for — ${refLabel(stood)}`} />
      )}
      {goal !== null && goal !== stood && (
        <Ref to={goal} title={`Open the goal this pull request is delivering — ${refLabel(goal)}`} />
      )}
    </>
  );
}

const READYING_STEP: Record<ReadyingStep, string> = {
  'picked-up': 'picked up',
  'ci-evidence': 'reading CI output',
  'slot-handover': 'handing a slot over',
  authorizing: 'authorizing',
};

const READYING_WHY: Record<ReadyingStep, string> = {
  'picked-up': 'The executor has this action in hand and has not reached anything it has to wait for.',
  'ci-evidence': 'Reading the failing check output out of the provider, so the agent is dispatched holding it.',
  'slot-handover':
    'Waiting on the worktree pool. A slot already on this branch comes back at once; one checked out on ' +
    'another branch is wiped with `git clean -ffdx` and checked out cold first, which on a large repository ' +
    'is minutes.',
  authorizing: 'Asking whether this act is already authorized, which is a read against the tracker.',
};

function readiedSoFar(steps: ReadyingStepTiming[]): string {
  return steps.map((s) => `${s.step} ${readyingSpan(s.ms)}`).join(', ');
}

function readyingSpan(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`;
}

export function readyingRow(action: ReadyingAction, view: CockpitView): PanelRowModel {
  return {
    key: action.id,
    lamp: <i className="cn-lamp cn-readying-lamp" />,
    title: action.title,
    refs: action.originRef === null ? null : <Ref to={action.originRef} />,
    facts: [
      ...(action.branch === null ? [] : [{ label: 'branch', value: action.branch }]),
      { label: 'for', value: elapsed(action.startedAt, null, view.now) },
      { label: action.step, value: elapsed(action.stepStartedAt, null, view.now) },
      ...(action.elapsed.length === 0 ? [] : [{ label: 'before that', value: readiedSoFar(action.elapsed) }]),
    ],
    whyLabel: READYING_STEP[action.step],
    whyTone: 'quiet',
    why:
      `${READYING_WHY[action.step]} Nothing has been dispatched for this yet: it holds no fleet slot and ` +
      'has no transcript, and it leaves this list once the agent starts, or the dispatch fails.',
    readying: true,
  };
}

export function deskRow(run: DeskRun, view: CockpitView): PanelRowModel {
  return {
    key: `${run.originRef}|${run.checkId}`,
    lamp: <i className="cn-lamp cn-desk-lamp" />,
    title: run.title,
    refs: <Ref to={run.originRef} />,
    facts: [
      { label: 'check', value: run.letter },
      { label: 'who', value: run.label },
      { label: 'for', value: elapsed(run.claimedAt, null, view.now) },
    ],
    whyLabel: 'at a keyboard',
    whyTone: 'quiet',
    why:
      `Nobody dispatched this: ${run.label} claimed check ${run.letter} of ${refLabel(run.originRef)} ` +
      `${relTime(run.claimedAt, view.now)}, at their own keyboard. It takes no fleet slot, and it ends ` +
      'when the reading lands, when the session closes, or when the claim ages out.',
    desk: true,
  };
}

export function ejectedRow(held: EjectionView, view: CockpitView, actions: CockpitActions): PanelRowModel {
  const seen =
    held.lastSeenAt === null
      ? held.neverContacted
        ? 'never contacted'
        : 'just ejected'
      : `last seen ${relTime(held.lastSeenAt, view.now)}`;
  return {
    key: held.id,
    lamp: <i className="cn-lamp cn-eject-lamp" />,
    title: refLabel(held.originRef),
    refs: <Ref to={held.originRef} />,
    facts: [
      { label: 'who', value: 'you' },
      { label: 'line', value: held.lastNote ?? seen, alarm: held.neverContacted },
      ...(held.branch === null ? [] : [{ label: 'branch', value: held.branch }]),
      { label: 'expires', value: held.expiresAt === null ? 'never' : timeLeft(held.expiresAt, view.now) },
    ],
    whyLabel: 'taken off the fleet',
    whyTone: 'quiet',
    why:
      `You stopped the agent on this because: "${held.reason}" Its goal and its worktree are held for you — ` +
      'nothing will staff the work or touch the directory until you hand it back' +
      (held.expiresAt === null ? '.' : `, and the harness takes it back ${timeLeft(held.expiresAt, view.now)}.`) +
      (held.neverContacted
        ? ' Nothing has contacted the harness about this hold at all, so the link may never have opened — the ' +
          'button below re-offers it.'
        : '') +
      // The deep link starts a fresh session; this is the agent's own conversation,
      // and it only resolves from the worktree, which is why the path goes with it.
      (held.sessionId === null
        ? ''
        : ` To pick up the agent's own conversation instead: \`claude --resume ${held.sessionId}\`, run in ` +
          `${held.worktreePath ?? 'the worktree'}.`),
    action: <EjectionControls held={held} actions={actions} />,
    ejected: true,
  };
}
