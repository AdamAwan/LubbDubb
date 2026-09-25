import { z } from 'zod';
import { stuckGoals } from '../environments/stuck.js';
import { toolSchema } from './schema.js';
import { formatAnswers } from '../escalation/questionnaire.js';
import { settleHumanTask } from '../humanTaskSettle.js';
import type { Escalation } from '../types.js';
import type { DesktopToolDeps, DesktopToolFactory } from './desktopContext.js';
import { toolError, toolJson, type ToolCallResult } from './protocol.js';

// → docs/spec/11-mcp-tools.md

type InboxKind = 'question' | 'permission' | 'proposal' | 'orphaned';

function inboxKind(deps: DesktopToolDeps, item: Escalation): { kind: InboxKind; detail: string | null } {
  const pending = deps.store.escalations
    .listProposals()
    .find((p) => p.escalationId === item.id && p.status === 'pending');
  if (pending) return { kind: 'proposal', detail: pending.id };
  if (item.context?.permission) return { kind: 'permission', detail: null };
  const orphaned = item.agentId ? deps.recovery().pendingForAgent(item.agentId) : null;
  if (orphaned) return { kind: 'orphaned', detail: orphaned.taskId };
  return { kind: 'question', detail: null };
}

function settledBy(kind: InboxKind, detail: string | null): string {
  if (kind === 'question') return 'escalation_answer with `response` (or `answers`, one per question)';
  if (kind === 'permission') return "escalation_answer with `permission: 'allow' | 'deny'`";
  if (kind === 'proposal') return `the cockpit — proposal ${detail} is a decision, and this channel does not take it`;
  return `the cockpit — the agent that asked this crashed, and its run (${detail}) needs a recovery verdict first`;
}

function describeInboxItem(deps: DesktopToolDeps, item: Escalation): Record<string, unknown> {
  const { kind, detail } = inboxKind(deps, item);
  return {
    id: item.id,
    kind,
    type: item.type,
    prompt: item.prompt,
    questions: item.context?.questions ?? null,
    agentId: item.agentId,
    originRef: item.context?.originRef ?? null,
    taskTitle: item.context?.taskTitle ?? null,
    createdAt: item.createdAt,
    settledBy: settledBy(kind, detail),
  };
}

function heldGoals(deps: DesktopToolDeps): Record<string, unknown>[] {
  return stuckGoals({
    delivered: deps.store.verdicts.listDeliveries().map((d) => d.originRef),
    shortfalled: new Set(deps.store.verdicts.listShortfalls().map((sf) => sf.originRef)),
    environments: deps.environments,
    arrivals: deps.store.environments.listGoalArrivals(),
    releases: deps.store.environments.listEnvironmentGateReleases(),
    landings: deps.store.environments.listGoalLandings(),
    readings: deps.store.environments.listEnvironmentReach(),
    probeIntervalMs: deps.briefConfig().environmentProbeIntervalMs,
    now: Date.parse(deps.now()),
  }).map((s) => ({
    goalRef: s.goalRef,
    environment: s.environment,
    hold: s.hold,
    merges: s.absent,
    since: s.since,
    settledBy:
      "a deployment that carries this work to the environment, or the cockpit — the goal page's " +
      '"not waiting on an environment" release, for work that is never going to arrive there',
  }));
}

const ATTENTION_NEXT =
  'Answer only the rows whose `settledBy` names this channel. A held goal is neither: it is a delivery ' +
  'whose validation checks and close-out are withheld because the harness cannot see its work anywhere, ' +
  'and it is here because that wait is otherwise silent. A human task is work, not a question: it ' +
  'settles when somebody has actually done it or refused it, never as an answer typed at an agent. The ' +
  'two kinds that name the cockpit are decisions with consequences a session cannot see — an act about ' +
  'to be published, a run about to be restored or thrown away. Say what is waiting and let the operator ' +
  'go there.';

