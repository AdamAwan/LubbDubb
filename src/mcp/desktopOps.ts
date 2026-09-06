import { applyIssueWatch } from '../issueWatch.js';
import { applyProfilePin } from '../intake/profilePin.js';
import { issueConclusionOrigin } from '../issueConclusion.js';
import { formatAnswers } from '../escalation/questionnaire.js';
import { settleHumanTask } from '../humanTaskSettle.js';
import { desktopIssueRef } from '../validation/desktop.js';
import type { Agent, Escalation } from '../types.js';
import type { DesktopToolDeps, DesktopToolFactory } from './desktopContext.js';
import { toolError, toolJson } from './protocol.js';

/**
 * The fleet half of the operator's own channel: what the harness is doing, and the
 * handful of verbs that steer it. (`desktopTools.ts` is the per-goal half.)
 * → `docs/spec/11-mcp-tools.md#the-desktop-channel`
 *
 * **Nothing here dispatches an agent**: these change what the fleet would pick up
 * next and how much of it runs, never what work starts. **Every write goes through
 * the same object the cockpit's click does** — never a second implementation beside
 * it, which would be free to disagree about what a pause or a watch means.
 */

/**
 * A cycle after a steering write, as the cockpit routes do: the caller sees the new
 * queue rather than waiting a heartbeat. Safe because none of these un-holds an item
 * held by a cooldown, a cap, an unapproved plan or an ignore tag.
 */
async function settle(deps: DesktopToolDeps): Promise<void> {
  await deps.runCycle();
}

/** An agent as this channel reports it — the fleet card's row, without the transcript. */
function describeAgent(deps: DesktopToolDeps, agent: Agent): Record<string, unknown> {
  const task = deps.store.getTask(agent.taskId);
  return {
    agentId: agent.id,
    status: agent.status,
    // From `note_progress`. Null is supported, not degraded: many agents never call it.
    note: agent.note,
    notedAt: agent.notedAt,
    waitingReason: agent.waitingReason,
    title: task?.title ?? null,
    kind: task?.kind ?? null,
    originRef: task?.originRef ?? null,
    branch: task?.branch ?? null,
    rule: task?.rule ?? null,
    startedAt: agent.startedAt,
    endedAt: agent.endedAt,
    costUsd: agent.costUsd,
    numTurns: agent.numTurns,
  };
}

/**
 * What kind of thing an inbox item is, which decides how it may be settled. The
 * three that are not questions cannot be answered with text, and answering one as a
 * question settles the row and loses what it was about.
 * → `src/server/routes/escalations.ts`, which refuses on the same three.
 */
function inboxKind(
  deps: DesktopToolDeps,
  item: Escalation,
): { kind: 'question' | 'permission' | 'proposal' | 'orphaned'; detail: string | null } {
  const pending = deps.store.listProposals().find((p) => p.escalationId === item.id && p.status === 'pending');
  if (pending) return { kind: 'proposal', detail: pending.id };
  if (item.context?.permission) return { kind: 'permission', detail: null };
  const orphaned = item.agentId ? deps.recovery().pendingForAgent(item.agentId) : null;
  if (orphaned) return { kind: 'orphaned', detail: orphaned.taskId };
  return { kind: 'question', detail: null };
}

/**
 * The whole fleet in one call: what is running, what is queued, what it costs and
 * how much of the account's allowance is gone. One call rather than three because
 * the cap, the live count and the five-hour window answer one question together and
 * a session would otherwise act on two of them. A read only — `fleet_control` is
 * the write.
 */
