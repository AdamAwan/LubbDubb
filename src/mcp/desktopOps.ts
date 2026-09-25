import { z } from 'zod';
import { toolSchema } from './schema.js';
import type { Agent } from '../types.js';
import type { CycleStanding } from '../harness.js';
import type { UpcomingPlan } from '../wire.js';
import type { DesktopToolDeps, DesktopToolFactory } from './desktopContext.js';
import { toolError, toolJson } from './protocol.js';
import { isSealedRule } from './names.js';

// → docs/spec/11-mcp-tools.md

async function settle(deps: DesktopToolDeps): Promise<void> {
  await deps.runCycle();
}

function describeAgent(deps: DesktopToolDeps, agent: Agent): Record<string, unknown> {
  const task = deps.store.tasks.getTask(agent.taskId);
  return {
    agentId: agent.id,
    status: agent.status,
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

function describeCycle(inFlight: CycleStanding | null): Record<string, unknown> | null {
  return inFlight === null
    ? null
    : {
        cycleId: inFlight.cycleId,
        source: inFlight.source,
        startedAt: inFlight.startedAt,
        elapsedMs: inFlight.elapsedMs,
        where: inFlight.where,
        overdue: inFlight.overdue,
      };
}

function describeQueue(upcoming: UpcomingPlan | null, inFlight: CycleStanding | null): Record<string, unknown> {
  return upcoming === null
    ? {
        at: null,
        items: [],
        note:
          inFlight?.overdue === true
            ? `Cycle ${inFlight.cycleId} has been running for ${Math.round(inFlight.elapsedMs / 1000)}s at ` +
              `${inFlight.where} and no cycle can start behind it, so there is no queue — this is a wedged ` +
              'harness, not an idle one.'
            : 'No cycle has run since the harness started, so there is no queue yet.',
      }
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
      };
}

const FLEET_STATUS_NEXT =
  'Report what is here, not what it implies. A held row names its own reason and that reason is the ' +
  'answer — "capped", "cooldown", "unapproved" and "ignored" are four different problems and only one of ' +
  'them is fixed by raising the cap. `accountUsage: null` means nothing has reported a window since this ' +
  'harness started; it is not room to spare. A `cycle` with `overdue: true` is the fleet stopped: no cycle ' +
  'can start behind it, so an empty queue and idle agents mean nothing until it settles.';

export const fleetStatus: DesktopToolFactory = (deps) => ({
  description:
    'What the harness is doing right now: how many agents may run and how many are, what each of them is ' +
    'working on and what it has said about it, what is queued behind them and why each row is held, how much ' +
    'the account has spent and how much of its rate-limit window is gone, and how many failures and unanswered ' +
    'questions have piled up. Call this first for anything about the fleet as a whole.',
  inputSchema: toolSchema(z.object({})),
  handler: () => {
    const control = deps.runtimeControl.snapshot();
    const live = deps.store.agents.listAgentsByStatus('running', 'waiting');
    const upcoming = deps.harness().upcoming;
    const inFlight = deps.harness().inFlightCycle;
    const limits = deps.store.rateLimits.readRateLimits();
    const errors = deps.store.errors.listErrors(10);
    return toolJson({
      control: {
        cap: control.cap,
        paused: control.paused,
        running: live.length,
        headroom: control.paused ? 0 : Math.max(control.cap - live.length, 0),
      },
      agents: live.map((a) => describeAgent(deps, a)),
      cycle: describeCycle(inFlight),
      queue: describeQueue(upcoming, inFlight),
      jobs: deps.store.jobs
        .listQueuedJobs()
        .map((j) => ({ id: j.id, title: j.title, kind: j.kind, createdAt: j.createdAt })),
      accountUsage:
        limits === null
          ? null
          : {
              fiveHour: limits.fiveHour,
              sevenDay: limits.sevenDay,
              capturedAt: limits.capturedAt,
            },
      attention: {
        escalations: deps.store.escalations.listOpenEscalations().length,
        proposals: deps.store.escalations.listProposals().filter((p) => p.status === 'pending').length,
        orphanedRuns: deps.recovery().pending().length,
      },
      errors: errors.map((e) => ({ at: e.createdAt, source: e.source, message: e.message })),
      next: FLEET_STATUS_NEXT,
    });
  },
});

export const fleetControl: DesktopToolFactory = (deps) => ({
  description:
    'Change how much work the harness runs: the cap on concurrent agents, whether dispatch is paused, and ' +
    'whether to run a cycle right now. Lowering the cap never stops a running agent — it stops the next ' +
    'dispatch — and pausing does the same. Both last until they are changed again or the harness restarts; ' +
    "neither is written to the operator's config.",
  inputSchema: toolSchema(
    z.object({
      cap: z
        .number()
        .describe(
          'The most agents that may run at once. A non-negative whole number; 0 stops the next dispatch ' +
            'without pausing. Omit to leave it alone.',
        )
        .optional(),
      paused: z.boolean().describe('true stops all dispatch, false resumes it. Omit to leave it alone.').optional(),
      pulse: z
        .boolean()
        .describe(
          'Run a cycle now rather than waiting for the next heartbeat. A cycle reads the world, decides, and ' +
            'may start agents — so this is the one argument here that can put work on the fleet.',
        )
        .optional(),
    }),
  ),
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
      running: deps.store.agents.listAgentsByStatus('running', 'waiting').length,
      means:
        "this is in memory only and lasts until the harness restarts, when it comes back on the deployment's " +
        'configured cap and pause. A lowered cap does not stop the agents already running; it stops the next ' +
        'dispatch.',
    });
  },
});

const TRANSCRIPT_TAIL = 8000;