export const attentionRead: DesktopToolFactory = (deps) => ({
  description:
    'Everything the harness is waiting on a person for: questions agents have parked on, tool calls blocked ' +
    'awaiting permission, acts proposed for approval, work only a person can do, runs orphaned by a crash, and ' +
    'delivered goals held behind an environment their work has not reached. ' +
    'Each row says what kind it is and what settles it. Call this to find out whether anything is stuck.',
  inputSchema: toolSchema(z.object({})),
  handler: () => {
    const open = deps.store.escalations.listOpenEscalations();
    return toolJson({
      inbox: open.map((item) => describeInboxItem(deps, item)),
      humanTasks: deps.store.humanTasks
        .listAllHumanTasks()
        .filter((t) => t.status === 'open')
        .map((t) => ({
          id: t.id,
          kind: t.kind,
          title: t.title,
          detail: t.detail,
          originRef: t.originRef,
          createdAt: t.createdAt,
          settledBy: "human_task_settle with `status: 'done' | 'declined'`",
        })),
      orphanedRuns: deps
        .recovery()
        .pending()
        .map((o) => ({
          taskId: o.taskId,
          agentId: o.agentId,
          title: o.title,
          originRef: o.originRef,
          died: o.died,
          waitingReason: o.waitingReason,
        })),
      heldGoals: heldGoals(deps),
      next: ATTENTION_NEXT,
    });
  },
});

const ESCALATION_ANSWER_INPUT = toolSchema(
  z.object({
    id: z.string().describe('The escalation id, from attention_read.'),
    response: z.string().describe('Free-text answer to a question. Read by the agent verbatim.').optional(),
    answers: z
      .array(z.string().nullable())
      .describe(
        'One answer per question, in the order attention_read gave them. Use null for a question you are ' +
          'not answering. Only for an item that carries `questions`.',
      )
      .optional(),
    permission: z
      .enum(['allow', 'deny'])
      .describe('The verdict on a blocked tool call. Only for an item of kind "permission".')
      .optional(),
    note: z.string().describe('Optional reason, shown with a denial.').optional(),
  }),
);

function unknownEscalation(deps: DesktopToolDeps, id: string): string {
  const task = deps.store.humanTasks.getHumanTask(id);
  if (task)
    return (
      `"${id}" is a human task ("${task.title}") — a unit of work, not a question an agent is parked on. ` +
      'It is settled with human_task_settle (`done` or `declined`), never by typing an answer at an agent.'
    );
  return `No escalation "${id}". Call attention_read for what is actually open.`;
}

function kindRefusal(kind: InboxKind, detail: string | null): string | null {
  if (kind === 'proposal')
    return (
      `This item is a proposal (${detail}) — an act waiting to be accepted or rejected, not a question. ` +
      'Free text cannot be branched on, and answering it here would settle the row while leaving the act ' +
      'pending for good. The operator takes it in the cockpit.'
    );
  if (kind === 'orphaned')
    return (
      `The agent that asked this crashed, and its run (${detail}) is waiting on a restore / requeue / remove ` +
      'verdict in the cockpit. There is nothing to type into. Restoring keeps this question open, so it is ' +
      'answerable afterwards.'
    );
  return null;
}

function decidePermission(
  deps: DesktopToolDeps,
  id: string,
  kind: InboxKind,
  permission: unknown,
  note: string | undefined,
): ToolCallResult {
  if (permission !== 'allow' && permission !== 'deny') return toolError('permission must be "allow" or "deny".');
  if (kind !== 'permission')
    return toolError('This item is a question an agent parked on, not a blocked tool call. Answer it with `response`.');
  const decided = deps.permissions().decide(id, permission === 'allow', note);
  if (!decided)
    return toolError(
      'There is no permission request pending on this item any more — the agent has since died or the ' +
        'call was already decided. Nothing was changed.',
    );
  return toolJson({
    settled: id,
    permission,
    means:
      permission === 'allow'
        ? "the agent's tool call is running now; it was blocked inside it, not at a prompt."
        : 'the tool call was refused and the agent was told so. It carries on and decides what to do next.',
  });
}

function readResponse(
  args: Record<string, unknown>,
  item: Escalation,
): { ok: true; response: string } | { ok: false; error: string } {
  if (args.answers !== undefined) {
    const questions = item.context?.questions;
    if (!Array.isArray(args.answers)) return { ok: false, error: 'answers must be an array, one entry per question.' };
    if (!Array.isArray(questions) || questions.length === 0)
      return { ok: false, error: 'This item has no questionnaire — answer it with `response`.' };
    if (args.answers.length !== questions.length)
      return { ok: false, error: `This item asks ${questions.length} question(s); you sent ${args.answers.length}.` };
    const answers = args.answers.map((a) => (a === null || a === undefined ? null : String(a)));
    if (answers.every((a) => a === null || a.trim() === ''))
      return { ok: false, error: 'Answer at least one question.' };
    return { ok: true, response: formatAnswers(questions, answers) };
  }
  if (typeof args.response === 'string' && args.response.trim()) return { ok: true, response: args.response };
  return { ok: false, error: 'Give `response` (free text) or `answers` (one per question).' };
}