export const fleetStatus: DesktopToolFactory = (deps) => ({
  description:
    'What the harness is doing right now: how many agents may run and how many are, what each of them is ' +
    'working on and what it has said about it, what is queued behind them and why each row is held, how much ' +
    'the account has spent and how much of its rate-limit window is gone, and how many failures and unanswered ' +
    'questions have piled up. Call this first for anything about the fleet as a whole.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => {
    const control = deps.runtimeControl.snapshot();
    const live = deps.store.listAgentsByStatus('running', 'waiting');
    const upcoming = deps.harness().upcoming;
    const limits = deps.store.readRateLimits();
    const errors = deps.store.listErrors(10);
    return toolJson({
      control: {
        cap: control.cap,
        paused: control.paused,
        running: live.length,
        // Said plainly: a paused fleet with headroom dispatches nothing.
        headroom: control.paused ? 0 : Math.max(control.cap - live.length, 0),
      },
      agents: live.map((a) => describeAgent(deps, a)),
      queue:
        upcoming === null
          ? // Null until the first cycle of this boot — a real state, not an empty
            // queue: the dispatcher has not yet said what it would do.
            { at: null, items: [], note: 'No cycle has run since the harness started, so there is no queue yet.' }
          : {
              at: upcoming.at,
              items: upcoming.items.map((i) => ({
                origin: i.origin,
                title: i.title,
                rule: i.rule,
                status: i.status,
                reason: i.reason,
                expedited: i.expedited ?? false,
              })),
            },
      jobs: deps.store
        .listQueuedJobs()
        .map((j) => ({ id: j.id, title: j.title, kind: j.kind, createdAt: j.createdAt })),
      // Null is an account that has reported no window this boot, which is not the
      // same as one with room: absence must never read as headroom.
      accountUsage:
        limits === null
          ? null
          : {
              fiveHour: limits.fiveHour,
              sevenDay: limits.sevenDay,
              capturedAt: limits.capturedAt,
            },
      attention: {
        escalations: deps.store.listOpenEscalations().length,
        proposals: deps.store.listProposals().filter((p) => p.status === 'pending').length,
        orphanedRuns: deps.recovery().pending().length,
      },
      errors: errors.map((e) => ({ at: e.createdAt, source: e.source, message: e.message })),
      next:
        'Report what is here, not what it implies. A held row names its own reason and that reason is the ' +
        'answer — "capped", "cooldown", "unapproved" and "ignored" are four different problems and only one of ' +
        'them is fixed by raising the cap. `accountUsage: null` means nothing has reported a window since this ' +
        'harness started; it is not room to spare.',
    });
  },
});

/**
 * The cap, the pause, and a cycle on demand — the three live dispatch controls.
 * **Ephemeral and in-memory, as the cockpit's are**: a restart comes back on the
 * configured `maxConcurrentAgents` and `startPaused`, which the reply says. `cap` is
 * validated by `RuntimeControl.apply`, never a second time here.
 */
export const fleetControl: DesktopToolFactory = (deps) => ({
  description:
    'Change how much work the harness runs: the cap on concurrent agents, whether dispatch is paused, and ' +
    'whether to run a cycle right now. Lowering the cap never stops a running agent — it stops the next ' +
    'dispatch — and pausing does the same. Both last until they are changed again or the harness restarts; ' +
    "neither is written to the operator's config.",
  inputSchema: {
    type: 'object',
    properties: {
      cap: {
        type: 'number',
        description:
          'The most agents that may run at once. A non-negative whole number; 0 stops the next dispatch ' +
          'without pausing. Omit to leave it alone.',
      },
      paused: {
        type: 'boolean',
        description: 'true stops all dispatch, false resumes it. Omit to leave it alone.',
      },
      pulse: {
        type: 'boolean',
        description:
          'Run a cycle now rather than waiting for the next heartbeat. A cycle reads the world, decides, and ' +
          'may start agents — so this is the one argument here that can put work on the fleet.',
      },
    },
  },
  handler: async (args) => {
    const patch: { cap?: number; paused?: boolean } = {};
    if (args.cap !== undefined) {
      if (typeof args.cap !== 'number') return toolError('cap must be a number.');
      patch.cap = args.cap;
    }
    if (args.paused !== undefined) {
      if (typeof args.paused !== 'boolean') return toolError('paused must be true or false.');
      patch.paused = args.paused;
    }
    const pulse = args.pulse === true;
    if (patch.cap === undefined && patch.paused === undefined && !pulse) {
      // A call that changes nothing is nearly always a session that meant to read.
      return toolError('Nothing to do — give `cap`, `paused` or `pulse`. To read the fleet, call fleet_status.');
    }

    let next;
    try {
      next = deps.runtimeControl.apply(patch);
    } catch (err) {
      return toolError((err as Error).message);
    }
    if (pulse) await settle(deps);
    return toolJson({
      cap: next.cap,
      paused: next.paused,
      pulsed: pulse,
      running: deps.store.listAgentsByStatus('running', 'waiting').length,
      means:
        "this is in memory only and lasts until the harness restarts, when it comes back on the deployment's " +
        'configured cap and pause. A lowered cap does not stop the agents already running; it stops the next ' +
        'dispatch.',
    });
  },
});