export const agentRead: DesktopToolFactory = (deps) => ({
  description:
    'Look at one agent: what it was dispatched for, what it has said about its own progress, which files it ' +
    'has written, and the tail of its output. Call this when fleet_status shows something waiting, stalled or ' +
    'expensive and the question is what it is actually doing.',
  inputSchema: toolSchema(
    z.object({
      agentId: z.string().describe('The agent id, from fleet_status.'),
      chars: z
        .number()
        .describe(`How much of the end of the transcript to return. Defaults to ${TRANSCRIPT_TAIL}.`)
        .optional(),
    }),
  ),
  handler: (args) => {
    const id = typeof args.agentId === 'string' ? args.agentId.trim() : '';
    if (!id) return toolError('agentId required — take it from fleet_status.');
    const agent = deps.store.agents.getAgent(id);
    if (!agent) return toolError(`No agent "${id}". Call fleet_status for the ones that are running.`);
    if (isSealedRule(deps.store.tasks.getTask(agent.taskId)?.rule))
      return toolJson({
        ...describeAgent(deps, agent),
        sealed: true,
        next:
          'This agent is sealed: what it was told and what it said are shown to the operator in the cockpit ' +
          'and to no model, this one included. Its status and spend are above.',
      });
    const wanted =
      typeof args.chars === 'number' && Number.isFinite(args.chars) ? Math.floor(args.chars) : TRANSCRIPT_TAIL;
    const tail = Math.min(Math.max(wanted, 200), 100_000);
    const full = deps.store.transcripts.getTranscript(id);
    const open = deps.store.escalations.listOpenEscalations().filter((e) => e.agentId === id);
    return toolJson({
      ...describeAgent(deps, agent),
      files: deps.store.agents.listFiles(id).map((f) => f.path),
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

const QUEUE_CONTROL_INPUT = toolSchema(
  z.object({
    order: z
      .array(z.string())
      .describe(
        'Origins (e.g. "issue:284:plan"), highest priority first, from fleet_status. This REPLACES every ' +
          'standing pin; send an empty array to clear them all and go back to the natural order.',
      )
      .optional(),
    cancelJob: z.string().describe('The id of a queued job to drop. Only works while it is still queued.').optional(),
    origin: z
      .string()
      .describe('The origin to price, e.g. "issue:284:plan", from fleet_status. Only with `profile`.')
      .optional(),
    profile: z
      .string()
      .describe(
        'The model profile the next dispatch on `origin` runs on, by name, or "" to clear the override. ' +
          'This prices one queued row and says nothing about when it runs — a row held by a cap, a cooldown ' +
          "or an unapproved plan is still held. To pin a whole goal's work, that is goal_control.",
      )
      .optional(),
  }),
);

type Priced = { origin: string; profile: string | null };

function readPrice(
  deps: DesktopToolDeps,
  args: Record<string, unknown>,
): { ok: true; priced: Priced } | { ok: false; error: string } {
  const origin = typeof args.origin === 'string' ? args.origin.trim() : '';
  if (!origin) return { ok: false, error: 'origin required — take it from the queue in fleet_status.' };
  if (args.profile !== undefined && typeof args.profile !== 'string')
    return { ok: false, error: 'profile must be a string, or "" to clear the override.' };
  const wanted = typeof args.profile === 'string' && args.profile.trim() ? args.profile.trim() : null;
  const known = deps.profileNames();
  if (wanted !== null && !known.includes(wanted))
    return {
      ok: false,
      error:
        known.length === 0
          ? 'This deployment configures no agentModels.profiles, so there is nothing to pick.'
          : `"${wanted}" is not one of this deployment's profiles: ${known.join(', ')}.`,
    };
  return { ok: true, priced: { origin, profile: wanted } };
}

function readOrder(order: unknown): { ok: true; origins: string[] } | { ok: false; error: string } {
  if (!Array.isArray(order) || order.some((o) => typeof o !== 'string'))
    return { ok: false, error: 'order must be an array of origin strings.' };
  const origins = (order as string[]).map((o) => o.trim()).filter((o) => o !== '');
  if (new Set(origins).size !== origins.length)
    return { ok: false, error: 'order must not name the same origin twice.' };
  return { ok: true, origins };
}

export const queueControl: DesktopToolFactory = (deps) => ({
  description:
    'Steer the "Up next" queue: pin origins to the front in the order you give them, or cancel a queued job ' +
    'before it runs. Pinning only re-orders — it never un-holds a row that is held by a cap, a cooldown, an ' +
    'unapproved plan or a missing watch tag, and those are named in fleet_status as the reason.',
  inputSchema: QUEUE_CONTROL_INPUT,
  handler: async (args) => {
    const hasOrder = args.order !== undefined;
    const cancel = typeof args.cancelJob === 'string' ? args.cancelJob.trim() : '';
    const wantsPrice = args.profile !== undefined || args.origin !== undefined;
    if (!hasOrder && !cancel && !wantsPrice)
      return toolError(
        'Nothing to do — give `order`, `cancelJob`, or `origin` with `profile`. To read the queue, call ' +
          'fleet_status.',
      );

    let priced: Priced | null = null;
    if (wantsPrice) {
      const price = readPrice(deps, args);
      if (!price.ok) return toolError(price.error);
      deps.store.profileOverrides.setProfileOverride(price.priced.origin, price.priced.profile);
      priced = price.priced;
    }

    let pinned: string[] | null = null;
    if (hasOrder) {
      const order = readOrder(args.order);
      if (!order.ok) return toolError(order.error);
      deps.store.priority.setPriorityOverrides(order.origins);
      pinned = order.origins;
    }

    let cancelled: { id: string; title: string } | null = null;
    if (cancel) {
      const job = deps.store.jobs.cancelJob(cancel);
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