function deliverAnswer(deps: DesktopToolDeps, id: string, response: string): ToolCallResult {
  try {
    const result = deps.escalations().answer(id, response);
    return toolJson({
      settled: id,
      routing: result.routing,
      means:
        result.routing === 'typed_into_agent'
          ? 'the agent was live and your answer went into its session — it is carrying on from it now.'
          : 'no live agent was holding this, so the answer is on the record and the next dispatch on this ' +
            'work reads it. Nothing is running on it at this moment.',
    });
  } catch (err) {
    return toolError((err as Error).message);
  }
}

export const escalationAnswer: DesktopToolFactory = (deps) => ({
  description:
    'Answer something the harness is waiting on a person for. For a question an agent parked on, give ' +
    '`response` (or `answers`, one per question, when attention_read showed a questionnaire) — it is typed ' +
    'straight into the agent, which carries on from it. For a blocked tool call, give `permission` instead. ' +
    'Proposals and crashed runs are not settled here; attention_read says so per row.',
  inputSchema: ESCALATION_ANSWER_INPUT,
  handler: (args) => {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) return toolError('id required — take it from attention_read.');
    const item = deps.store.escalations.getEscalation(id);
    if (!item) return toolError(unknownEscalation(deps, id));
    if (item.status !== 'open')
      return toolError(
        `Escalation ${id} is already ${item.status}${item.response === null ? '' : ` — "${item.response}"`}. ` +
          'Somebody has answered it; nothing more is needed on it.',
      );

    const { kind, detail } = inboxKind(deps, item);
    const refused = kindRefusal(kind, detail);
    if (refused !== null) return toolError(refused);

    const note = typeof args.note === 'string' && args.note.trim() ? args.note.trim() : undefined;
    if (args.permission !== undefined) return decidePermission(deps, id, kind, args.permission, note);
    if (kind === 'permission')
      return toolError(
        'This item is a tool call an agent is blocked inside, not a question — it is not at a prompt, so text ' +
          "would go nowhere. Answer it with `permission: 'allow'` or `'deny'`.",
      );

    const response = readResponse(args, item);
    if (!response.ok) return toolError(response.error);
    return deliverAnswer(deps, id, response.response);
  },
});

export const humanTaskSettle: DesktopToolFactory = (deps) => ({
  description:
    'Settle a human task — a unit of work only a person can do, from attention_read. `done` records that it ' +
    'has actually been done; `declined` records a refusal and takes a required `note`, which is what a ' +
    'replan reads. Not for questions an agent parked on: those are escalation_answer.',
  inputSchema: toolSchema(
    z.object({
      id: z.string().describe('The human task id, from attention_read (a `hum_…` row).'),
      status: z.enum(['done', 'declined']).describe('Whether the work was done or refused.'),
      note: z
        .string()
        .describe(
          'What was done, or why it was refused. Required on `declined`, and on a close-out whose goal has ' +
            'outstanding validation checks.',
        )
        .optional(),
    }),
  ),
  handler: async (args) => {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) return toolError('id required — take it from attention_read.');
    const status = args.status;
    if (status !== 'done' && status !== 'declined') return toolError('status must be "done" or "declined".');

    const existing = deps.store.humanTasks.getHumanTask(id);
    if (!existing)
      return toolError(
        `No human task "${id}". Call attention_read for what is actually open — an escalation id is answered ` +
          'with escalation_answer instead.',
      );
    if (existing.status !== 'open')
      return toolError(
        `Human task ${id} is already ${existing.status}${existing.resolution === null ? '' : ` — "${existing.resolution}"`}. ` +
          'Somebody has settled it; nothing more is needed on it.',
      );

    const note = typeof args.note === 'string' ? args.note : undefined;
    const settled = settleHumanTask(deps.store, { id, status, note });
    if (!settled.ok) return toolError(settled.error);
    if (settled.runCycle) await deps.runCycle();
    return toolJson({
      settled: id,
      status: settled.task.status,
      part: settled.part === null ? null : { id: settled.part.id, status: settled.part.status },
      means:
        status === 'done'
          ? settled.part === null
            ? 'the obligation is recorded as met. Nothing was waiting on it — a standalone task blocks no work.'
            : 'the plan part it backs is concluded, so anything that depended on this step is released on this pulse.'
          : settled.task.partId === null
            ? 'the obligation is recorded as refused. Your note is what a later reader finds.'
            : 'the plan part it backs is NOT concluded — dependents stay pending and the reconciler blocks the ' +
              'part with your note. The ways out are Replan and Abandon, in the cockpit.',
    });
  },
});