/**
 * "Needs you" as one list, with what settles each row. Four different objects share
 * the panel — a parked question, a blocked permission request, a proposed act, a
 * run orphaned by a crash — so each row names its own `kind`: three of the four
 * cannot be answered with text at all.
 */
export const attentionRead: DesktopToolFactory = (deps) => ({
  description:
    'Everything the harness is waiting on a person for: questions agents have parked on, tool calls blocked ' +
    'awaiting permission, acts proposed for approval, work only a person can do, and runs orphaned by a crash. ' +
    'Each row says what kind it is and what settles it. Call this to find out whether anything is stuck.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => {
    const open = deps.store.listOpenEscalations();
    return toolJson({
      inbox: open.map((item) => {
        const { kind, detail } = inboxKind(deps, item);
        return {
          id: item.id,
          kind,
          type: item.type,
          prompt: item.prompt,
          // The questionnaire when there is one: answered one answer per question,
          // positionally, so free text would land under every heading.
          questions: item.context?.questions ?? null,
          agentId: item.agentId,
          originRef: item.context?.originRef ?? null,
          taskTitle: item.context?.taskTitle ?? null,
          createdAt: item.createdAt,
          settledBy:
            kind === 'question'
              ? 'escalation_answer with `response` (or `answers`, one per question)'
              : kind === 'permission'
                ? "escalation_answer with `permission: 'allow' | 'deny'`"
                : kind === 'proposal'
                  ? `the cockpit — proposal ${detail} is a decision, and this channel does not take it`
                  : `the cockpit — the agent that asked this crashed, and its run (${detail}) needs a recovery verdict first`,
        };
      }),
      // The open ones only: a settled task is a record, and this list is what is
      // still waiting.
      humanTasks: deps.store
        .listAllHumanTasks()
        .filter((t) => t.status === 'open')
        .map((t) => ({
          id: t.id,
          kind: t.kind,
          title: t.title,
          detail: t.detail,
          originRef: t.originRef,
          createdAt: t.createdAt,
          // Named because `escalation_answer` refuses these ids by construction —
          // they are not escalations — and a bare refusal reads as the harness
          // having lost the row rather than as the wrong verb.
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
      next:
        'Answer only the rows whose `settledBy` names this channel. A human task is work, not a question: it ' +
        'settles when somebody has actually done it or refused it, never as an answer typed at an agent. The ' +
        'two kinds that name the cockpit are decisions with consequences a session cannot see — an act about ' +
        'to be published, a run about to be restored or thrown away. Say what is waiting and let the operator ' +
        'go there.',
    });
  },
});

/**
 * The two ways an inbox item is settled from here: an answer typed into the agent,
 * and a verdict on a blocked tool call. One tool with two arms, because they are one
 * row in one inbox and the difference is a field. The three refusals are the route's
 * own, and each names where the row *is* settled rather than failing bare.
 */
export const escalationAnswer: DesktopToolFactory = (deps) => ({
  description:
    'Answer something the harness is waiting on a person for. For a question an agent parked on, give ' +
    '`response` (or `answers`, one per question, when attention_read showed a questionnaire) — it is typed ' +
    'straight into the agent, which carries on from it. For a blocked tool call, give `permission` instead. ' +
    'Proposals and crashed runs are not settled here; attention_read says so per row.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The escalation id, from attention_read.' },
      response: { type: 'string', description: 'Free-text answer to a question. Read by the agent verbatim.' },
      answers: {
        type: 'array',
        items: { type: ['string', 'null'] },
        description:
          'One answer per question, in the order attention_read gave them. Use null for a question you are ' +
          'not answering. Only for an item that carries `questions`.',
      },
      permission: {
        type: 'string',
        enum: ['allow', 'deny'],
        description: 'The verdict on a blocked tool call. Only for an item of kind "permission".',
      },
      note: { type: 'string', description: 'Optional reason, shown with a denial.' },
    },
    required: ['id'],
  },
  handler: (args) => {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) return toolError('id required — take it from attention_read.');
    const item = deps.store.getEscalation(id);
    if (!item) {
      // A bench row's id lands here as often as a typo does, since `attention_read`
      // returns both lists. Name the tool that does take it.
      const task = deps.store.getHumanTask(id);
      if (task)
        return toolError(
          `"${id}" is a human task ("${task.title}") — a unit of work, not a question an agent is parked on. ` +
            'It is settled with human_task_settle (`done` or `declined`), never by typing an answer at an agent.',
        );
      return toolError(`No escalation "${id}". Call attention_read for what is actually open.`);
    }
    if (item.status !== 'open')
      return toolError(
        `Escalation ${id} is already ${item.status}${item.response === null ? '' : ` — "${item.response}"`}. ` +
          'Somebody has answered it; nothing more is needed on it.',
      );

    const { kind, detail } = inboxKind(deps, item);
    if (kind === 'proposal')
      return toolError(
        `This item is a proposal (${detail}) — an act waiting to be accepted or rejected, not a question. ` +
          'Free text cannot be branched on, and answering it here would settle the row while leaving the act ' +
          'pending for good. The operator takes it in the cockpit.',
      );
    if (kind === 'orphaned')
      return toolError(
        `The agent that asked this crashed, and its run (${detail}) is waiting on a restore / requeue / remove ` +
          'verdict in the cockpit. There is nothing to type into. Restoring keeps this question open, so it is ' +
          'answerable afterwards.',
      );

    const note = typeof args.note === 'string' && args.note.trim() ? args.note.trim() : undefined;
    if (args.permission !== undefined) {
      if (args.permission !== 'allow' && args.permission !== 'deny')
        return toolError('permission must be "allow" or "deny".');
      if (kind !== 'permission')
        return toolError(
          'This item is a question an agent parked on, not a blocked tool call. Answer it with `response`.',
        );
      const decided = deps.permissions().decide(id, args.permission === 'allow', note);
      if (!decided)
        return toolError(
          'There is no permission request pending on this item any more — the agent has since died or the ' +
            'call was already decided. Nothing was changed.',
        );
      return toolJson({
        settled: id,
        permission: args.permission,
        means:
          args.permission === 'allow'
            ? "the agent's tool call is running now; it was blocked inside it, not at a prompt."
            : 'the tool call was refused and the agent was told so. It carries on and decides what to do next.',
      });
    }
    if (kind === 'permission')
      return toolError(
        'This item is a tool call an agent is blocked inside, not a question — it is not at a prompt, so text ' +
          "would go nowhere. Answer it with `permission: 'allow'` or `'deny'`.",
      );

    // Folded here exactly as the route folds it, and the checks are refusals rather
    // than padding: a mismatched array puts an answer under the wrong question.
    let response: string;
    if (args.answers !== undefined) {
      const questions = item.context?.questions;
      if (!Array.isArray(args.answers)) return toolError('answers must be an array, one entry per question.');
      if (!Array.isArray(questions) || questions.length === 0)
        return toolError('This item has no questionnaire — answer it with `response`.');
      if (args.answers.length !== questions.length)
        return toolError(`This item asks ${questions.length} question(s); you sent ${args.answers.length}.`);
      const answers = args.answers.map((a) => (a === null || a === undefined ? null : String(a)));
      if (answers.every((a) => a === null || a.trim() === '')) return toolError('Answer at least one question.');
      response = formatAnswers(questions, answers);
    } else if (typeof args.response === 'string' && args.response.trim()) {
      response = args.response;
    } else {
      return toolError('Give `response` (free text) or `answers` (one per question).');
    }

    try {
      const result = deps.escalations().answer(id, response);
      return toolJson({
        settled: id,
        // Stated rather than inferred from a bare "ok": a session told only that the
        // call succeeded would believe an agent had read the answer.
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
  },
});

/** How much of an agent's transcript comes back by default — the end, which is where the trouble is. */
const TRANSCRIPT_TAIL = 8000;

/**
 * One agent, close up: its row, what it has written, and the tail of its output —
 * the tail because a long transcript is megabytes and "what is it stuck on" lives at
 * the end; `chars` widens it. **A read**: an agent parked on a question is answered
 * through `escalation_answer`, which settles the row as well as typing the text.
 */
export const agentRead: DesktopToolFactory = (deps) => ({
  description:
    'Look at one agent: what it was dispatched for, what it has said about its own progress, which files it ' +
    'has written, and the tail of its output. Call this when fleet_status shows something waiting, stalled or ' +
    'expensive and the question is what it is actually doing.',
  inputSchema: {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: 'The agent id, from fleet_status.' },
      chars: {
        type: 'number',
        description: `How much of the end of the transcript to return. Defaults to ${TRANSCRIPT_TAIL}.`,
      },
    },
    required: ['agentId'],
  },
  handler: (args) => {
    const id = typeof args.agentId === 'string' ? args.agentId.trim() : '';
    if (!id) return toolError('agentId required — take it from fleet_status.');
    const agent = deps.store.getAgent(id);
    if (!agent) return toolError(`No agent "${id}". Call fleet_status for the ones that are running.`);
    const wanted =
      typeof args.chars === 'number' && Number.isFinite(args.chars) ? Math.floor(args.chars) : TRANSCRIPT_TAIL;
    const tail = Math.min(Math.max(wanted, 200), 100_000);
    const full = deps.store.getTranscript(id);
    const open = deps.store.listOpenEscalations().filter((e) => e.agentId === id);
    return toolJson({
      ...describeAgent(deps, agent),
      files: deps.store.listFiles(id).map((f) => f.path),
      // Named so a session knows it is reading an excerpt rather than the whole.
      transcript: { totalChars: full.length, tailChars: Math.min(tail, full.length), tail: full.slice(-tail) },
      awaitingAnswer: open.map((e) => ({ id: e.id, prompt: e.prompt })),
      next:
        open.length > 0
          ? 'This agent is parked on a question. Answer it with escalation_answer — that types the answer into ' +
            'the session and settles the inbox row together, which typing at it would not.'
          : 'This is a read. If the agent needs stopping or completing, that is a decision the operator takes ' +
            'in the cockpit.',
    });
  },
});

/**
 * The "Up next" queue's operator verbs: what runs first, dropping a brief that has
 * not run, and pricing one row. `order` **replaces** the whole override set rather
 * than moving one row — sending one origin clears every other pin — so the reply
 * says how many stand. **It re-orders and nothing else**: it un-holds no held row,
 * and a manual job still goes first.
 */
export const queueControl: DesktopToolFactory = (deps) => ({
  description:
    'Steer the "Up next" queue: pin origins to the front in the order you give them, or cancel a queued job ' +
    'before it runs. Pinning only re-orders — it never un-holds a row that is held by a cap, a cooldown, an ' +
    'unapproved plan or a missing watch tag, and those are named in fleet_status as the reason.',
  inputSchema: {
    type: 'object',
    properties: {
      order: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Origins (e.g. "issue:284:plan"), highest priority first, from fleet_status. This REPLACES every ' +
          'standing pin; send an empty array to clear them all and go back to the natural order.',
      },
      cancelJob: {
        type: 'string',
        description: 'The id of a queued job to drop. Only works while it is still queued.',
      },
      origin: {
        type: 'string',
        description: 'The origin to price, e.g. "issue:284:plan", from fleet_status. Only with `profile`.',
      },
      profile: {
        type: 'string',
        description:
          'The model profile the next dispatch on `origin` runs on, by name, or "" to clear the override. ' +
          'This prices one queued row and says nothing about when it runs — a row held by a cap, a cooldown ' +
          "or an unapproved plan is still held. To pin a whole goal's work, that is goal_control.",
      },
    },
  },
  handler: async (args) => {
    const hasOrder = args.order !== undefined;
    const cancel = typeof args.cancelJob === 'string' ? args.cancelJob.trim() : '';
    const wantsPrice = args.profile !== undefined || args.origin !== undefined;
    if (!hasOrder && !cancel && !wantsPrice)
      return toolError(
        'Nothing to do — give `order`, `cancelJob`, or `origin` with `profile`. To read the queue, call ' +
          'fleet_status.',
      );

    // Priced before anything else is written: a pin naming an unknown profile prices
    // nothing while reading as a decision taken, so it is refused by name.
    let priced: { origin: string; profile: string | null } | null = null;
    if (wantsPrice) {
      const origin = typeof args.origin === 'string' ? args.origin.trim() : '';
      if (!origin) return toolError('origin required — take it from the queue in fleet_status.');
      if (args.profile !== undefined && typeof args.profile !== 'string')
        return toolError('profile must be a string, or "" to clear the override.');
      const wanted = typeof args.profile === 'string' && args.profile.trim() ? args.profile.trim() : null;
      const known = deps.profileNames();
      if (wanted !== null && !known.includes(wanted))
        return toolError(
          known.length === 0
            ? 'This deployment configures no agentModels.profiles, so there is nothing to pick.'
            : `"${wanted}" is not one of this deployment's profiles: ${known.join(', ')}.`,
        );
      deps.store.setProfileOverride(origin, wanted);
      priced = { origin, profile: wanted };
    }

    let pinned: string[] | null = null;
    if (hasOrder) {
      if (!Array.isArray(args.order) || args.order.some((o) => typeof o !== 'string'))
        return toolError('order must be an array of origin strings.');
      const origins = (args.order as string[]).map((o) => o.trim()).filter((o) => o !== '');
      // A duplicate is two ranks for one row, which the route refuses too.
      if (new Set(origins).size !== origins.length) return toolError('order must not name the same origin twice.');
      deps.store.setPriorityOverrides(origins);
      pinned = origins;
    }

    let cancelled: { id: string; title: string } | null = null;
    if (cancel) {
      const job = deps.store.cancelJob(cancel);
      if (!job)
        return toolError(
          `Job "${cancel}" is not queued — it has already run, been cancelled, or never existed. Nothing was ` +
            `changed${pinned === null ? '' : ', but the pins above were written'}.`,
        );
      cancelled = { id: job.id, title: job.title };
    }

    await settle(deps);
    return toolJson({
      pinned,
      cancelled,
      priced,
      means:
        'the queue is re-ranked and a cycle has run. Pinning changes the order only: a row held by a cap, a ' +
        'cooldown, an unapproved plan or a missing watch tag is still held, and an operator-launched job still ' +
        'goes first. Read fleet_status to see what actually moved.',
    });
  },
});

/**
 * The standing marks on a goal — whether the fleet works it at all, whether it works
 * it first, and what it runs on. They are different kinds of thing:
 *
 * - **`watched` is a tag on the tracker item**, written through the provider and
 *   visible to anyone reading the ticket. It cascades to every descendant of a
 *   container. → `src/issueWatch.ts`
 * - **`priority` is the harness's own record**, deliberately not a label: it is
 *   about *this deployment's queue*, which no other deployment should inherit.
 *
 * Unwatching stops the next dispatch only; an agent already running keeps running.
 */
export const goalControl: DesktopToolFactory = (deps) => ({
  description:
    'Say whether the harness should work a goal, and whether it should work it first. `watched` puts the ' +
    'watch tag on the ticket (and every ticket beneath it) or takes it off — that is what opts work in and ' +
    "out. `priority` is the harness's own mark and only re-orders its queue. Neither starts or stops an agent " +
    'that is already running.',
  inputSchema: {
    type: 'object',
    properties: {
      issue: { type: 'number', description: 'The goal number, e.g. 284.' },
      watched: {
        type: 'boolean',
        description:
          'true tags the ticket so the harness picks it up; false takes the tag off so nothing further is ' +
          'dispatched for it. Cascades to every ticket under a container.',
      },
      priority: {
        type: 'boolean',
        description:
          'true ranks everything dispatched under this goal ahead of the natural order until it is cleared; ' +
          'false clears the mark.',
      },
      profile: {
        type: 'string',
        description:
          'The model profile this goal\'s work runs on, by name, or "" to clear the pin. This is the answer ' +
          "the appraiser's profile question is waiting for, and giving it settles that question whichever " +
          'name you pick — including keeping the one the goal already had.',
      },
    },
    required: ['issue'],
  },
  handler: async (args) => {
    const ref = desktopIssueRef(args);
    if (!ref.ok) return toolError(ref.error);
    const wantsWatch = typeof args.watched === 'boolean';
    const wantsPriority = typeof args.priority === 'boolean';
    const wantsProfile = args.profile !== undefined;
    if (!wantsWatch && !wantsPriority && !wantsProfile)
      return toolError('Nothing to do — give `watched`, `priority` or `profile`. To read the goal, call goal_read.');

    // The tag on the ticket and the settlement of the appraiser's question, both
    // through `applyProfilePin` — the cockpit's own write. Never `setProfileOverride`,
    // which prices one *queued row* and is `queue_control`'s job: it would leave the
    // ticket untagged and the question unanswered while reporting a pin.
    let profile: { profile: string | null; answered: boolean } | null = null;
    if (wantsProfile) {
      if (typeof args.profile !== 'string') return toolError('profile must be a string, or "" to clear the pin.');
      const pinned = await applyProfilePin(
        {
          store: deps.store,
          sink: deps.connector,
          errors: deps.errors,
          labelPrefix: deps.labelPrefix,
          agentModels: deps.agentModels,
        },
        ref.issue,
        args.profile.trim() || null,
      );
      if (!pinned.ok) return toolError(pinned.error);
      profile = { profile: pinned.profile, answered: pinned.answered };
    }

    let priority: boolean | null = null;
    if (wantsPriority) {
      deps.store.setGoalPriority(issueConclusionOrigin(ref.issue), args.priority as boolean);
      priority = args.priority as boolean;
    }

    let watch: Record<string, unknown> | null = null;
    if (wantsWatch) {
      const watched = args.watched as boolean;
      const outcome = await applyIssueWatch(
        {
          store: deps.store,
          sink: deps.connector,
          errors: deps.errors,
          labelPrefix: deps.labelPrefix,
          issueContainerTypes: deps.issueContainerTypes,
        },
        ref.issue,
        watched,
        `while ${watched ? 'watching' : 'dropping'} #${ref.issue} from the desktop channel`,
      );
      if (!outcome.label) {
        // The gate is off on this deployment: everything is watched and there is no
        // tag to write, so saying so is the answer.
        watch = {
          watched,
          wrote: 0,
          note: 'This deployment configures no labelPrefix, so the watch gate is off and every ticket is worked. There was no tag to write.',
        };
      } else if (outcome.failed.length > 0 && outcome.landed.length === 0) {
        return toolError(
          `The provider refused the watch tag on #${ref.issue}: ${outcome.failed[0]?.message ?? 'unknown error'}. ` +
            `Nothing was tagged${priority === null ? '' : ', though the priority mark above was written'}.`,
        );
      } else {
        watch = {
          watched,
          wrote: outcome.landed.length,
          cascaded: Math.max(outcome.targets.length - 1, 0),
          // A partial failure is reported, never swallowed: an operator told "watched"
          // while some children kept the old tag has been misled about pickup.
          kept: outcome.failed.map((f) => `#${f.number}: ${f.message}`),
        };
      }
    }

    await settle(deps);
    return toolJson({
      issue: ref.issue,
      watch,
      priority,
      profile: profile === null ? undefined : profile.profile,
      // Said rather than inferred: a session told only that a tag was written cannot
      // tell a released goal from a held one.
      profileQuestionAnswered: profile === null ? undefined : profile.answered,
      means:
        'this changes what the harness picks up next and in what order. Nothing running was stopped: an agent ' +
        'already working this goal carries on, and un-watching only stops the next dispatch.' +
        (profile?.answered === true
          ? ' The profile question the appraisal was holding this goal on is answered, so it is released.'
          : ''),
    });
  },
});

/**
 * The bench's two verbs. A human task is not an escalation
 * ({@link docs/spec/13-jobs-and-tickets.md}), so it takes its own name rather than
 * being refused by `escalation_answer` as a lost row.
 *
 * **The settlement is `settleHumanTask`'s, shared with the cockpit's routes** — a
 * second copy here would be free to conclude a part the cockpit would have left
 * blocked. `close_ticket` is deliberately not an arm: it writes to the tracker, and
 * this channel steers the fleet without acting for it.
 */
export const humanTaskSettle: DesktopToolFactory = (deps) => ({
  description:
    'Settle a human task — a unit of work only a person can do, from attention_read. `done` records that it ' +
    'has actually been done; `declined` records a refusal and takes a required `note`, which is what a ' +
    'replan reads. Not for questions an agent parked on: those are escalation_answer.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The human task id, from attention_read (a `hum_…` row).' },
      status: {
        type: 'string',
        enum: ['done', 'declined'],
        description: 'Whether the work was done or refused.',
      },
      note: {
        type: 'string',
        description:
          'What was done, or why it was refused. Required on `declined`, and on a close-out whose goal has ' +
          'outstanding validation checks.',
      },
    },
    required: ['id', 'status'],
  },
  handler: async (args) => {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) return toolError('id required — take it from attention_read.');
    const status = args.status;
    if (status !== 'done' && status !== 'declined') return toolError('status must be "done" or "declined".');

    const existing = deps.store.getHumanTask(id);
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
    // A concluded part releases whatever named it in `dependsOn`, on a pulse — run
    // one rather than leaving dependents pending, as the cockpit's route does.
    if (settled.runCycle) await settle(deps);
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
