import type {
  AgentFilesPayload,
  AllowanceInsights,
  Ejection,
  EjectionOutcome,
  GoalAgentsPayload,
  AgentTranscript,
  ConfigChange,
  SetupCheck,
  SetupPayload,
  SetupResolvePayload,
  TicketRow,
  QueueItem,
  TicketsPayload,
  AppState,
  BuildReading,
  SnoozeTarget,
  CockpitDecision,
  Decision,
  FeatureBlockRow,
  FeatureBoardPayload,
  FeatureBriefing,
  FeatureChildRow,
  FeatureChildStanding,
  FeatureCounts,
  FeatureLandingRow,
  FeatureReach,
  FeatureReportRow,
  FeatureRollup,
  FeatureSummary,
  GoalWatch,
  GoalWatchDeclaration,
  FilingTargetProbe,
  Issue,
  IssueFiled,
  Job,
  LocalRunView,
  LocalValidationView,
  JobSchedule,
  McpChannelPayload,
  McpInsights,
  McpNaming,
  McpNamingTotal,
  McpPhaseUsage,
  McpQuietTool,
  McpSilentRun,
  McpToolUsage,
  OpenPullRequest,
  PetCatalogue,
  CiPolicyDescription,
  CiSubject,
  PromptTemplateView,
  ReliabilityInsights,
  ThroughputInsights,
  ThroughputMeasure,
  ReviewAttention,
  ReviewCalibration,
  ReviewMark,
  ReviewMarksPayload,
  ReviewPack,
  ReviewRange,
  RemedyCause,
  RemedyInsights,
  RemedyRow,
  RunClearOut,
  RunOutcome,
  RunningConfigGroup,
  Proposal,
  SpendGoal,
  SpendInsights,
  SpendPhase,
  SpendTrend,
  SpendTrendPeriod,
  InsightsWindowView,
  OperatorRow,
  SurfaceRow,
  SurfaceVerdict,
  UsagePayload,
  UsageSubject,
  SpendTrendBucket,
  SpendRun,
  TaskSummary,
  UnrecordedWorkView,
  WorkNodeView,
  WorldEvent,
  WorldEventKind,
  CaveatAnswerInput,
  PlanCaveat,
} from '../types.js';
import type { ReviewPackReading, WsClient } from '../api.js';
import type { ValidationAct } from '../cockpit/actions.js';
import { buildDemoState, demoPlanHistory } from './fixtures.js';
import { isContainerType } from '../issueGroups.js';
import { inFlight } from '../view/localValidation.js';
import { planCaveatsOf } from '../planCaveats.js';
import { buildGoalPage } from '../view/goalPage.js';

// → docs/spec/17-cockpit.md

const ZERO_RATE = { dropChance: 0, pity: 0 };

type Emit = Record<string, unknown>;
interface Conn {
  onEvent: (ev: unknown) => void;
  subs: Set<string>;
}

const CHATTER = [
  'reading changed files …',
  'npm test -w packages/retrieval',
  '  ✓ 128 passing',
  'editing packages/retrieval/src/index.ts',
  'git add -A && git commit -m "wip"',
  'running npm run typecheck …',
  '  build ok · typecheck ok · lint ok',
  'thinking about the next step …',
];

type WatchConfig = { watchLabel: string };

function isWatched(labels: string[] | undefined, config: WatchConfig): boolean {
  return (labels ?? []).includes(config.watchLabel);
}

function applyWatch(labels: string[] | undefined, config: WatchConfig, watched: boolean): string[] {
  const set = new Set(labels ?? []);
  if (watched) set.add(config.watchLabel);
  else set.delete(config.watchLabel);
  return [...set];
}

function dispatchAction(kind: TaskSummary['kind']): Decision['action']['type'] {
  return kind === 'desk' ? 'dispatch_desk_agent' : 'dispatch_code_agent';
}

function goalOriginIssue(originRef: string | null | undefined): number | null {
  const match = /^issue:(\d+)(?::|$)/.exec(originRef ?? '');
  return match ? Number(match[1]) : null;
}

function isLiveTask(task: TaskSummary): boolean {
  return task.status === 'queued' || task.status === 'running' || task.status === 'waiting';
}

function injectedPr(pr: Omit<OpenPullRequest, 'attention' | 'ciVerdict'>): OpenPullRequest {
  return {
    ...pr,
    attention: { status: 'harness', reasons: ['queued for dispatch'] },
    ciVerdict: { actionable: true, dispatch: [], escalate: [], ignored: [], urgent: false },
  };
}

function injectedIssue(
  issue: Omit<
    Issue,
    | 'appraisal'
    | 'conclusion'
    | 'delivery'
    | 'instructions'
    | 'localValidation'
    | 'retrospective'
    | 'scratchpad'
    | 'shortfall'
    | 'pickup'
    | 'spend'
    | 'validation'
  >,
): Issue {
  return {
    ...issue,
    pickup: { eligible: true, status: 'eligible', reasons: [] },
    conclusion: { verdict: 'undeclared', by: null, note: '', at: null },
    shortfall: null,
    delivery: null,
    appraisal: null,
    retrospective: null,
    scratchpad: null,
    instructions: [],
    spend: null,
    validation: null,
    localValidation: null,
  };
}

function toolLines(at: string, tool: string, summary: string, done: string, body: readonly string[]): string[] {
  const count = body.length > 1 ? `\x1b[2m · ${String(body.length)} lines\x1b[0m` : '';
  return [
    `\x1b[2m[${at}]\x1b[0m \x1b[36m⚙ ${tool}\x1b[0m \x1b[2m${summary}\x1b[0m`,
    `\x1b[90m  ↳ result\x1b[0m\x1b[2m [${done}]\x1b[0m${count}`,
    ...body.map((l) => `  ${l}`),
  ];
}

const VALIDATION_TICK_MS = 1800;

const REQUEST_MS = 900;

const VALIDATION_STEPS: readonly ((row: LocalValidationView) => Partial<LocalValidationView>)[] = [
  () => ({ status: 'dispatched', phase: 'planning', dispatchedAt: new Date().toISOString() }),
  () => ({
    phase: 'environment',
    plan: [
      '## What changed',
      '',
      'The catalogue now accepts a per-item schema, and the job form posts one. Three things to drive:',
      '',
      '1. **A job with a schema is accepted.** Open /jobs/new, fill the form with a valid schema and submit.',
      '   A pass is a 201 and the job listed with its schema on /jobs.',
      '2. **A job with no schema is refused.** Submit the same form with the schema field empty.',
      '   A pass is the form staying put with a message naming the field.',
      '3. **An existing job still opens.** Open a job created before this change from /jobs.',
      '   A pass is the detail page rendering with no schema section rather than an error.',
    ].join('\n'),
  }),
  () => ({ phase: 'driving' }),
  () => ({
    status: 'failed',
    phase: null,
    endedAt: new Date().toISOString(),
    summary:
      'Steps 1 and 3 pass: a job with a schema is accepted and listed, and a job from before the change opens ' +
      'with no schema section. Step 2 does not — the form accepts an empty schema and the API takes it, so the ' +
      'validation this change exists to add is not applied on the path a person actually uses.',
    findings: [
      {
        title: 'A job with no schema is accepted',
        detail:
          'Opened /jobs/new, filled in title and payload, left the schema field empty and submitted. Expected the ' +
          'form to stay put naming the field; the request went out and came back 201, and the job is listed with ' +
          'an empty schema.',
        severity: 'blocker',
        url: 'http://localhost:5173/jobs/new',
        screenshot: null,
      },
      {
        title: 'The validation message reads "undefined"',
        detail:
          'Submitting a malformed schema does refuse it, but the message under the field reads "undefined" rather ' +
          'than saying what is wrong with it.',
        severity: 'nit',
        url: 'http://localhost:5173/jobs/new',
        screenshot: null,
      },
    ],
    visited: ['http://localhost:5173/jobs/new', 'http://localhost:5173/jobs'],
    screenshots: [],
    files: [],
  }),
];

const BRINGUP: readonly { phase: string; lines: readonly string[] }[] = [
  {
    phase: 'starting the containers',
    lines: toolLines('09:41:12', 'Bash', 'docker compose up -d', '09:41:38', [
      'Container demo-shop-postgres  Started',
      'Container demo-shop-redis     Started',
    ]),
  },
  {
    phase: 'building the services',
    lines: toolLines('09:41:39', 'Bash', 'npm run build -w api -w worker', '09:42:20', [
      'api     built in 18.2s',
      'worker  built in 21.9s',
    ]),
  },
  {
    phase: 'seeding the sample data',
    lines: [
      'The compose file brings the database up empty, so it needs seeding before the app has anything to draw.',
      ...toolLines('09:42:21', 'Bash', 'npm run seed', '09:42:44', ['seeded 240 invoices across 18 suppliers']),
    ],
  },
  {
    phase: 'starting the web app',
    lines: toolLines('09:42:45', 'Bash', 'npm run dev -- --host', '09:42:47', [
      'VITE ready in 1204 ms',
      '➜  Local:   http://localhost:5173/',
    ]),
  },
];

const DEMO_TIP = 'e4f1c9a7b2d8503f6a19c4e7b0d2f8a1c3e5b7d9';

const MESSAGE_TURN: readonly { phase: string; lines: readonly string[] }[] = [
  {
    phase: 'doing what you asked',
    lines: toolLines('10:01:40', 'Bash', 'npm run db:migrate', '10:01:52', ['Applied 2 migrations', 'Done']),
  },
  { phase: 'done', lines: ['Ran the pending migrations; the API picked the schema up without a restart.'] },
];

const REFRESH_TURN: readonly { phase: string; lines: readonly string[] }[] = [
  {
    phase: 'restarting the api',
    lines: toolLines('10:03:02', 'Bash', 'npm run api:restart', '10:03:09', ['api  restarted on :5001']),
  },
  { phase: 'done', lines: ['Restarted the API for the schema change; the web app hot-reloaded on its own.'] },
];

const TEARDOWN: readonly { phase: string; lines: readonly string[] }[] = [
  {
    phase: 'stopping the web app and the services',
    lines: toolLines('10:02:11', 'Bash', 'npm run stop', '10:02:14', ['vite    stopped', 'api     stopped']),
  },
  {
    phase: 'taking the containers down',
    lines: toolLines('10:02:15', 'Bash', 'docker compose down', '10:02:39', [
      'Container demo-shop-postgres  Removed',
      'Container demo-shop-redis     Removed',
      'Network demo-shop_default     Removed',
    ]),
  },
];

class DemoServer {
  private seed = buildDemoState();
  private state: AppState = this.seed.state;
  private transcripts = new Map<string, string>(Object.entries(this.seed.transcripts));
  private readonly conns = new Set<Conn>();
  private chatterTimer: ReturnType<typeof setInterval> | null = null;
  private beatTimer: ReturnType<typeof setInterval> | null = null;
  private chatterIdx = 0;
  private lines: string[] = [
    'Bringing #395 up on this machine — the compose file first, then the app.',
    ...toolLines('09:12:04', 'Bash', 'docker compose up -d', '09:12:31', [
      'Container demo-shop-postgres  Started',
      'Container demo-shop-redis     Started',
    ]),
    ...toolLines('09:12:32', 'Bash', 'npm run dev -- --host', '09:12:34', ['VITE ready in 1180 ms']),
    'Up on http://localhost:5173. Nothing needed that the instruction did not mention.',
  ];
  private bringUp = BRINGUP.length;
  private teardown = TEARDOWN.length;
  private validating = VALIDATION_STEPS.length;
  private validationSeq = 1;
  private reply = MESSAGE_TURN.length;
  private deskBeats = 0;
  private seq = 1000;

  private id(prefix: string): string {
    return `${prefix}-${++this.seq}`;
  }

  async getState(): Promise<AppState> {
    return structuredClone({
      ...this.state,
      endedAgents: this.state.agents.filter((a) => a.endedAt !== null).length,
    });
  }

  async getGoalAgents(ref: string, prs: readonly number[]): Promise<GoalAgentsPayload> {
    const origins = new Set(prs.map((n) => `pr:${n}`));
    const tasks = this.state.tasks.filter(
      (t) => t.originRef === ref || (t.originRef?.startsWith(`${ref}:`) ?? false) || origins.has(t.originRef ?? ''),
    );
    const ids = new Set(tasks.map((t) => t.id));
    return structuredClone({ ref, agents: this.state.agents.filter((a) => ids.has(a.taskId)), tasks });
  }

  async getTranscript(agentId: string, from = 0): Promise<AgentTranscript> {
    const full = this.transcripts.get(agentId) ?? '';
    const at = Math.min(from, full.length);
    return { agentId, from: at, total: full.length, transcript: full.slice(at) };
  }

  async getAgentFiles(agentId: string): Promise<AgentFilesPayload> {
    return { agentId, files: [] };
  }

  async pulse(): Promise<{ ok: true }> {
    this.addDecision('no_op', 'executed', 'nothing to dispatch this cycle', undefined, 'idle');
    this.emit({ type: 'cycle:end', cycleId: this.id('cycle'), rationale: 'manual pulse' });
    this.dirty();
    return { ok: true };
  }

  async clearErrors(): Promise<{ ok: true; cleared: number }> {
    const cleared = this.state.errors.length;
    this.state.errors = [];
    this.dirty();
    return { ok: true, cleared };
  }

  async inject(event: unknown): Promise<{ ok: true }> {
    this.applyInjection(event as Record<string, unknown>);
    this.dirty();
    return { ok: true };
  }

  async answerQuestions(id: string, answers: (string | null)[]): Promise<{ ok: true }> {
    const esc = this.state.escalations.find((e) => e.id === id);
    const questions = esc?.context?.questions ?? [];
    const reply = questions
      .map((q, i) => {
        const given = answers[i]?.trim() ?? '';
        return `${i + 1}. ${q.question}\n> ${given === '' ? '(no answer)' : given}`;
      })
      .join('\n\n');
    return this.answerEscalation(id, reply);
  }

  async answerEscalation(id: string, response: string): Promise<{ ok: true }> {
    const esc = this.state.escalations.find((e) => e.id === id);
    if (esc) {
      esc.status = 'answered';
      esc.response = response;
      esc.answeredAt = new Date().toISOString();
      const agent = esc.agentId ? this.state.agents.find((a) => a.id === esc.agentId) : null;
      if (agent && agent.status === 'waiting') {
        agent.status = 'running';
        agent.waitingReason = null;
        this.append(agent.id, `\n> human: ${response}\nresuming …`);
      }
      this.addDecision('respond_to_agent', 'executed', `answered escalation for ${esc.context.taskTitle ?? esc.id}`);
    }
    this.dirty();
    return { ok: true };
  }

  async dismissEscalation(id: string, note?: string): Promise<{ ok: true; dismissedAs: string }> {
    const esc = this.state.escalations.find((e) => e.id === id);
    if (esc) {
      esc.status = 'dismissed';
      esc.response = `Dismissed${note ? `: ${note}` : ' without an answer'}`;
      esc.answeredAt = new Date().toISOString();
      const agent = esc.agentId ? this.state.agents.find((a) => a.id === esc.agentId) : null;
      if (agent) agent.resumedAt = null;
      this.addDecision('respond_to_agent', 'executed', `dismissed escalation for ${esc.context.taskTitle ?? esc.id}`);
    }
    this.dirty();
    return { ok: true, dismissedAs: 'cleared' };
  }

  async decidePermission(id: string, allow: boolean, note?: string): Promise<{ ok: true; allowed: boolean }> {
    const esc = this.state.escalations.find((e) => e.id === id);
    if (esc) {
      esc.status = 'answered';
      esc.response = allow ? 'Allowed' : `Denied${note ? `: ${note}` : ''}`;
      esc.answeredAt = new Date().toISOString();
      this.addDecision('respond_to_agent', 'executed', `${allow ? 'allowed' : 'denied'} a permission request`);
    }
    this.dirty();
    return { ok: true, allowed: allow };
  }

  async respondAgent(id: string, text: string): Promise<{ ok: true }> {
    const agent = this.state.agents.find((a) => a.id === id);
    if (agent) {
      if (agent.status === 'waiting') {
        agent.status = 'running';
        agent.waitingReason = null;
      }
      this.append(id, `\n> ${text}`);
      this.dirty();
    }
    return { ok: true };
  }

  async setControl(patch: { cap?: number; paused?: boolean }): Promise<{ ok: true; cap: number; paused: boolean }> {
    if (typeof patch.cap === 'number') this.state.control.cap = Math.max(0, Math.floor(patch.cap));
    if (typeof patch.paused === 'boolean') this.state.control.paused = patch.paused;
    const { cap, paused } = this.state.control;
    this.emit({ type: 'control:changed', cap, paused });
    return { ok: true, cap, paused };
  }

  async setStackLanding(ref: string, landing: boolean): Promise<{ ok: true }> {
    const view = this.state.stackLandings.find((v) => v.ref === ref);
    if (!view) return { ok: true };
    if (!landing) {
      view.landing = null;
      this.addDecision('no_op', 'skipped', `stopped landing ${ref}`);
      this.dirty();
      return { ok: true };
    }
    if (!view.offer) return { ok: true };
    const stack = this.state.stacks.find((st) => st.ref === ref);
    const at = new Date().toISOString();
    view.landing = {
      id: `land_demo_${ref}`,
      ref,
      rungs: (stack?.rungs ?? []).map((r) => r.prNumber),
      status: 'standing',
      reason: null,
      createdAt: at,
      updatedAt: at,
    };
    view.landed = 0;
    this.addDecision('merge_pr', 'executed', `authorized landing ${ref}`);
    this.dirty();
    return { ok: true };
  }

  async setPrWatched(prNumber: number, watched: boolean): Promise<{ ok: true; watched: boolean }> {
    const tag = this.state.config.watchLabel;
    const pr = this.state.world.pullRequests.find((p) => p.number === prNumber);
    if (pr) {
      const labels = new Set(pr.labels ?? []);
      if (watched) labels.add(tag);
      else labels.delete(tag);
      pr.labels = [...labels];
      this.addDecision(
        'no_op',
        'executed',
        `${watched ? 'tagged' : 'untagged'} PR #${prNumber} (${tag})`,
        undefined,
        undefined,
        undefined,
        `pr:${prNumber}`,
      );
      this.dirty();
    }
    return { ok: true, watched };
  }

  async setIssueConclusion(issueNumber: number, verdict: 'done' | 'more_work' | null): Promise<{ ok: true }> {
    const issue = this.state.world.issues.find((i) => i.number === issueNumber);
    if (issue) {
      issue.conclusion =
        verdict === null
          ? { verdict: 'undeclared', by: null, note: '', at: null }
          : { verdict, by: 'operator', note: 'Set by the operator from the cockpit.', at: new Date().toISOString() };
      this.addDecision(
        'no_op',
        'executed',
        `issue #${issueNumber} → ${verdict ?? 'unconcluded'}`,
        undefined,
        undefined,
        undefined,
        `issue:${issueNumber}`,
      );
      this.dirty();
    }
    return { ok: true };
  }

  async addInstruction(issueNumber: number, text: string): Promise<{ ok: true }> {
    const issue = this.state.world.issues.find((i) => i.number === issueNumber);
    if (issue) {
      const at = new Date().toISOString();
      issue.instructions = [
        ...issue.instructions,
        {
          id: `ins_${issue.instructions.length + 1}_${issueNumber}`,
          originRef: `issue:${issueNumber}`,
          text,
          createdAt: at,
          settledAt: null,
        },
      ];
      if (!issue.delivery)
        issue.conclusion = {
          verdict: 'more_work',
          by: 'operator',
          note: 'The operator wrote an instruction for this goal — it is in front of the next agent.',
          at,
        };
      this.addDecision(
        'no_op',
        'executed',
        `issue #${issueNumber} → instruction`,
        undefined,
        undefined,
        undefined,
        `issue:${issueNumber}`,
      );
      this.dirty();
    }
    return { ok: true };
  }

  async releaseEnvironmentGate(issueNumber: number, released: boolean, note?: string): Promise<{ ok: true }> {
    const reach = (this.state.environmentReach ?? []).find((r) => r.goalRef === `issue:${issueNumber}`);
    if (reach) {
      reach.released = released
        ? { goalRef: reach.goalRef, note: note ?? '', releasedAt: new Date().toISOString() }
        : null;
      if (released) reach.gateHold = null;
    }
    return { ok: true };
  }

  async overruleShortfall(issueNumber: number, text: string): Promise<{ ok: true }> {
    const issue = this.state.world.issues.find((i) => i.number === issueNumber);
    if (issue?.shortfall) {
      const at = new Date().toISOString();
      issue.delivery = { summary: text, by: 'operator', decidedAt: at };
      issue.shortfall = null;
      issue.instructions = [
        ...issue.instructions,
        {
          id: `ins_${issue.instructions.length + 1}_${issueNumber}`,
          originRef: `issue:${issueNumber}`,
          text,
          createdAt: at,
          settledAt: null,
        },
      ];
      this.addDecision(
        'no_op',
        'executed',
        `issue #${issueNumber} → shortfall overruled`,
        undefined,
        undefined,
        undefined,
        `issue:${issueNumber}`,
      );
      this.dirty();
    }
    return { ok: true };
  }

  async withdrawInstruction(issueNumber: number, id: string): Promise<{ ok: true }> {
    const issue = this.state.world.issues.find((i) => i.number === issueNumber);
    if (issue) {
      issue.instructions = issue.instructions.filter((i) => i.id !== id);
      if (
        issue.instructions.length === 0 &&
        issue.conclusion.by === 'operator' &&
        issue.conclusion.verdict === 'more_work'
      )
        issue.conclusion = { verdict: 'undeclared', by: null, note: '', at: null };
      this.dirty();
    }
    return { ok: true };
  }

  async reopenPrThread(prNumber: number, threadId: string, reopened: boolean): Promise<{ ok: true }> {
    const pr = this.state.world.pullRequests.find((p) => p.number === prNumber);
    const thread = pr?.reviewThreads?.find((t) => t.id === threadId);
    if (pr && thread) {
      thread.state = reopened ? 'reopened' : thread.replies.some((r) => r.ours) ? 'answered' : 'open';
      if (reopened) thread.reopenedAt = new Date().toISOString();
      else delete thread.reopenedAt;
      pr.unresolvedComments = (pr.reviewThreads ?? []).map((t) => ({
        id: t.id,
        author: t.author,
        body: t.body,
        handled: t.state === 'answered' || t.state === 'resolved',
      }));
      this.dirty();
    }
    return { ok: true };
  }

  async setIssueAppraisal(issueNumber: number, verdict: 'workable' | 'unclear' | null): Promise<{ ok: true }> {
    const issue = this.state.world.issues.find((i) => i.number === issueNumber);
    if (issue) {
      issue.appraisal =
        verdict === null
          ? null
          : {
              verdict,
              missing: [],
              by: 'operator',
              commentRef: null,
              proposedProfile: null,
              awaitingProfileAnswer: false,
              placement: [],
              parentSettledAt: null,
              summary: 'Set by the operator from the cockpit.',
              decidedAt: new Date().toISOString(),
            };
      this.addDecision(
        'no_op',
        'executed',
        `issue #${issueNumber} → ${verdict ?? 'unappraised'}`,
        undefined,
        undefined,
        undefined,
        `issue:${issueNumber}`,
      );
      this.dirty();
    }
    return { ok: true };
  }

  async dismissRun(issueNumber: number, note?: string): Promise<{ ok: true; cleared: RunClearOut }> {
    const present = this.state.world.issues.find((i) => i.number === issueNumber);
    const forgotten = (this.state.retainedRuns ?? []).find((i) => i.number === issueNumber);
    const target = present ?? forgotten;
    const cleared: RunClearOut = { agents: 0, jobs: 0, instructions: 0 };
    if (target?.run) {
      target.run = { ...target.run, dismissed: true };
      for (const agent of this.state.agents) {
        const task = this.state.tasks.find((t) => t.id === agent.taskId);
        if (goalOriginIssue(task?.originRef ?? null) !== issueNumber) continue;
        if (agent.status === 'done' || agent.endedAt !== null) continue;
        await this.killAgent(agent.id);
        cleared.agents += 1;
      }
      for (const job of this.state.jobs) {
        if (job.status !== 'queued' || goalOriginIssue(job.originRef) !== issueNumber) continue;
        await this.cancelJob(job.id);
        cleared.jobs += 1;
      }
      if (present) {
        cleared.instructions = present.instructions.length;
        present.instructions = [];
      }
      this.addDecision(
        'no_op',
        'executed',
        `issue #${issueNumber} run dismissed${note === undefined ? '' : ` — ${note}`}`,
        undefined,
        undefined,
        undefined,
        `issue:${issueNumber}`,
      );
      this.dirty();
    }
    return { ok: true, cleared };
  }

  async setIssueProfile(issueNumber: number, profile: string | null): Promise<{ ok: true }> {
    const issue = this.state.world.issues.find((i) => i.number === issueNumber);
    if (issue) {
      issue.modelPin = { profile, ignoredTags: [] };
      if (issue.appraisal) issue.appraisal = { ...issue.appraisal, awaitingProfileAnswer: false };
      this.dirty();
    }
    return { ok: true };
  }

  async setIssueParent(issueNumber: number, parent: number | null): Promise<{ ok: true }> {
    const issue = this.state.world.issues.find((i) => i.number === issueNumber);
    if (issue) {
      const container = parent === null ? null : this.state.world.issues.find((i) => i.number === parent);
      if (parent !== null && container)
        issue.parent = {
          number: container.number,
          title: container.title,
          issueType: container.issueType ?? 'Feature',
          workItemState: container.workItemState ?? 'Active',
          state: container.state,
        };
      this.settlePlacement(issueNumber, 'parent');
    }
    return { ok: true };
  }

  async setIssueAreaPath(issueNumber: number, areaPath: string | null): Promise<{ ok: true }> {
    const issue = this.state.world.issues.find((i) => i.number === issueNumber);
    if (issue) {
      if (areaPath !== null) issue.areaPath = areaPath;
      this.settlePlacement(issueNumber, 'areaPath');
    }
    return { ok: true };
  }

  private settlePlacement(issueNumber: number, field: 'parent' | 'areaPath'): void {
    const issue = this.state.world.issues.find((i) => i.number === issueNumber);
    if (!issue?.appraisal) return;
    issue.appraisal = { ...issue.appraisal, placement: issue.appraisal.placement.filter((p) => p.field !== field) };
    this.dirty();
  }

  async setPartProfile(planId: string, slug: string, profile: string | null): Promise<{ ok: true }> {
    const part = (this.state.planParts ?? []).find((p) => p.planId === planId && p.slug === slug);
    if (part) {
      part.profile = profile;
      this.dirty();
    }
    return { ok: true };
  }

  async restartPart(planId: string, slug: string): Promise<{ ok: true; detail: string }> {
    const part = (this.state.planParts ?? []).find((p) => p.planId === planId && p.slug === slug);
    if (!part?.prNumber) return { ok: true, detail: 'nothing to restart' };
    const prNumber = part.prNumber;
    this.state.world.pullRequests = this.state.world.pullRequests.filter((p) => p.number !== prNumber);
    part.status = 'ready';
    part.prNumber = null;
    part.branch = null;
    this.dirty();
    return { ok: true, detail: `closed PR #${prNumber} and put "${slug}" back to ready` };
  }

  async regroupPlan(
    planId: string,
    groups: { slug: string; atoms: string[]; title?: string; scope?: string }[],
  ): Promise<{ ok: true; detail: string }> {
    const parts = (this.state.planParts ?? []).filter((p) => p.planId === planId);
    const byGroup = new Map(groups.map((g) => [g.slug, g]));
    for (const part of parts) {
      const group = byGroup.get(part.slug);
      part.atoms = group?.atoms ?? [];
    }
    this.state.planParts = [
      ...parts.filter((p) => byGroup.has(p.slug)),
      ...(this.state.planParts ?? []).filter((p) => p.planId !== planId),
    ];
    this.dirty();
    return { ok: true, detail: `regrouped into ${groups.length} part(s)` };
  }

  async setIssueWatched(issueNumber: number, watched: boolean): Promise<{ ok: true; watched: boolean }> {
    const issue = this.state.world.issues.find((i) => i.number === issueNumber);
    if (issue) {
      const containerTypes = this.state.config.containerTypes;
      const byNumber = new Map(this.state.world.issues.map((i) => [i.number, i]));
      const targets = new Set([issueNumber]);
      if (isContainerType(issue, containerTypes)) {
        const queue = [issue];
        while (queue.length > 0) {
          const next = queue.shift();
          if (next === undefined) break;
          for (const kid of next.children ?? []) {
            if (targets.has(kid.number)) continue;
            targets.add(kid.number);
            const held = byNumber.get(kid.number);
            if (held !== undefined) queue.push(held);
          }
        }
      }
      for (const target of targets) {
        const row = byNumber.get(target);
        if (row) row.labels = applyWatch(row.labels, this.state.config, watched);
      }
      this.addDecision(
        'no_op',
        'executed',
        `${watched ? 'watching' : 'ignoring'} issue #${issueNumber}`,
        undefined,
        undefined,
        undefined,
        `issue:${issueNumber}`,
      );
      if (watched)
        this.trySpawn('code', `Implement issue #${issueNumber}`, `issue/${issueNumber}`, `issue:${issueNumber}`);
      this.dirty();
    }
    return { ok: true, watched };
  }

  async setIssueState(issueNumber: number, state: string): Promise<{ ok: true; state: string }> {
    DEMO_STATE_MOVES.set(issueNumber, state);
    const issue = this.state.world.issues.find((i) => i.number === issueNumber);
    if (issue) issue.workItemState = state;
    this.addDecision(
      'no_op',
      'executed',
      `moving issue #${issueNumber} to "${state}"`,
      undefined,
      undefined,
      undefined,
      `issue:${issueNumber}`,
    );
    this.dirty();
    return { ok: true, state };
  }

  async setFeaturePaused(issueNumber: number, paused: boolean): Promise<{ ok: true; paused: boolean }> {
    if (paused) DEMO_FEATURE_PAUSES.set(issueNumber, new Date().toISOString());
    else DEMO_FEATURE_PAUSES.delete(issueNumber);
    this.dirty();
    return { ok: true, paused };
  }

  async setGoalPriority(issueNumber: number, priority: boolean): Promise<{ ok: true; priority: boolean }> {
    const issue = this.state.world.issues.find((i) => i.number === issueNumber);
    if (issue) {
      issue.priority = priority ? { since: new Date().toISOString() } : null;
      this.dirty();
    }
    return { ok: true, priority };
  }

  async replan(planId: string): Promise<{ ok: true }> {
    const plan = (this.state.plans ?? []).find((p) => p.id === planId);
    if (plan) {
      plan.status = 'planning';
      plan.updatedAt = new Date().toISOString();
      this.addDecision('dispatch_code_agent', 'executed', `replanning ${plan.title}`, 'issue-plan');
      this.dirty();
    }
    return { ok: true };
  }

  async extendWatch(issueNumber: number, environment: string): Promise<{ ok: true }> {
    const window = (this.state.goalWatchWindows ?? []).find(
      (w) => w.goalRef === `issue:${issueNumber}` && w.environment === environment,
    );
    if (window) {
      const now = new Date();
      window.settledAt = null;
      window.extendedAt = now.toISOString();
      window.settlesAt = new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString();
      this.dirty();
    }
    return { ok: true };
  }

  ruleRemoteQuery(issueNumber: number, environment: string, rowId: string, accept: boolean): Promise<{ ok: true }> {
    const sheet = (this.state.remoteSheets ?? []).find(
      (s) => s.goalRef === `issue:${issueNumber}` && s.environment === environment,
    );
    const row = sheet?.rows.find((r) => r.rowId === rowId);
    if (row !== undefined) {
      row.awaitingApproval = false;
      row.blockedReason = accept
        ? null
        : `an operator declined this query against ${environment}, so nothing here was put to its store.`;
      if (accept)
        row.reading = {
          goalRef: sheet!.goalRef,
          environment,
          rowId,
          runId: null,
          outcome: 'passed',
          rows: 0,
          value: null,
          detail: null,
          readAt: new Date().toISOString(),
        };
      this.dirty();
    }
    return Promise.resolve({ ok: true });
  }

  async ruleWatchProposal(issueNumber: number, checkId: string, accept: boolean): Promise<{ ok: true }> {
    const origin = `issue:${issueNumber}`;
    const watches = this.state.goalWatches ?? [];
    const check = watches.find((w) => w.originRef === origin && w.id === checkId);
    if (check?.proposal) {
      if (!accept && !check.live) this.state.goalWatches = watches.filter((w) => w !== check);
      else if (accept) Object.assign(check, check.proposal.declaration, { live: true, proposal: null });
      else check.proposal = null;
      this.dirty();
    }
    return { ok: true };
  }

  async saveWatchCheck(issueNumber: number, check: GoalWatchDeclaration): Promise<{ ok: true; dryRun: string[] }> {
    const originRef = `issue:${issueNumber}`;
    const watches = this.state.goalWatches ?? [];
    const existing = watches.find((w) => w.originRef === originRef && w.id === check.id);
    const seq = existing?.seq ?? watches.filter((w) => w.originRef === originRef).length + 1;
    const saved: GoalWatch = {
      originRef,
      seq,
      id: check.id,
      kind: check.kind,
      title: check.title,
      query: check.query,
      presence: check.kind === 'signal' ? check.presence : null,
      tolerate: check.kind === 'signal' ? check.tolerate : 0,
      expectUnder: check.kind === 'measure' ? (check.expect.under ?? null) : null,
      expectOver: check.kind === 'measure' ? (check.expect.over ?? null) : null,
      expectBaseline: check.kind === 'measure' && check.expect.noWorseThan === 'baseline',
      unit: check.kind === 'measure' ? (check.unit ?? null) : null,
      why: check.why ?? null,
      baselineValue: null,
      baselineAt: null,
      live: true,
      proposal: null,
      authored: 'operator',
      dryRunEnvironment: null,
      dryRunAt: null,
      dryRunVerdict: null,
      dryRunPresence: null,
      dryRunRows: null,
      dryRunDetail: null,
    };
    this.state.goalWatches =
      existing === undefined ? [...watches, saved] : watches.map((w) => (w === existing ? saved : w));
    this.dirty();
    return { ok: true, dryRun: [] };
  }

  async deleteWatchCheck(issueNumber: number, checkId: string): Promise<{ ok: true }> {
    const originRef = `issue:${issueNumber}`;
    this.state.goalWatches = (this.state.goalWatches ?? []).filter(
      (w) => !(w.originRef === originRef && w.id === checkId),
    );
    this.dirty();
    return { ok: true };
  }

  async setValidation(issueNumber: number, checkId: string, act: ValidationAct): Promise<{ ok: true }> {
    const origin = `issue:${issueNumber}`;
    const check = (this.state.validationChecks ?? []).find((c) => c.originRef === origin && c.id === checkId);
    if (check && check.supersededReason === null) {
      if (act.kind === 'handover') {
        if (act.to === 'fleet' && check.state !== 'unrun') return { ok: true };
        check.actor = act.to;
        if (act.to === 'fleet') check.handbackNote = null;
        this.dirty();
        return { ok: true };
      }
      const state =
        act.kind === 'result'
          ? act.result
          : act.kind === 'defer'
            ? 'deferred'
            : act.kind === 'waive'
              ? 'waived'
              : 'unrun';
      check.state = state;
      check.resultNote =
        act.kind === 'result' ? (act.note.length > 0 ? act.note : null) : act.kind === 'reset' ? null : act.reason;
      check.resultBy = act.kind === 'reset' ? null : 'operator';
      check.resultAt = act.kind === 'reset' ? null : new Date().toISOString();
      check.deferUntil = null;
      check.handbackNote = null;
      check.claimedBy = null;
      check.claimedAt = null;
      this.dirty();
    }
    return { ok: true };
  }

  getBuild(): BuildReading {
    return this.state.build;
  }

  async pullProject(): Promise<{ ok: true; build: BuildReading }> {
    const build = this.state.build;
    const project = build.project;
    if (project && project.unavailable === null && !project.dirty && project.branch === 'main') {
      build.project = {
        ...project,
        head: project.upstream,
        behind: 0,
        commits: [],
        checkedAt: new Date().toISOString(),
      };
      build.projectPull = { can: false, blocked: 'the project checkout is up to date — there is nothing to pull' };
      this.dirty();
    }
    return { ok: true, build };
  }

  async snoozeUpdate(target: SnoozeTarget): Promise<{ ok: true; build: BuildReading }> {
    const build = this.state.build;
    build.snoozedUntil = { ...build.snoozedUntil, [target]: new Date(Date.now() + 30 * 60 * 1000).toISOString() };
    this.dirty();
    return { ok: true, build };
  }

  async upgrade(action: string): Promise<{ ok: true; build: BuildReading }> {
    const build = this.state.build;
    if (action === 'drain' && build.intent.state === 'idle') {
      build.intent = {
        state: 'draining',
        targetSha: build.standing.upstream,
        requestedAt: new Date().toISOString(),
        pausedByDrain: true,
      };
      build.state = 'draining';
      build.label = `draining ${build.live}`;
      this.dirty();
    }
    if (action === 'cancel' && build.intent.state !== 'idle') {
      build.intent = { state: 'idle', targetSha: null, requestedAt: null, pausedByDrain: false };
      build.state = 'behind';
      build.label = `${build.standing.behind} behind`;
      this.dirty();
    }
    return { ok: true, build };
  }

  async openPet(id: string): Promise<{ ok: true }> {
    const pet = this.state.pets?.pets.find((p) => p.id === id);
    if (pet && pet.openedAt === null) {
      pet.openedAt = new Date().toISOString();
      this.dirty();
    }
    return { ok: true };
  }

  async feedPet(id: string, beats: number): Promise<{ ok: true }> {
    const pets = this.state.pets;
    const pet = pets?.pets.find((p) => p.id === id);
    if (pets && pet && beats > 0 && beats <= pets.wallet.balance) {
      pet.fed += beats;
      if (pet.beatsToNextStage !== null) {
        const left = pet.beatsToNextStage - beats;
        pet.beatsToNextStage = left > 0 ? left : null;
        if (left <= 0) pet.stage = pet.stage === 'hatchling' ? 'juvenile' : 'adult';
      }
      pets.wallet.spent += beats;
      pets.wallet.balance = Math.max(0, pets.wallet.earned - pets.wallet.spent);
      this.dirty();
    }
    return { ok: true };
  }

  async renamePet(id: string, name: string): Promise<{ ok: true }> {
    const pet = this.state.pets?.pets.find((p) => p.id === id);
    if (pet) {
      pet.name = name.trim().length === 0 ? null : name.trim();
      this.dirty();
    }
    return { ok: true };
  }

  async placePet(id: string, placed: boolean): Promise<{ ok: true }> {
    const pets = this.state.pets;
    const pet = pets?.pets.find((p) => p.id === id);
    if (pets && pet && (!placed || pets.pets.filter((p) => p.placed).length < pets.slots)) {
      pet.placed = placed;
      this.dirty();
    }
    return { ok: true };
  }

  async blendPet(id: string): Promise<{ ok: true }> {
    const pets = this.state.pets;
    const pet = pets?.pets.find((p) => p.id === id);
    const live = pets?.pets.filter((p) => p.species === pet?.species && p.dissolvedAt === null).length ?? 0;
    if (pets && pet && pet.dissolvedAt === null && live > 1) {
      pet.dissolvedAt = new Date().toISOString();
      pet.placed = false;
      pets.wallet.earned += 500;
      pets.wallet.balance = Math.max(0, pets.wallet.earned - pets.wallet.spent);
      this.dirty();
    }
    return { ok: true };
  }

  async completeHumanTask(id: string, note?: string): Promise<{ ok: true }> {
    return this.settleHumanTask(id, 'done', note ?? null);
  }

  async declineHumanTask(id: string, note: string): Promise<{ ok: true }> {
    return this.settleHumanTask(id, 'declined', note);
  }

  async closeHumanTaskTicket(id: string, note?: string): Promise<{ ok: true }> {
    const task = (this.state.humanTasks ?? []).find((t) => t.id === id);
    const number = task?.originRef?.startsWith('issue:') === true ? Number(task.originRef.slice('issue:'.length)) : NaN;
    const issue = Number.isInteger(number) ? this.state.world.issues.find((i) => i.number === number) : undefined;
    if (issue) issue.state = 'closed';
    return this.settleHumanTask(id, 'done', note ?? `Closed #${number} in the tracker from the cockpit.`);
  }

  async dismissHumanTask(id: string): Promise<{ ok: true }> {
    const task = (this.state.humanTasks ?? []).find((t) => t.id === id);
    if (task && task.status !== 'open' && !task.dismissedAt) {
      task.dismissedAt = new Date().toISOString();
      task.updatedAt = task.dismissedAt;
      this.dirty();
    }
    return { ok: true };
  }

  private settleHumanTask(id: string, status: 'done' | 'declined', note: string | null): { ok: true } {
    const task = (this.state.humanTasks ?? []).find((t) => t.id === id);
    if (task && task.status === 'open') {
      task.status = status;
      task.resolution = note;
      task.updatedAt = new Date().toISOString();
      task.resolvedAt = task.updatedAt;
      this.dirty();
    }
    return { ok: true };
  }

  async acceptProposal(
    id: string,
    note?: string,
    acknowledged?: string[],
    answers?: CaveatAnswerInput[],
  ): Promise<{ ok: boolean; detail: string }> {
    const proposal = (this.state.proposals ?? []).find((p) => p.id === id);
    if (!proposal || proposal.status !== 'pending') return { ok: false, detail: 'already decided' };
    const raised = planCaveatsOf(proposal);
    const unticked = raised.filter((c) => !(acknowledged ?? []).includes(c.id));
    if (unticked.length > 0) return { ok: false, detail: `${unticked.length} thing(s) still to acknowledge` };
    this.recordCaveatAnswers(proposal, raised, answers ?? []);
    this.settle(proposal, 'accepted', note);
    const prNumber = proposal.action.prNumber as number | undefined;
    const pr = this.state.world.pullRequests.find((p) => p.number === prNumber);
    let detail: string;
    if (proposal.kind === 'merge') {
      if (pr) pr.merged = true;
      detail = `Merged PR #${prNumber} — authorized by you (${proposal.id}).`;
      this.addWorldEvent('pr_merged', `pr:${prNumber}`, `PR #${prNumber} merged on your approval`);
    } else {
      const comment = pr?.unresolvedComments.find((c) => c.id === proposal.action.commentId);
      if (comment) comment.handled = true;
      detail = `Sent the reply on PR #${prNumber} — authorized by you (${proposal.id}).`;
    }
    this.addDecision(proposal.action.type, 'executed', detail);
    this.dirty();
    return { ok: true, detail };
  }

  private recordCaveatAnswers(proposal: Proposal, raised: PlanCaveat[], answers: CaveatAnswerInput[]): void {
    const planId = proposal.action.planId;
    if (proposal.kind !== 'plan' || typeof planId !== 'string') return;
    const at = new Date().toISOString();
    for (const { id, answer } of answers) {
      const caveat = raised.find((c) => c.id === id);
      const words = answer.trim();
      if (!caveat || words === '') continue;
      this.state.planCaveatAnswers = [
        ...(this.state.planCaveatAnswers ?? []),
        { id: `pca-${planId}-${caveat.id}`, planId, caveatId: caveat.id, label: caveat.label, answer: words, at },
      ];
    }
  }

  async rejectProposal(id: string, note?: string): Promise<{ ok: boolean; detail: string }> {
    const proposal = (this.state.proposals ?? []).find((p) => p.id === id);
    if (!proposal || proposal.status !== 'pending') return { ok: false, detail: 'already decided' };
    this.settle(proposal, 'rejected', note);
    const detail = `Rejected by you${proposal.note ? `: ${proposal.note}` : ''} — nothing was sent (${proposal.id}).`;
    this.addDecision(proposal.action.type, 'skipped', detail);
    this.dirty();
    return { ok: true, detail };
  }

  async backOutProposal(
    id: string,
    verdict: 'close' | 'hold',
    note?: string,
  ): Promise<{ ok: boolean; detail: string }> {
    const proposal = (this.state.proposals ?? []).find((p) => p.id === id);
    if (!proposal || proposal.status !== 'pending' || proposal.kind !== 'plan')
      return { ok: false, detail: 'already decided' };
    this.settle(proposal, 'rejected', note);
    const originRef = String(proposal.action.originRef ?? '');
    const issueNumber = Number(originRef.split(':')[1]);
    const issue = this.state.world.issues.find((i) => i.number === issueNumber);
    if (issue) {
      issue.labels = issue.labels.filter((l) => !l.endsWith('-watch'));
      if (verdict === 'close') issue.state = 'closed';
    }
    const plan = this.state.plans?.find((p) => p.id === proposal.action.planId);
    if (plan) plan.status = verdict === 'close' ? 'abandoned' : 'planning';
    const what = verdict === 'close' ? 'Closed the ticket' : 'Put the ticket on hold';
    const consequence =
      verdict === 'close'
        ? `commented on #${issueNumber}, closed it as not planned and abandoned its plan`
        : `dropped the watch tag on #${issueNumber} and sent the plan back — watching it again writes a fresh one`;
    const detail = `${what} by you${proposal.note ? `: ${proposal.note}` : ''} — nothing was scheduled; ${consequence} (${proposal.id}).`;
    this.addDecision(proposal.action.type, 'skipped', detail);
    this.dirty();
    return { ok: true, detail };
  }

  private settle(proposal: Proposal, status: 'accepted' | 'rejected', note?: string): void {
    proposal.status = status;
    proposal.note = note?.trim() || null;
    proposal.decidedBy = 'human';
    proposal.decidedAt = new Date().toISOString();
    const esc = this.state.escalations.find((e) => e.id === proposal.escalationId);
    if (esc && esc.status === 'open') {
      esc.status = 'answered';
      esc.response = `${status === 'accepted' ? 'Accepted' : 'Rejected'}${proposal.note ? `: ${proposal.note}` : '.'}`;
      esc.answeredAt = proposal.decidedAt;
    }
  }

  startLocalRun(issue: number, ref?: string): Promise<{ ok: true; run: LocalRunView }> {
    const now = new Date().toISOString();
    const target = this.state.localRunTargets.find((t) => t.issueNumber === issue) ?? null;
    const chosen = ref === undefined ? null : (target?.options.find((o) => o.option.ref === ref) ?? null);
    const facts = chosen?.facts ?? target?.target ?? null;
    const starting: LocalRunView = {
      id: `run-${String(this.state.localRun === null ? 2 : Number(this.state.localRun.id.split('-')[1] ?? 1) + 1)}`,
      originRef: `issue:${String(issue)}`,
      ref: ref ?? facts?.ref ?? 'main',
      dir: '/Users/you/code/demo-shop/.lubbdubb/local-run',
      commit: DEMO_TIP,
      pid: 48000 + issue,
      status: 'starting',
      turn: 'start',
      holdsSession: true,
      ports: null,
      freshness: null,
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      numTurns: null,
      url: 'http://localhost:5173',
      note: null,
      startedAt: now,
      endedAt: null,
      interruptedAt: null,
      lastSeenAt: now,
      live: true,
      phase: null,
      refFacts: facts,
    };
    this.state.localRun = starting;
    this.lines = [`Bringing #${String(issue)} up on this machine — the compose file first, then the app.`];
    this.bringUp = 0;
    this.advanceBringUp();
    return Promise.resolve({ ok: true as const, run: this.state.localRun ?? starting });
  }

  private advanceBringUp(): void {
    const run = this.state.localRun;
    if (run === null || run.status !== 'starting') return;
    const step = BRINGUP[this.bringUp];
    if (step === undefined) {
      const at = new Date().toISOString();
      this.state.localRun = {
        ...run,
        status: 'running',
        phase: null,
        turn: null,
        note: 'Up on http://localhost:5173.',
        ports: {
          checkedAt: at,
          declared: { url: 'http://localhost:5173', host: 'localhost', port: 5173, answering: true },
          listening: [5173, 5432],
        },
        freshness: { checkedAt: at, behindTip: 0, base: { ref: 'main', behind: 0 } },
      };
      this.dirty();
      return;
    }
    this.bringUp += 1;
    this.lines = [...this.lines, `phase: ${step.phase}`, ...step.lines];
    this.state.localRun = { ...run, phase: step.phase, ...localRunSpent(run, 0.06) };
    this.dirty();
  }

  validateLocally(issue: number, opts: { swap?: boolean; refresh?: boolean } = {}): Promise<{ ok: true }> {
    const goal = this.state.world.issues.find((i) => i.number === issue);
    if (goal === undefined) return Promise.reject(new Error(`#${String(issue)} is not a goal here.`));
    if (goal.localValidation !== null && inFlight(goal.localValidation))
      return Promise.reject(new Error(`#${String(issue)} is already being validated locally.`));
    const target = this.state.localRunTargets.find((t) => t.issueNumber === issue);
    if (target?.runnable !== true)
      return Promise.reject(new Error(`#${String(issue)} has no branch of its own to run.`));
    const live = this.state.localRun;
    if (live !== null && live.live && live.originRef !== `issue:${String(issue)}` && opts.swap !== true) {
      const running = /^issue:(\d+)$/.exec(live.originRef)?.[1] ?? live.originRef;
      return Promise.reject(
        new Error(
          `#${running} is running locally on ${live.ref} (${live.status}). Validating #${String(issue)} stops it ` +
            'first, which takes as long as this project takes to shut down. Send `swap` to go ahead.',
        ),
      );
    }
    if (live === null || !live.live || live.originRef !== `issue:${String(issue)}`) void this.startLocalRun(issue);
    const now = new Date().toISOString();
    const run = this.state.localRun;
    goal.localValidation = {
      id: `lv-${String(issue)}-${String(this.validationSeq++)}`,
      originRef: `issue:${String(issue)}`,
      runId: run?.id ?? 'run-1',
      ref: run?.ref ?? 'main',
      commit: run?.commit ?? DEMO_TIP,
      status: 'pending',
      requestedAt: now,
      dispatchedAt: null,
      endedAt: null,
      taskId: null,
      fixTaskId: null,
      plan: null,
      summary: null,
      findings: [],
      visited: [],
      screenshots: [],
      note: null,
      phase: 'queued',
      files: [],
      agent: null,
      fixAgent: null,
    };
    this.validating = 0;
    this.dirty();
    this.armValidation(issue);
    return new Promise((resolve) => setTimeout(() => resolve({ ok: true as const }), REQUEST_MS));
  }

  cancelLocalValidation(issue: number): Promise<{ ok: true }> {
    const goal = this.state.world.issues.find((i) => i.number === issue);
    const row = goal?.localValidation ?? null;
    if (goal === undefined || row === null || !inFlight(row))
      return Promise.reject(new Error(`Nothing is being validated locally on #${String(issue)}.`));
    goal.localValidation = {
      ...row,
      status: 'abandoned',
      phase: null,
      endedAt: new Date().toISOString(),
      note: 'called off from the cockpit',
    };
    this.dirty();
    return Promise.resolve({ ok: true as const });
  }

  private armValidation(issue: number): void {
    setTimeout(() => {
      this.advanceValidation(issue);
    }, VALIDATION_TICK_MS);
  }

  private advanceValidation(issue: number): void {
    const goal = this.state.world.issues.find((i) => i.number === issue);
    const row = goal?.localValidation ?? null;
    if (goal === undefined || row === null || !inFlight(row)) return;
    const step = VALIDATION_STEPS[this.validating];
    if (step === undefined) return;
    this.validating += 1;
    goal.localValidation = { ...row, ...step(row) };
    this.dirty();
    if (VALIDATION_STEPS[this.validating] !== undefined) this.armValidation(issue);
  }

  stopLocalRun(): Promise<{ ok: true }> {
    if (this.state.localRun !== null) {
      this.state.localRun = { ...this.state.localRun, status: 'stopping', turn: 'stop', phase: null };
      this.lines = [...this.lines, 'phase: stopping the containers'];
      this.teardown = 0;
      this.dirty();
    }
    return Promise.resolve({ ok: true as const });
  }

  messageLocalRun(text: string): Promise<{ ok: true }> {
    const run = this.state.localRun;
    if (run === null || run.status !== 'running' || run.turn !== null)
      return Promise.reject(new Error('Nothing is running locally that can be told anything right now.'));
    this.lines = [...this.lines, `› ${text}`];
    this.state.localRun = { ...run, turn: 'message', phase: null };
    this.reply = 0;
    this.dirty();
    return Promise.resolve({ ok: true as const });
  }

  refreshLocalRun(): Promise<{ ok: true; run: LocalRunView }> {
    const run = this.state.localRun;
    if (run === null || run.status !== 'running' || run.turn !== null)
      return Promise.reject(new Error('Nothing is running locally that can be refreshed right now.'));
    if (run.freshness === null || run.freshness.behindTip === null || run.freshness.behindTip === 0)
      return Promise.reject(
        new Error(`The checkout is already at the tip of ${run.ref}; there is nothing to pick up.`),
      );
    const at = new Date().toISOString();
    const refreshed: LocalRunView = {
      ...run,
      commit: DEMO_TIP,
      turn: 'refresh',
      phase: null,
      freshness: { ...run.freshness, checkedAt: at, behindTip: 0 },
    };
    this.state.localRun = refreshed;
    this.lines = [...this.lines, `phase: the checkout moved to ${DEMO_TIP.slice(0, 7)}`];
    this.reply = 0;
    this.dirty();
    return Promise.resolve({ ok: true as const, run: refreshed });
  }

  private advanceTurn(): void {
    const run = this.state.localRun;
    if (run === null || run.status !== 'running' || (run.turn !== 'message' && run.turn !== 'refresh')) return;
    const script = run.turn === 'refresh' ? REFRESH_TURN : MESSAGE_TURN;
    const step = script[this.reply];
    if (step === undefined) {
      this.state.localRun = { ...run, turn: null, phase: null };
      this.dirty();
      return;
    }
    this.reply += 1;
    this.lines = [...this.lines, `phase: ${step.phase}`, ...step.lines];
    this.state.localRun = { ...run, phase: step.phase, ...localRunSpent(run, 0.02) };
    this.dirty();
  }

  private advanceTeardown(): void {
    const run = this.state.localRun;
    if (run === null || run.status !== 'stopping') return;
    const step = TEARDOWN[this.teardown];
    if (step === undefined) {
      this.state.localRun = {
        ...run,
        status: 'stopped',
        live: false,
        phase: null,
        turn: null,
        ports: null,
        freshness: null,
        endedAt: new Date().toISOString(),
        note: 'stopped from the cockpit — 6 containers stopped, :5173 is free',
      };
      this.dirty();
      return;
    }
    this.teardown += 1;
    this.lines = [...this.lines, `phase: ${step.phase}`, ...step.lines];
    this.state.localRun = { ...run, phase: step.phase, ...localRunSpent(run, 0.03) };
    this.dirty();
  }

  localRunOutput(): string[] {
    this.advanceBringUp();
    this.advanceTeardown();
    this.advanceTurn();
    return [...this.lines];
  }

  async killAgent(id: string): Promise<{ ok: true }> {
    const agent = this.state.agents.find((a) => a.id === id);
    if (agent && agent.status !== 'done') {
      agent.status = 'killed';
      agent.endedAt = new Date().toISOString();
      agent.waitingReason = null;
      const task = this.state.tasks.find((t) => t.id === agent.taskId);
      if (task && isLiveTask(task)) task.status = 'interrupted';
      for (const e of this.state.escalations) if (e.agentId === id && e.status === 'open') e.status = 'dismissed';
      this.addDecision('no_op', 'executed', `killed ${id}`);
      this.dirty();
    }
    return { ok: true };
  }

  async completeAgent(id: string): Promise<{ ok: true }> {
    const agent = this.state.agents.find((a) => a.id === id);
    if (agent && agent.status !== 'done') {
      agent.status = 'done';
      agent.endedAt = new Date().toISOString();
      agent.waitingReason = null;
      const task = this.state.tasks.find((t) => t.id === agent.taskId);
      if (task && isLiveTask(task)) task.status = 'done';
      for (const e of this.state.escalations) if (e.agentId === id && e.status === 'open') e.status = 'dismissed';
      this.addDecision('no_op', 'executed', `marked ${id} done`);
      this.dirty();
    }
    return { ok: true };
  }

  async ejectAgent(id: string, reason: string): Promise<{ ok: true; ejection: Ejection }> {
    const agent = this.state.agents.find((a) => a.id === id);
    const task = agent ? this.state.tasks.find((t) => t.id === agent.taskId) : undefined;
    const ejection: Ejection = {
      id: `ejc_${id}`,
      originRef: task?.originRef ?? 'issue:0',
      branch: task?.branch ?? null,
      worktreePath: agent?.cwd ?? null,
      agentId: id,
      taskId: agent?.taskId ?? '',
      sessionId: agent?.sessionId ?? null,
      reason,
      ejectedAt: new Date().toISOString(),
      lastSeenAt: null,
      lastNote: null,
      settledAt: null,
      outcome: null,
      settleNote: null,
    };
    if (agent) {
      agent.status = 'killed';
      agent.endedAt = ejection.ejectedAt;
      if (task && isLiveTask(task)) task.status = 'interrupted';
    }
    this.state.ejections = [
      { ...ejection, expiresAt: new Date(Date.now() + 8 * 3_600_000).toISOString(), neverContacted: false },
      ...this.state.ejections,
    ];
    this.addDecision('no_op', 'executed', `ejected ${id}: ${reason}`);
    this.dirty();
    return { ok: true, ejection };
  }

  async settleEjection(
    id: string,
    outcome: EjectionOutcome,
    note?: string,
  ): Promise<{ ok: true; ejection: Ejection; jobId: string | null }> {
    const held = this.state.ejections.find((e) => e.id === id);
    if (held) {
      held.settledAt = new Date().toISOString();
      held.outcome = outcome;
      held.settleNote = note ?? null;
      this.addDecision('no_op', 'executed', `${held.originRef} handed back as ${outcome}`);
      this.dirty();
    }
    return { ok: true, ejection: held!, jobId: null };
  }

  async extendStall(id: string): Promise<{ ok: true; expiresAt: string }> {
    const park = this.state.stallParks.find((p) => p.agentId === id);
    const expiresAt = new Date(Date.now() + 900_000).toISOString();
    if (park) {
      park.expiresAt = expiresAt;
      this.dirty();
    }
    return { ok: true, expiresAt };
  }

  async interruptAgent(id: string): Promise<{ ok: true }> {
    this.append(id, '\n^C interrupt received');
    return { ok: true };
  }

  async resumeAgent(id: string): Promise<{ ok: true }> {
    if (!this.state.parkedOnLimit.includes(id)) return { ok: true };
    this.state.parkedOnLimit = this.state.parkedOnLimit.filter((a) => a !== id);
    const agent = this.state.agents.find((a) => a.id === id);
    if (agent) {
      agent.status = 'running';
      agent.waitingReason = null;
      const task = this.state.tasks.find((t) => t.id === agent.taskId);
      if (task && isLiveTask(task)) task.status = 'running';
    }
    this.append(id, '\nResumed after the account usage limit cleared.');
    this.dirty();
    return { ok: true };
  }

  connect(onEvent: (ev: unknown) => void, onStatus?: (connected: boolean) => void): WsClient {
    const conn: Conn = { onEvent, subs: new Set() };
    this.conns.add(conn);
    setTimeout(() => onStatus?.(true), 0);
    this.startTimers();
    return {
      subscribe: (agentId: string) => {
        conn.subs.add(agentId);
        const last = (this.transcripts.get(agentId) ?? '').split('\n').filter(Boolean).at(-1);
        if (last) conn.onEvent({ type: 'agent:tail', agentId, line: last });
      },
      unsubscribe: (agentId: string) => conn.subs.delete(agentId),
      close: () => {
        this.conns.delete(conn);
        if (this.conns.size === 0) this.stopTimers();
      },
    };
  }

  private emit(ev: Emit): void {
    for (const c of this.conns) c.onEvent(ev);
  }

  private dirty(): void {
    this.state.world.takenAt = new Date().toISOString();
    this.state.worldObservedAt = this.state.world.takenAt;
    this.emit({ type: 'dirty' });
  }

  private append(agentId: string, chunk: string): void {
    const prev = this.transcripts.get(agentId) ?? '';
    this.transcripts.set(agentId, prev + chunk);
    for (const c of this.conns) if (c.subs.has(agentId)) c.onEvent({ type: 'agent:output', agentId, delta: chunk });
    const line = chunk.split('\n').filter(Boolean).at(-1);
    if (line) this.emit({ type: 'agent:tail', agentId, line });
  }

  private liveCount(): number {
    return this.state.agents.filter((a) => ['starting', 'running', 'waiting'].includes(a.status)).length;
  }

  private addDecision(
    type: Decision['action']['type'],
    outcome: Decision['outcome'],
    detail: string,
    reason?: string,
    rule?: string,
    admission?: string,
    subjectRef?: string,
  ): void {
    const dec: CockpitDecision = {
      id: this.id('dec'),
      cycleId: this.id('cycle'),
      action: { type, reason: reason ?? detail },
      outcome,
      detail,
      rule: rule ?? null,
      admission: admission ?? null,
      subjectRef: subjectRef ?? null,
      createdAt: new Date().toISOString(),
    };
    this.state.decisions = [dec, ...this.state.decisions].slice(0, 40);
  }

  private addWorldEvent(kind: WorldEventKind, ref: string | null, summary: string): void {
    const we: WorldEvent = { id: this.id('we'), kind, ref, summary, createdAt: new Date().toISOString() };
    this.state.worldEvents = [we, ...this.state.worldEvents].slice(0, 40);
    this.emit({ type: 'world:events' });
  }

  private trySpawn(
    kind: TaskSummary['kind'],
    title: string,
    branch: string | null,
    originRef: string | null,
  ): string | null {
    const prNumber = originRef?.startsWith('pr:') ? Number(originRef.slice(3)) : NaN;
    const taggedPr = this.state.world.pullRequests.find((p) => p.number === prNumber);
    if (taggedPr && !isWatched(taggedPr.labels, this.state.config)) {
      this.addDecision(dispatchAction(kind), 'skipped', `PR #${prNumber} is unwatched — held ${title}`, 'pr unwatched');
      return null;
    }
    if (this.state.control.paused) {
      this.addDecision(dispatchAction(kind), 'deferred', `paused — held ${title}`, 'dispatch paused');
      return null;
    }
    if (this.liveCount() >= this.state.control.cap) {
      this.addDecision(dispatchAction(kind), 'deferred', `at cap (${this.state.control.cap}) — held ${title}`);
      return null;
    }
    const taskId = this.id('task');
    const agentId = this.id('agent');
    const nowIso = new Date().toISOString();
    this.state.tasks = [
      {
        id: taskId,
        kind,
        title,
        branch,
        originRef,
        originTitle: title,
        originSummary: null,
        dispatchReason: null,
        status: 'running',
        agentId,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      ...this.state.tasks,
    ];
    this.state.agents = [
      {
        id: agentId,
        taskId,
        status: 'running',
        cwd: `/work/lubbdubb-${this.seq}`,
        pid: 5000 + (this.seq % 900),
        waitingReason: null,
        sessionId: null,
        startedAt: nowIso,
        endedAt: null,
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        numTurns: null,
        note: null,
        notedAt: null,
        resumedAt: null,
        resumeAttempts: 0,
      },
      ...this.state.agents,
    ];
    this.transcripts.set(agentId, `$ claude ${kind}\nPicking up: ${title}`);
    this.addDecision(
      dispatchAction(kind),
      'executed',
      `dispatched agent for ${title}`,
      undefined,
      undefined,
      undefined,
      originRef ?? undefined,
    );
    return taskId;
  }

  async launchJob(input: { prompt: string; title?: string; kind?: string; branch?: string | null }): Promise<{
    ok: true;
  }> {
    const kind = input.kind === 'desk' ? 'desk' : 'code';
    const prompt = input.prompt.trim();
    const title = (input.title && input.title.trim()) || prompt.split('\n')[0]!.slice(0, 80) || 'Operator job';
    const nowIso = new Date().toISOString();
    const id = this.id('job');
    const branch = input.branch ?? (kind === 'code' ? `job/${id}` : null);
    const job: Job = {
      id,
      title,
      prompt,
      kind,
      branch,
      status: 'queued',
      originRef: null,
      taskId: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.state.jobs = [job, ...this.state.jobs];
    const taskId = this.trySpawn(kind, title, branch, `job:${id}`);
    if (taskId) {
      job.status = 'dispatched';
      job.taskId = taskId;
      job.updatedAt = new Date().toISOString();
    }
    this.dirty();
    return { ok: true };
  }

  async createSchedule(input: { cron: string; prompt: string; title?: string; kind?: string }): Promise<{ ok: true }> {
    const prompt = input.prompt.trim();
    const nowIso = new Date().toISOString();
    const schedule: JobSchedule = {
      id: this.id('sch'),
      title: (input.title && input.title.trim()) || prompt.split('\n')[0]!.slice(0, 80) || 'Operator job',
      prompt,
      kind: input.kind === 'desk' ? 'desk' : 'code',
      cron: input.cron.trim(),
      enabled: true,
      nextRunAt: null,
      lastFiredAt: null,
      lastJobId: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.state.schedules = [...this.state.schedules, schedule];
    this.dirty();
    return { ok: true };
  }

  async updateSchedule(
    id: string,
    patch: { cron?: string; prompt?: string; title?: string; kind?: string; enabled?: boolean },
  ): Promise<{ ok: true }> {
    const schedule = this.state.schedules.find((s) => s.id === id);
    if (schedule) {
      if (patch.cron !== undefined) schedule.cron = patch.cron.trim();
      if (patch.prompt !== undefined) schedule.prompt = patch.prompt;
      if (patch.title !== undefined) schedule.title = patch.title;
      if (patch.kind !== undefined) schedule.kind = patch.kind === 'desk' ? 'desk' : 'code';
      if (patch.enabled !== undefined) schedule.enabled = patch.enabled;
      schedule.updatedAt = new Date().toISOString();
      this.dirty();
    }
    return { ok: true };
  }

  async runSchedule(id: string): Promise<{ ok: true }> {
    const schedule = this.state.schedules.find((s) => s.id === id);
    if (!schedule) return { ok: true };
    await this.launchJob({ prompt: schedule.prompt, title: schedule.title, kind: schedule.kind });
    schedule.lastFiredAt = new Date().toISOString();
    schedule.lastJobId = this.state.jobs[0]?.id ?? null;
    this.dirty();
    return { ok: true };
  }

  async deleteSchedule(id: string): Promise<{ ok: true }> {
    this.state.schedules = this.state.schedules.filter((s) => s.id !== id);
    this.dirty();
    return { ok: true };
  }

  async cancelJob(id: string): Promise<{ ok: true }> {
    const job = this.state.jobs.find((j) => j.id === id);
    if (job && job.status === 'queued') {
      job.status = 'cancelled';
      job.updatedAt = new Date().toISOString();
      this.addDecision('no_op', 'executed', `cancelled queued job ${job.title}`);
      this.dirty();
    }
    return { ok: true };
  }

  async reorderUpNext(origins: string[]): Promise<{ ok: true }> {
    const plan = this.state.upcoming;
    if (plan) {
      const rank = new Map(origins.map((o, i) => [o, i]));
      plan.items = plan.items
        .map((item, index) => ({ item, index }))
        .sort((a, b) => {
          const ra = rank.get(a.item.origin);
          const rb = rank.get(b.item.origin);
          if (ra !== undefined && rb !== undefined) return ra - rb;
          if (ra !== undefined) return -1;
          if (rb !== undefined) return 1;
          return a.index - b.index;
        })
        .map((e) => e.item);
      this.addDecision('dispatch_code_agent', 'executed', `re-ordered Up next (${origins.length} pinned)`);
      this.dirty();
    }
    return { ok: true };
  }

  async setUpNextProfile(origin: string, profile: string | null): Promise<{ ok: true }> {
    const item = this.state.upcoming?.items.find((i) => i.origin === origin);
    if (item) {
      if (profile === null) {
        const inherited = this.inheritedProfile.get(origin);
        delete item.override;
        item.profile = inherited?.profile ?? null;
        item.profileSource = inherited?.source;
      } else {
        if (item.override === undefined)
          this.inheritedProfile.set(origin, { profile: item.profile ?? null, source: item.profileSource });
        item.override = profile;
        item.profile = profile;
        item.profileSource = 'pin';
      }
      this.addDecision(
        'no_op',
        'executed',
        profile === null ? `cleared the profile override on ${origin}` : `${origin} will run on "${profile}"`,
      );
      this.dirty();
    }
    return { ok: true };
  }

  private readonly inheritedProfile = new Map<string, { profile: string | null; source: QueueItem['profileSource'] }>();

  private applyInjection(ev: Record<string, unknown>): void {
    const kind = String(ev.kind ?? '');
    const world = this.state.world;
    switch (kind) {
      case 'new_pr': {
        const number = Number(ev.number ?? 0);
        world.pullRequests = [
          ...world.pullRequests,
          injectedPr({
            id: this.id('pr'),
            number,
            title: String(ev.title ?? `PR #${number}`),
            branch: String(ev.branch ?? `feature/pr-${number}`),
            ciStatus: 'pending',
            unresolvedComments: [],
            approved: false,
            mergeable: true,
            baseBranch: 'main',
            mergeableState: 'clean',
            merged: false,
            health: { blocked: false, reasons: [] },
          }),
        ];
        this.addWorldEvent('pr_opened', `pr:${number}`, `PR #${number} opened`);
        break;
      }
      case 'ci_failed': {
        const n = Number(ev.prNumber ?? 0);
        const pr = world.pullRequests.find((p) => p.number === n);
        if (pr) {
          pr.ciStatus = 'failing';
          pr.health = { blocked: true, reasons: ['CI failing'] };
          this.addWorldEvent('pr_ci', `pr:${n}`, `CI failing on PR #${n}`);
          this.trySpawn('code', `Fix failing CI on PR #${n}`, pr.branch, `pr:${n}`);
        }
        break;
      }
      case 'pr_comment': {
        const n = Number(ev.prNumber ?? 0);
        const pr = world.pullRequests.find((p) => p.number === n);
        if (pr) {
          pr.unresolvedComments = [
            ...pr.unresolvedComments,
            { id: this.id('c'), author: String(ev.author ?? 'reviewer'), body: String(ev.body ?? ''), handled: false },
          ];
          this.addWorldEvent('pr_comment', `pr:${n}`, `${String(ev.author ?? 'reviewer')} commented on PR #${n}`);
          this.addDecision(
            'respond_to_agent',
            'executed',
            `notified branch agent about comment on PR #${n}`,
            undefined,
            undefined,
            'branch-notify',
          );
        }
        break;
      }
      case 'new_issue': {
        const number = Number(ev.number ?? 0);
        const labels = Array.isArray(ev.labels) ? (ev.labels as string[]) : [];
        world.issues = [
          ...world.issues,
          injectedIssue({
            id: this.id('iss'),
            number,
            title: String(ev.title ?? `Issue #${number}`),
            body: String(ev.body ?? ''),
            labels,
            state: 'open',
            modelPin: { profile: null, ignoredTags: [] },
            priority: null,
            linkedPrNumber: null,
          }),
        ];
        this.addWorldEvent('issue_opened', `issue:${number}`, `Issue #${number} opened`);
        if (isWatched(labels, this.state.config)) {
          this.trySpawn('code', `Implement issue #${number}`, `issue/${number}`, `issue:${number}`);
        } else {
          this.addDecision(
            'dispatch_code_agent',
            'skipped',
            `issue #${number} is not watched — left alone`,
            'unwatched',
          );
        }
        break;
      }
      case 'pr_approved': {
        const n = Number(ev.prNumber ?? 0);
        const pr = world.pullRequests.find((p) => p.number === n);
        if (pr) {
          pr.approved = true;
          this.addWorldEvent('pr_approved', `pr:${n}`, `PR #${n} approved`);
        }
        break;
      }
      case 'pr_mergeable': {
        const n = Number(ev.prNumber ?? 0);
        const pr = world.pullRequests.find((p) => p.number === n);
        if (pr) {
          const mergeable = ev.mergeable === undefined ? true : Boolean(ev.mergeable);
          pr.mergeable = mergeable;
          pr.mergeableState = mergeable ? 'clean' : 'dirty';
          pr.health = mergeable ? { blocked: false, reasons: [] } : { blocked: true, reasons: ['merge conflict'] };
          this.addWorldEvent('pr_mergeable', `pr:${n}`, `PR #${n} is ${mergeable ? 'mergeable' : 'conflicted'}`);
          if (!mergeable) this.trySpawn('code', `Resolve conflict on PR #${n}`, pr.branch, `pr:${n}`);
        }
        break;
      }
      default:
        this.addDecision('no_op', 'executed', `injected ${kind || 'event'}`);
    }
  }

  private startTimers(): void {
    if (!this.chatterTimer) {
      this.chatterTimer = setInterval(() => this.tickChatter(), 1400);
    }
    if (!this.beatTimer) {
      const beat = this.state.config.heartbeatIntervalMs;
      this.beatTimer = setInterval(() => {
        this.state.worldObservedAt = new Date().toISOString();
        this.tickDesktopClaim();
        this.emit({ type: 'cycle:end', cycleId: this.id('cycle'), rationale: 'heartbeat' });
      }, beat);
    }
  }

  private stopTimers(): void {
    if (this.chatterTimer) clearInterval(this.chatterTimer);
    if (this.beatTimer) clearInterval(this.beatTimer);
    this.chatterTimer = null;
    this.beatTimer = null;
  }

  private tickDesktopClaim(): void {
    const held = (this.state.validationChecks ?? []).find((c) => c.claimedBy !== null);
    if (!held) return;
    this.deskBeats++;
    if (this.deskBeats < 2) return;
    held.state = 'passed';
    held.resultNote =
      'Copied the download URL, flipped one character of the signature and requested it: 403, and the snapshot was not served.';
    held.resultBy = 'desktop';
    held.resultAt = new Date().toISOString();
    held.claimedBy = null;
    held.claimedAt = null;
    held.updatedAt = held.resultAt;
    this.dirty();
  }

  private tickChatter(): void {
    const running = this.state.agents.filter((a) => a.status === 'running');
    if (running.length === 0) return;
    const line = CHATTER[this.chatterIdx % CHATTER.length];
    this.chatterIdx++;
    for (const a of running) this.append(a.id, `\n${line}`);
  }
}

let server: DemoServer | null = null;
function getServer(): DemoServer {
  if (!server) server = new DemoServer();
  return server;
}

const DEMO_PACK_HEAD = 'c7d41e02a9b6538f14ac0d7b2e95f83610d4ab27';

/**
 * The pull request whose fixture wears the `writing` pack mark. The mark is
 * `packStandingOf`'s reading of no pack plus an author running, so the reading this
 * arm gives has to say the same thing — a mark whose pull request page then offers to
 * ask for a pack teaches a visitor the mark means nothing.
 * → docs/spec/17-cockpit.md#demo-mode
 */
const DEMO_PACK_WRITING_PR = 409;

const DEMO_PAD_AT = new Date(Date.now() - 5 * 3_600_000).toISOString();

/**
 * The review pack for PR #413, the one open pull request whose plan part declares
 * atoms. It is written and checked, so the page draws every reading it has: the
 * gate over a false claim, the checker's order and cues, the two ideas that name
 * the atoms their part carries, the idea that names none — the finding — and the
 * `plumbing` idea, which is exempt from that reading rather than an example of it.
 * → docs/spec/31-review-packs.md, docs/spec/17-cockpit.md#demo-mode
 */
const DEMO_REVIEW_PACK: ReviewPack = {
  schema: 1,
  prNumber: 413,
  headSha: DEMO_PACK_HEAD,
  headline: 'Every job is now checked against the catalog before its row is written.',
  summary: [
    '- The **enqueue** asks the catalog, so a bad payload never reaches the queue.',
    '- The four routes **stop parsing** payloads of their own.',
    '- The retry count moved too, and **the plan did not ask for that** — idea 02.',
  ].join('\n'),
  estimatedMinutes: 9,
  order: ['idea_enqueue', 'idea_retries', 'idea_routes', 'plumbing'],
  witnessed: true,
  fake: 'nothing',
  ideas: [
    {
      id: 'idea_enqueue',
      atom: 'enqueue-validates',
      claim: 'Every enqueue path validates its payload against the catalog before writing a row.',
      title: 'A job is checked before it is queued, not after',
      cue: 'Read: this is the guarantee the whole change exists to make.',
      attention: 'read',
      coverage: ['an unknown job type is refused by name', 'a valid payload still enqueues'],
      anchors: [
        {
          kind: 'hunk',
          range: { path: 'apps/api/src/jobs/enqueue.ts', start: 18, end: 27 },
          code: [
            ' export async function enqueue(type: JobType, payload: unknown) {',
            '+  const schema = catalog.schemaFor(type);',
            '+  const parsed = schema.parse(payload);',
            '-  return db.jobs.insert({ type, payload });',
            '+  return db.jobs.insert({ type, payload: parsed });',
            ' }',
          ],
          gist: 'The catalog is asked here, and the parsed payload is what gets stored.',
          note: {
            by: 'witness',
            text: 'Chose to throw rather than to drop the job: a queue that silently loses work is worse than one that fails loudly.',
            entryId: 'scr_kf20a7',
            at: DEMO_PAD_AT,
          },
          caption: 'the whole guarantee',
          mark: 'key',
        },
        {
          kind: 'region',
          range: { path: 'apps/watcher/src/worker-loop.ts', start: 64, end: 69 },
          code: [
            '  const job = await claimNextJob();',
            '  // No validation here — the row was checked at enqueue.',
            '  await runners[job.type](job.payload);',
          ],
          gist: 'Should the watcher have changed too? No — part 3 does that, and it is not in this diff.',
          note: null,
          caption: 'unchanged, and deliberately',
          mark: null,
        },
      ],
      claims: [
        {
          text: 'Every enqueue path goes through this function.',
          provenance: { kind: 'inferred' },
          verdict: 'false',
          evidence:
            'Three callers reach `db.jobs.insert` directly: apps/api/src/features/reindex/backfill.ts:88, apps/api/src/admin/replay.ts:41, and the seed script.',
          finding: {
            headline: 'The backfill still inserts jobs without asking the catalog.',
            body: 'The claim is what the change rests on, and it is not true of `backfill.ts`, which builds its rows and calls `db.jobs.insert` itself. A reindex can still queue a payload the catalog would refuse, which is the exact failure this pull request exists to close.\n\nIt is one call site and the fix is the same two lines, but it is a decision rather than a nit: taking the backfill through `enqueue` also takes it through the rate limit, which it deliberately skips today.',
            step: 1,
            counter: {
              range: { path: 'apps/api/src/features/reindex/backfill.ts', start: 86, end: 90 },
              code: [
                '  for (const doc of batch) {',
                '    await db.jobs.insert({ type: "index", payload: { docId: doc.id } });',
                '  }',
              ],
              caption: 'the path that skips the check',
            },
          },
        },
        {
          text: 'The catalog throws by name on an unknown job type.',
          provenance: { kind: 'witnessed', entryId: 'scr_kf20a7' },
          verdict: 'true',
          evidence:
            'packages/jobs/src/catalog.ts:31 throws `UnknownJobType(type)`; the test at test/catalog.test.ts:22 covers it.',
          finding: null,
        },
      ],
    },
    {
      id: 'idea_retries',
      atom: null,
      claim: 'A failed job is retried three times rather than five, and the backoff is now exponential.',
      title: 'Retries went from five to three, with a longer wait',
      cue: 'Split: nobody asked for this, and it decides on its own how the queue behaves under load.',
      attention: 'split',
      coverage: [],
      anchors: [
        {
          kind: 'hunk',
          range: { path: 'apps/api/src/jobs/enqueue.ts', start: 41, end: 45 },
          code: [
            '-  attempts: 5,',
            '-  backoffMs: 30_000,',
            '+  attempts: 3,',
            '+  backoffMs: (n: number) => 30_000 * 2 ** n,',
          ],
          gist: 'The retry policy changed in the same commit as the validation.',
          note: {
            by: 'author',
            text: 'Nothing in the plan or the pad mentions retries. It may be right — a payload the catalog refuses will never succeed on a retry — but it is a separate decision and it is not stated anywhere.',
          },
          caption: 'not asked for',
          mark: 'key',
        },
      ],
      claims: [
        {
          text: 'No job type depends on more than three attempts.',
          provenance: { kind: 'inferred' },
          verdict: 'cant_tell',
          evidence:
            'Nothing in the repository states an attempt budget per type; the only evidence either way is production data this checkout has no access to.',
          finding: null,
        },
      ],
    },
    {
      id: 'idea_routes',
      atom: 'drop-route-parsers',
      claim: 'No route parses a payload shape of its own; each hands the body to the enqueue.',
      title: 'Four routes stop having opinions about payloads',
      cue: 'Decide: three of the four are mechanical, and the fourth changes what a client is sent.',
      attention: 'decide',
      coverage: ['each route still rejects a malformed body', 'the error body keeps its shape'],
      anchors: [
        {
          kind: 'hunk',
          range: { path: 'apps/api/src/features/jobs/index.route.ts', start: 12, end: 16 },
          code: [
            '-  const body = IndexPayload.parse(await req.json());',
            '-  await enqueue("index", body);',
            '+  await enqueue("index", await req.json());',
          ],
          gist: 'The route hands the body over unparsed; one of four, all identical.',
          note: null,
          caption: 'one of four',
          mark: null,
        },
      ],
      claims: [
        {
          text: 'All four routes returned the same 400 body before, and still do.',
          provenance: { kind: 'disputed', entryId: 'scr_kf31b2' },
          verdict: 'true',
          evidence:
            'The pad says the search route returned a bare string; it does not — apps/api/src/features/jobs/search.route.ts:19 has used the shared error body since #341.',
          finding: null,
        },
      ],
    },
    {
      id: 'plumbing',
      atom: null,
      claim: 'These hunks carry nothing to review: an import order, a lockfile and a moved type.',
      title: 'Formatting, a lockfile and one moved type',
      cue: 'Skim: nothing here changes behaviour.',
      attention: 'skim',
      coverage: [],
      anchors: [
        {
          kind: 'hunk',
          range: { path: 'apps/api/src/jobs/enqueue.ts', start: 1, end: 4 },
          code: [
            '-import { db } from "../db.js";',
            '+import { catalog } from "@magpie/jobs";',
            '+import { db } from "../db.js";',
          ],
          gist: 'The import the catalog needs, in the order the linter wants.',
          note: null,
          caption: 'imports',
          mark: null,
        },
      ],
      claims: [
        {
          text: 'None of these hunks changes behaviour.',
          provenance: { kind: 'inferred' },
          verdict: 'true',
          evidence: 'Each is an import, a lockfile line or a type moved without its shape changing.',
          finding: null,
        },
      ],
    },
  ],
};

const DEMO_REVIEW_PACK_WRITTEN_AT = new Date(Date.now() - 40 * 60_000).toISOString();

/**
 * The pull request's own pad — the witness log behind the pack for #413. It holds
 * exactly the two entries the pack's claims cite, because a `witnessed` claim whose
 * entry the reader cannot see is the retelling the verbatim rendering exists to
 * prevent.
 * → docs/spec/31-review-packs.md#the-witness-log
 */
const DEMO_PR_PAD = [
  {
    id: 'scr_kf20a7',
    padRef: 'pr:413',
    authorOriginRef: 'issue:390:part:validate',
    agentId: 'agent_h72kd',
    taskId: 'task-413-validate',
    topic: 'enqueue',
    note: 'The catalog lookup goes at enqueue, not in the watcher. By the time the watcher reads a row the bad job is already queued, and the queue is what a person ends up cleaning out by hand.',
    decision: {
      chose: 'Throw at enqueue when the catalog refuses the payload.',
      because: 'A caller that gets an error can fix its request; a job that vanishes quietly cannot be found.',
      rejected: [
        {
          alternative: 'Drop the job and log it.',
          because: 'A queue that silently loses work is worse than one that fails loudly.',
        },
        {
          alternative: 'Validate in the watcher, where the payload is actually read.',
          because: 'The row is already written by then, and nothing tells the caller.',
        },
      ],
      paths: ['apps/api/src/jobs/enqueue.ts'],
    },
    createdAt: DEMO_PAD_AT,
  },
  {
    id: 'scr_kf31b2',
    padRef: 'pr:413',
    authorOriginRef: 'issue:390:part:validate',
    agentId: 'agent_h72kd',
    taskId: 'task-413-validate',
    topic: 'routes',
    note: 'Careful with the four routes: the search one returns a bare string on a 400 rather than the shared error body, so deleting its parser changes what a client sees.',
    decision: null,
    createdAt: new Date(Date.now() - 4 * 3_600_000).toISOString(),
  },
];

/**
 * The reviewer's marks, held beside the pack rather than in it — the demo's copy of
 * the rule that what a reviewer does is never written back into the document. Held
 * in module state so a mark survives leaving the pack and coming back, the way the
 * real one survives a reload.
 * → docs/spec/31-review-packs.md#what-a-reviewer-does-is-not-part-of-the-pack
 */
const demoReviewMarks = new Map<string, ReviewMark>();

const demoHunksOf = (ideaId: string): ReviewRange[] =>
  (DEMO_REVIEW_PACK.ideas.find((i) => i.id === ideaId)?.anchors ?? [])
    .filter((a) => a.kind === 'hunk')
    .map((a) => a.range);

const demoMarkKey = (hunk: ReviewRange): string => `${hunk.path}:${hunk.start}-${hunk.end}`;

function demoMark(ideaId: string, patch: Partial<Pick<ReviewMark, 'read' | 'seen' | 'attention'>>): ReviewMarksPayload {
  for (const hunk of demoHunksOf(ideaId)) {
    const key = demoMarkKey(hunk);
    const prev = demoReviewMarks.get(key);
    demoReviewMarks.set(key, {
      prNumber: 413,
      hunk,
      headSha: DEMO_PACK_HEAD,
      attention: prev?.attention ?? null,
      read: prev?.read ?? false,
      seen: prev?.seen ?? false,
      ...patch,
      markedAt: new Date().toISOString(),
    });
  }
  return { marks: [...demoReviewMarks.values()] };
}

const DEMO_REVIEW_CALIBRATION: ReviewCalibration = {
  window: {
    key: 'all',
    label: 'All time',
    bucketLabel: 'one bar a day',
    since: null,
    startsAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    bucketMs: 86_400_000,
    buckets: 30,
    session: null,
  },
  // The reading is of the one pack the demo holds (#413), counted rather than
  // invented: four hunks of which one is plumbing, four labelled ideas none of
  // which a reviewer has overridden yet, and the one false claim, unseen — a
  // reading that would contradict the pack a visitor can open is worse than none.
  packs: 1,
  overrides: { labelled: 4, overridden: 0, upgrades: 0, downgrades: 0, sideways: 0, pairs: [] },
  plumbing: {
    hunks: 4,
    plumbingHunks: 1,
    ratio: 0.25,
    worst: [
      {
        prNumber: 413,
        headSha: DEMO_PACK_HEAD,
        writtenAt: DEMO_REVIEW_PACK_WRITTEN_AT,
        hunks: 4,
        plumbingHunks: 1,
        ratio: 0.25,
      },
    ],
  },
  prominence: { packsWithFalse: 1, falseClaims: 1, ideas: 4, seen: 0, mergedUnseen: [] },
};

const DEMO_RETROSPECTIVE = {
  originRef: 'issue:364',
  summary: 'Delivered in one PR, but two agents were spent chasing a red base that was never ours.',
  document: [
    '## What shipped',
    '',
    'PR #410 documents why a maintenance job needs two watchers — the orchestrator blocks in an API callback while the API waits on the AI jobs it enqueued — and the console now warns when only one watcher is connected. Nothing was left outstanding.',
    '',
    '## How the run went',
    '',
    '- Three agents were spawned; one of them did the work.',
    '- Two were spent on CI that was failing on the base branch, not on this PR. The scratchpad records the second agent working that out from scratch, an hour after the first had already established it.',
    '- One escalation, answered in four minutes.',
    '',
    '## What to change',
    '',
    'The inherited-failure suppression covers the dispatch path, but nothing tells an agent *why* its CI is red once it is already running. A line in the CI-fix prompt naming the failing ancestor would have saved the second agent entirely.',
  ].join('\n'),
  agentId: 'agent-7',
  taskId: 'task-7',
  createdAt: new Date(Date.now() - 3_600_000).toISOString(),
  updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
};

const DEMO_SCRATCHPAD = [
  {
    id: 'scr_demo1',
    padRef: 'issue:364',
    authorOriginRef: 'issue:364',
    agentId: 'agent-4',
    taskId: 'task-4',
    topic: 'deadlock',
    note: 'The starvation is not "the queue is busy": a maintenance orchestrator holds its watcher while it blocks in the API callback, and the follow-up AI jobs it enqueued can only be claimed by a *second* watcher. With one watcher it waits for itself. The docs have to say that, not "run more watchers if it feels slow".',
    decision: {
      chose: 'Release the watcher before the orchestrator blocks in the API callback.',
      because: 'The claim path needs the watcher, and the callback holds it for the whole round-trip.',
      rejected: [
        {
          alternative: 'Raise the worker count so a second claimer is usually free.',
          because: 'Hides the deadlock behind capacity; it comes back under load.',
        },
        {
          alternative: 'Move the follow-up jobs onto their own queue.',
          because: 'Two queues to drain, and the ordering guarantee between them is what the feature is.',
        },
      ],
      paths: ['src/maintenance/orchestrator.ts'],
    },
    createdAt: new Date(Date.now() - 9_000_000).toISOString(),
  },
  {
    id: 'scr_demo2',
    padRef: 'issue:364',
    authorOriginRef: 'issue:364',
    agentId: 'agent-4',
    taskId: 'task-4',
    topic: 'ci',
    note: 'CI on this branch is red and none of it is ours — the failures are all in the base PR (#406). Do not chase them.',
    decision: null,
    createdAt: new Date(Date.now() - 7_800_000).toISOString(),
  },
  {
    id: 'scr_demo3',
    padRef: 'issue:364',
    authorOriginRef: 'issue:364:part:docs',
    agentId: 'agent-6',
    taskId: 'task-6',
    topic: 'ci',
    note: 'Spent about an hour on the red suite before working out the failures come from the base branch. Reading the pad first would have saved all of it.',
    decision: null,
    createdAt: new Date(Date.now() - 4_800_000).toISOString(),
  },
  {
    id: 'scr_demo4',
    padRef: 'issue:364',
    authorOriginRef: 'issue:364:assess',
    agentId: 'agent-7',
    taskId: 'task-7',
    topic: null,
    note: 'PR #410 covers the deadlock and the one-watcher warning. Nothing outstanding that I can see.',
    decision: null,
    createdAt: new Date(Date.now() - 4_200_000).toISOString(),
  },
];

const DEMO_GOAL_SEEDS: {
  issueNumber: number;
  title: string | null;
  agents: number;
  localRuns: number;
  hoursAgo: number;
  byPhase: Partial<Record<SpendPhase, number>>;
  outcome: 'delivered' | 'fell short' | null;
  open?: true;
}[] = [
  {
    issueNumber: 390,
    title: 'Validate job payloads in the catalog, not in each runner',
    agents: 7,
    outcome: null,
    open: true,
    localRuns: 2,
    hoursAgo: 2,
    byPhase: { deliberation: 3.4, build: 9.8, ci: 2.6, landing: 1.3, evidence: 1.32, local: 0.74 },
  },
  {
    issueNumber: 364,
    title: 'Document the two-watcher requirement for maintenance jobs',
    agents: 4,
    outcome: 'delivered',
    localRuns: 0,
    hoursAgo: 1,
    byPhase: { deliberation: 1.6, build: 3.24, ci: 0.3, landing: 0.2, evidence: 0.8 },
  },
  {
    issueNumber: 382,
    title: 'Gap clustering merges unrelated questions into one gap',
    agents: 3,
    outcome: 'fell short',
    localRuns: 1,
    hoursAgo: 26,
    byPhase: { deliberation: 0.3, build: 1.1, ci: 2.6, landing: 0.1, evidence: 0.1, local: 0.18 },
  },
  {
    issueNumber: 331,
    title: null,
    agents: 2,
    outcome: 'fell short',
    localRuns: 0,
    hoursAgo: 74,
    byPhase: { deliberation: 0.3, build: 0.62, evidence: 0.5 },
  },
];

const DEMO_LOOSE: { phase: SpendPhase; costUsd: number }[] = [
  { phase: 'job', costUsd: 0.96 },
  { phase: 'other', costUsd: 0.7 },
];

function localRunSpent(
  run: LocalRunView,
  costUsd: number,
): Pick<
  LocalRunView,
  'costUsd' | 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreationTokens' | 'numTurns'
> {
  const cost = (run.costUsd ?? 0) + costUsd;
  return {
    costUsd: Math.round(cost * 1e6) / 1e6,
    inputTokens: Math.round(cost * 180_000),
    outputTokens: Math.round(cost * 9_000),
    cacheReadTokens: Math.round(cost * 140_000),
    cacheCreationTokens: Math.round(cost * 11_000),
    numTurns: (run.numTurns ?? 0) + 1,
  };
}

const demoTokens = (costUsd: number) => ({
  inputTokens: Math.round(costUsd * 180_000),
  outputTokens: Math.round(costUsd * 9_000),
});

const demoCache = (costUsd: number) => ({
  cacheReadTokens: Math.round(costUsd * 140_000),
  cacheCreationTokens: Math.round(costUsd * 11_000),
  cacheMeasuredInputTokens: Math.round(costUsd * 180_000),
});

const PHASE_COPY: Record<SpendPhase, { label: string; blurb: string }> = {
  deliberation: { label: 'Deliberation', blurb: 'Planning and appraising — deciding what the work is' },
  build: { label: 'Build', blurb: 'The pickup and every part — where a branch is cut and a PR is written' },
  ci: { label: 'CI', blurb: 'Answering a pull request’s failing or blocked checks — what a red pipeline costs' },
  landing: { label: 'Landing', blurb: 'The rest of getting a pull request in — review comments, retargets, the merge' },
  evidence: { label: 'Evidence', blurb: 'Assessing what shipped, and writing the run up' },
  local: { label: 'Local runs', blurb: 'Bringing a goal’s branch up on this machine to look at it' },
  obstacle: {
    label: 'Obstacles',
    blurb: 'Repairing something in the fleet’s way — a red base, a wall three goals have hit',
  },
  job: { label: 'Jobs', blurb: 'Work an operator queued directly, rather than a goal the harness picked up' },
  other: { label: 'Unclassified', blurb: 'Runs whose origin names none of the above — see the note below' },
};

const DEMO_RUNS: {
  id: string;
  kind: 'agent' | 'local';
  title: string;
  originRef: string;
  phase: SpendPhase;
  costUsd: number;
  turns: number;
  hoursAgo: number;
}[] = [
  {
    id: 'agent-d1',
    kind: 'agent',
    title: 'Validate every payload at enqueue',
    originRef: 'issue:390:part:validate',
    phase: 'build',
    costUsd: 4.12,
    turns: 61,
    hoursAgo: 3,
  },
  {
    id: 'agent-d2',
    kind: 'agent',
    title: 'Plan the jobs-catalog move',
    originRef: 'issue:390:plan',
    phase: 'deliberation',
    costUsd: 2.7,
    turns: 24,
    hoursAgo: 19,
  },
  {
    id: 'agent-d3',
    kind: 'agent',
    title: 'Route the watcher’s intake through the catalog',
    originRef: 'issue:390:part:watcher',
    phase: 'build',
    costUsd: 2.44,
    turns: 38,
    hoursAgo: 2,
  },
  {
    id: 'agent-d4',
    kind: 'agent',
    title: 'Fix the failing checks on #413',
    originRef: 'pr:413:ci',
    phase: 'ci',
    costUsd: 2.2,
    turns: 31,
    hoursAgo: 4,
  },
  {
    id: 'agent-d5',
    kind: 'agent',
    title: 'Document the two-watcher requirement',
    originRef: 'issue:364:part:docs',
    phase: 'build',
    costUsd: 1.86,
    turns: 27,
    hoursAgo: 1,
  },
  {
    id: 'agent-d6',
    kind: 'agent',
    title: 'Answer the review on #414',
    originRef: 'pr:414:comments',
    phase: 'landing',
    costUsd: 1.7,
    turns: 22,
    hoursAgo: 5,
  },
  {
    id: 'agent-d7',
    kind: 'agent',
    title: 'Assess what shipped for #390',
    originRef: 'issue:390:assess',
    phase: 'evidence',
    costUsd: 1.32,
    turns: 14,
    hoursAgo: 2,
  },
  {
    id: 'run-390-b',
    kind: 'local',
    title: 'Local run · issue/390/validate',
    originRef: 'issue:390',
    phase: 'local',
    costUsd: 0.52,
    turns: 9,
    hoursAgo: 2,
  },
  {
    id: 'agent-d8',
    kind: 'agent',
    title: 'Sweep docs/ for links that no longer resolve',
    originRef: 'job:demo-1',
    phase: 'job',
    costUsd: 0.96,
    turns: 11,
    hoursAgo: 30,
  },
];

const DEMO_TASK_TYPES: { rule: string | null; costUsd: number; runs: number }[] = [
  { rule: 'plan-part', costUsd: 11.24, runs: 5 },
  { rule: 'issue-plan', costUsd: 5.9, runs: 4 },
  { rule: 'pr-ci-failing', costUsd: 4.24, runs: 6 },
  { rule: 'issue-pickup', costUsd: 3.86, runs: 2 },
  { rule: 'issue-assess', costUsd: 2.82, runs: 4 },
  { rule: 'pr-review-comment', costUsd: 1.62, runs: 3 },
  { rule: 'manual-job', costUsd: 0.96, runs: 1 },
  { rule: null, costUsd: 0.7, runs: 1 },
];

const RULE_COPY: Record<string, { label: string; description: string | null }> = {
  'plan-part': { label: 'Plan part ready', description: 'A part of an approved plan, worked on its own branch' },
  'issue-plan': { label: 'Issue needs a plan', description: 'Break a goal into parts before any code is written' },
  'pr-ci-failing': { label: 'Failing CI', description: 'A PR with failing CI gets a code agent to push a fix' },
  'issue-pickup': { label: 'Open issue without a PR', description: 'An open issue with no PR and nobody on it' },
  'issue-assess': { label: 'Issue may be finished', description: 'Judge whether what shipped actually met the goal' },
  'pr-review-comment': {
    label: 'Unhandled review comments',
    description: 'Every unresolved review thread on a PR goes to one code agent together',
  },
  'manual-job': { label: 'Operator-launched job', description: 'A prompt queued from the cockpit' },
  none: { label: 'No rule', description: 'Dispatched outside the pulse — an accepted proposal, or agent lifecycle' },
};

const DEMO_CHECKS: { name: string; costUsd: number; runs: number; soleRuns: number; hoursAgo: number }[] = [
  { name: 'test (unit)', costUsd: 1.94, runs: 5, soleRuns: 3, hoursAgo: 4 },
  { name: 'test:db (postgres)', costUsd: 1.18, runs: 2, soleRuns: 2, hoursAgo: 9 },
  { name: 'build (ubuntu-latest)', costUsd: 0.46, runs: 3, soleRuns: 0, hoursAgo: 26 },
  { name: 'lint', costUsd: 0.24, runs: 2, soleRuns: 1, hoursAgo: 31 },
];

const DEMO_DAYS = [0.4, 0, 1.1, 2.3, 1.8, 0, 0.9, 3.4, 2.2, 1.6, 0.7, 2.9, 4.1, 5.3];

const DEMO_PHASE_HEALTH: {
  phase: SpendPhase;
  settled: number;
  lost: number;
  stopped: number;
  lostCostUsd: number;
  medianMs: number;
}[] = [
  { phase: 'build', settled: 8, lost: 2, stopped: 0, lostCostUsd: 2.4, medianMs: 26 * 60_000 },
  { phase: 'deliberation', settled: 6, lost: 0, stopped: 0, lostCostUsd: 0, medianMs: 4 * 60_000 },
  { phase: 'ci', settled: 4, lost: 1, stopped: 0, lostCostUsd: 0.7, medianMs: 9 * 60_000 },
  { phase: 'landing', settled: 2, lost: 0, stopped: 0, lostCostUsd: 0, medianMs: 7 * 60_000 },
  { phase: 'evidence', settled: 3, lost: 0, stopped: 1, lostCostUsd: 0, medianMs: 6 * 60_000 },
  { phase: 'job', settled: 1, lost: 0, stopped: 0, lostCostUsd: 0, medianMs: 12 * 60_000 },
];

const DEMO_OUTCOMES: { outcome: RunOutcome; runs: number; costUsd: number }[] = [
  { outcome: 'done', runs: 20, costUsd: 18.4 },
  { outcome: 'failed', runs: 2, costUsd: 2.4 },
  { outcome: 'crashed', runs: 1, costUsd: 0.7 },
  { outcome: 'killed', runs: 1, costUsd: 0.31 },
];

const OUTCOME_COPY: Record<RunOutcome, { label: string; blurb: string }> = {
  done: { label: 'Finished', blurb: 'The agent ran to its own end' },
  failed: { label: 'Failed', blurb: 'The process exited non-zero — the harness did not stop it' },
  crashed: { label: 'Crashed', blurb: 'Found dead at boot: the server went down with the agent still out' },
  killed: { label: 'Killed', blurb: 'An operator stopped it, or the harness reclaimed its slot' },
  interrupted: { label: 'Interrupted', blurb: 'Cut short mid-run and left recoverable' },
};

const DEMO_CI_DAYS: [number, number][] = [
  [0, 2],
  [1, 3],
  [0, 0],
  [2, 4],
  [1, 2],
  [0, 3],
  [2, 1],
  [3, 5],
  [1, 4],
  [0, 2],
  [2, 3],
  [1, 1],
  [2, 2],
  [2, 2],
];

const THROUGHPUT_MEASURE_ORDER: readonly ThroughputMeasure[] = [
  'issue-opened',
  'pr-opened',
  'pr-merged',
  'pr-closed',
  'pr-approved',
  'review-received',
  'reply-sent',
  'issue-closed',
];

const THROUGHPUT_COPY: Record<ThroughputMeasure, { label: string; blurb: string; ours: boolean }> = {
  'issue-opened': {
    label: 'Issues opened',
    blurb: 'Entered the watched set — filed by the fleet or by a person',
    ours: false,
  },
  'issue-closed': { label: 'Issues closed', blurb: 'Left the watched set closed', ours: false },
  'pr-opened': { label: 'PRs opened', blurb: 'First seen open by the world model', ours: false },
  'pr-merged': { label: 'PRs merged', blurb: 'Landed on their base branch', ours: false },
  'pr-closed': { label: 'PRs abandoned', blurb: 'Closed without merging', ours: false },
  'pr-approved': { label: 'Approvals', blurb: 'A pull request first read as approved', ours: false },
  'review-received': { label: 'Review comments', blurb: 'Unresolved comments the world model first saw', ours: false },
  'reply-sent': {
    label: 'Replies sent',
    blurb: 'Review replies that left through the sink — the fleet\u2019s own',
    ours: true,
  },
};

const DEMO_THROUGHPUT_DAYS: [number, number, number, number, number][] = [
  [2, 1, 0, 3, 2],
  [3, 2, 0, 6, 4],
  [1, 1, 1, 2, 2],
  [4, 3, 0, 9, 7],
  [2, 2, 0, 5, 4],
  [0, 1, 0, 1, 1],
  [3, 2, 1, 7, 5],
  [5, 4, 0, 11, 9],
  [2, 3, 0, 4, 4],
  [1, 1, 0, 2, 1],
  [4, 3, 1, 8, 6],
  [2, 2, 0, 5, 3],
  [3, 4, 0, 6, 5],
  [4, 2, 0, 9, 6],
];

const DEMO_THROUGHPUT_BUSIEST: {
  ref: string;
  prNumber: number;
  opened: boolean;
  merged: boolean;
  closed: boolean;
  commentsReceived: number;
  repliesSent: number;
  toMergeHours: number | null;
  hoursAgo: number;
}[] = [
  {
    ref: 'pr:414',
    prNumber: 414,
    opened: true,
    merged: false,
    closed: false,
    commentsReceived: 11,
    repliesSent: 8,
    toMergeHours: null,
    hoursAgo: 1,
  },
  {
    ref: 'pr:409',
    prNumber: 409,
    opened: true,
    merged: true,
    closed: false,
    commentsReceived: 9,
    repliesSent: 9,
    toMergeHours: 6.5,
    hoursAgo: 8,
  },
  {
    ref: 'pr:402',
    prNumber: 402,
    opened: true,
    merged: true,
    closed: false,
    commentsReceived: 6,
    repliesSent: 5,
    toMergeHours: 21,
    hoursAgo: 26,
  },
  {
    ref: 'pr:397',
    prNumber: 397,
    opened: false,
    merged: false,
    closed: true,
    commentsReceived: 4,
    repliesSent: 2,
    toMergeHours: null,
    hoursAgo: 40,
  },
  {
    ref: 'pr:388',
    prNumber: 388,
    opened: true,
    merged: true,
    closed: false,
    commentsReceived: 3,
    repliesSent: 3,
    toMergeHours: 3.2,
    hoursAgo: 61,
  },
];

const DEMO_THROUGHPUT_ISSUES: Record<'issue-opened' | 'issue-closed' | 'pr-approved', number> = {
  'issue-opened': 21,
  'issue-closed': 17,
  'pr-approved': 24,
};

const DEMO_FLAKY: CiSubject[] = [
  { ref: 'pr:414', prNumber: 414, reds: 6, greens: 5, redMs: 4.2 * 3_600_000, stillRed: true, costUsd: 1.9 },
  { ref: 'pr:413', prNumber: 413, reds: 4, greens: 4, redMs: 1.6 * 3_600_000, stillRed: false, costUsd: 1.1 },
  { ref: 'pr:410', prNumber: 410, reds: 3, greens: 3, redMs: 52 * 60_000, stillRed: false, costUsd: 0.6 },
  { ref: 'pr:412', prNumber: 412, reds: 3, greens: 2, redMs: 2.1 * 3_600_000, stillRed: true, costUsd: 0.7 },
  { ref: 'pr:405', prNumber: 405, reds: 1, greens: 1, redMs: 14 * 60_000, stillRed: false, costUsd: 0 },
];

const DEMO_REPEATS: {
  originRef: string;
  title: string;
  runs: number;
  lost: number;
  costUsd: number;
  hoursAgo: number;
}[] = [
  { originRef: 'pr:414:ci', title: 'Fix the failing checks on #414', runs: 4, lost: 1, costUsd: 3.9, hoursAgo: 2 },
  {
    originRef: 'issue:390:part:schemas',
    title: 'Land the schema move',
    runs: 3,
    lost: 1,
    costUsd: 5.2,
    hoursAgo: 6,
  },
  { originRef: 'issue:345', title: 'Retry the pickup on #345', runs: 2, lost: 0, costUsd: 4.1, hoursAgo: 19 },
];

function buildDemoRemedies(): RemedyInsights {
  const hour = 3_600_000;
  const now = Date.now();
  const ci: {
    cause: RemedyCause;
    label: string;
    blurb: string;
    accounts: number;
    costUsd: number;
    undocumented: number;
    topCheck: { name: string; accounts: number } | null;
  }[] = [
    {
      cause: 'missed_gate',
      label: 'Missed gate',
      blurb: 'The repository’s own check would have caught it, and it was not run',
      accounts: 9,
      costUsd: 31.4,
      undocumented: 4,
      topCheck: { name: 'format:check', accounts: 6 },
    },
    {
      cause: 'flake',
      label: 'Flake',
      blurb: 'The same commit answers differently on a re-run — nothing in the diff',
      accounts: 6,
      costUsd: 26.8,
      undocumented: 0,
      topCheck: { name: 'test (windows)', accounts: 5 },
    },
    {
      cause: 'stale_test',
      label: 'Stale test',
      blurb: 'The change was right; the test still encoded the old behaviour',
      accounts: 5,
      costUsd: 21.1,
      undocumented: 1,
      topCheck: { name: 'test', accounts: 4 },
    },
    {
      cause: 'contract_drift',
      label: 'Contract drift',
      blurb: 'The change broke a caller, a type, or a second place the thing had to be registered',
      accounts: 4,
      costUsd: 19.6,
      undocumented: 3,
      topCheck: { name: 'typecheck:web', accounts: 3 },
    },
    {
      cause: 'defect',
      label: 'Defect',
      blurb: 'A genuine bug in the change',
      accounts: 2,
      costUsd: 12.2,
      undocumented: 0,
      topCheck: { name: 'test', accounts: 2 },
    },
    {
      cause: 'environment',
      label: 'Environment',
      blurb: 'The runner, a dependency, the network or a credential — not the diff',
      accounts: 1,
      costUsd: 4.3,
      undocumented: 0,
      topCheck: { name: 'knip', accounts: 1 },
    },
    {
      cause: 'inherited',
      label: 'Inherited',
      blurb: 'Already red before this branch, or red from the base it sits on',
      accounts: 0,
      costUsd: 0,
      undocumented: 0,
      topCheck: null,
    },
    {
      cause: 'other',
      label: 'Other',
      blurb: 'None of the above — the summary carries it',
      accounts: 0,
      costUsd: 0,
      undocumented: 0,
      topCheck: null,
    },
  ];
  const review: typeof ci = [
    {
      cause: 'convention',
      label: 'Convention',
      blurb: 'A house rule or repository idiom the agent did not know',
      accounts: 6,
      costUsd: 17.9,
      undocumented: 5,
      topCheck: null,
    },
    {
      cause: 'docs',
      label: 'Docs',
      blurb: 'The document that owns the behaviour was not updated with it',
      accounts: 4,
      costUsd: 8.4,
      undocumented: 0,
      topCheck: null,
    },
    {
      cause: 'missed_requirement',
      label: 'Missed requirement',
      blurb: 'The ticket asked for it and the diff did not do it',
      accounts: 3,
      costUsd: 10.7,
      undocumented: 1,
      topCheck: null,
    },
    {
      cause: 'approach',
      label: 'Approach',
      blurb: 'The reviewer wanted the problem solved a different way',
      accounts: 2,
      costUsd: 2.6,
      undocumented: 0,
      topCheck: null,
    },
    {
      cause: 'clarity',
      label: 'Clarity',
      blurb: 'Naming, comments or structure the reviewer could not read',
      accounts: 1,
      costUsd: 1.4,
      undocumented: 0,
      topCheck: null,
    },
    {
      cause: 'defect',
      label: 'Defect',
      blurb: 'A genuine bug in the change',
      accounts: 1,
      costUsd: 3.1,
      undocumented: 0,
      topCheck: null,
    },
    {
      cause: 'scope',
      label: 'Scope',
      blurb: 'Too much, or too little, for what was asked',
      accounts: 0,
      costUsd: 0,
      undocumented: 0,
      topCheck: null,
    },
    {
      cause: 'other',
      label: 'Other',
      blurb: 'None of the above — the summary carries it',
      accounts: 0,
      costUsd: 0,
      undocumented: 0,
      topCheck: null,
    },
  ];
  const sum = (rows: typeof ci, field: 'accounts' | 'costUsd'): number =>
    Math.round(rows.reduce((total, row) => total + row[field], 0) * 1e6) / 1e6;

  const recent: RemedyRow[] = [
    {
      id: 'rmd_demo1',
      kind: 'ci',
      ref: 'pr:412',
      prNumber: 412,
      cause: 'missed_gate',
      causeLabel: 'Missed gate',
      guard: 'undocumented',
      guardLabel: 'Written down nowhere',
      summary:
        'format:check went red on line endings — the file was written by a script that emits LF. Rewrote it through the repository’s own formatter.',
      checks: ['format:check'],
      at: new Date(now - 2 * hour).toISOString(),
    },
    {
      id: 'rmd_demo2',
      kind: 'ci',
      ref: 'pr:409',
      prNumber: 409,
      cause: 'flake',
      causeLabel: 'Flake',
      guard: 'unpreventable',
      guardLabel: 'Nothing would have',
      summary:
        'test (windows) timed out waiting on a pty exit and passed unchanged on a re-run. Nothing in the diff touches that seam.',
      checks: ['test (windows)'],
      at: new Date(now - 6 * hour).toISOString(),
    },
    {
      id: 'rmd_demo3',
      kind: 'review',
      ref: 'pr:407',
      prNumber: 407,
      cause: 'convention',
      causeLabel: 'Convention',
      guard: 'undocumented',
      guardLabel: 'Written down nowhere',
      summary:
        'Reviewer asked for the colour as a token on :root rather than a hex at the use site. Moved it and added it to the registry.',
      checks: [],
      at: new Date(now - 27 * hour).toISOString(),
    },
    {
      id: 'rmd_demo4',
      kind: 'ci',
      ref: 'pr:404',
      prNumber: 404,
      cause: 'contract_drift',
      causeLabel: 'Contract drift',
      guard: 'documented',
      guardLabel: 'Already written down',
      summary:
        'typecheck:web went red on a domain type widened in the wire module. The rule is in CLAUDE.md; I had not read it.',
      checks: ['typecheck:web', 'knip'],
      at: new Date(now - 40 * hour).toISOString(),
    },
  ];

  return {
    accounts: sum(ci, 'accounts') + sum(review, 'accounts'),
    costUsd: Math.round((sum(ci, 'costUsd') + sum(review, 'costUsd')) * 1e6) / 1e6,
    unaccounted: 5,
    byKind: [
      { kind: 'ci', accounts: sum(ci, 'accounts'), costUsd: sum(ci, 'costUsd'), byCause: ci },
      { kind: 'review', accounts: sum(review, 'accounts'), costUsd: sum(review, 'costUsd'), byCause: review },
    ],
    byGuard: [
      {
        guard: 'local_check',
        label: 'The local check',
        blurb: 'Running the repository’s own gate before pushing would have caught it',
        accounts: 11,
        costUsd: 38.2,
      },
      {
        guard: 'documented',
        label: 'Already written down',
        blurb: 'The rule exists in the repository and the agent did not read it',
        accounts: 9,
        costUsd: 33.5,
      },
      {
        guard: 'undocumented',
        label: 'Written down nowhere',
        blurb: 'Nothing available to the agent said this — the one an operator can fix',
        accounts: 14,
        costUsd: 51.6,
      },
      {
        guard: 'unpreventable',
        label: 'Nothing would have',
        blurb: 'A flake, the environment, or a judgement only the reviewer could make',
        accounts: 10,
        costUsd: 36.2,
      },
    ],
    recent,
  };
}

function buildDemoAllowance(): AllowanceInsights {
  const now = Date.now();
  const ago = (mins: number): string => new Date(now - mins * 60_000).toISOString();
  const points: [number, number][] = [
    [295, 41],
    [280, 43],
    [262, 46],
    [248, 47],
    [230, 51],
    [212, 55],
    [209, 56],
    [191, 59],
    [178, 61],
    [160, 66],
    [156, 67],
    [139, 70],
    [120, 74],
    [118, 75],
    [51, 79],
    [35, 83],
    [17, 88],
    [3, 91],
  ];
  const readings = points.map(([mins, used], i) => ({
    at: ago(mins),
    fiveHour: used,
    sevenDay: 62 + i * 0.4,
    afterGap: mins === 51,
    afterReset: false,
  }));

  const slotOf = new Map([
    [412, 2],
    [420, 0],
    [398, 3],
    [417, 4],
  ]);
  const lane = (agentId: string, title: string, issueNumber: number | null, from: number, to: number | null) => ({
    agentId,
    title,
    issueNumber,
    slot: issueNumber === null ? null : (slotOf.get(issueNumber) ?? null),
    startedAt: ago(from),
    endedAt: to === null ? null : ago(to),
    measured: issueNumber !== null,
  });

  return {
    generatedAt: new Date(now).toISOString(),
    window: {
      key: 'session',
      label: 'the account’s five-hour window',
      bucketLabel: '15m',
      since: ago(300),
      startsAt: ago(300),
      bucketMs: 900_000,
      buckets: 20,
      session: {
        kind: 'anchored',
        startsAt: ago(300),
        resetsAt: new Date(now + 5 * 60_000).toISOString(),
        usedPercentage: 91,
        capturedAt: ago(3),
      },
    },
    readings,
    lanes: [
      lane('agent-al-1', 'Land the arrival comment', 420, 48, 2),
      lane('agent-al-2', 'Take the worktree lease off the pool bound', 417, 40, 10),
      lane('agent-al-3', 'Appraise #398', 398, 160, 118),
      lane('agent-al-4', 'Plan the pool desk', 412, 293, 235),
      lane('agent-al-5', 'Review comments on #412', 412, 200, 145),
      lane('agent-al-6', 'Mirror the tracker', null, 265, 250),
    ],
    apportionment: {
      observedPoints: 50,
      attributedPoints: 44,
      unattributedPoints: 6,
      pointsPerUsd: 1.72,
      goals: [
        {
          issueNumber: 412,
          originRef: 'issue:412',
          slot: slotOf.get(412) ?? 0,
          title: 'Publish this fleet’s claims to the pool',
          costUsd: 8.14,
          points: 14,
          landed: 2,
          pointsPerLanded: 7,
        },
        {
          issueNumber: 420,
          originRef: 'issue:420',
          slot: slotOf.get(420) ?? 0,
          title: 'Comment on the ticket when the work arrives',
          costUsd: 6.98,
          points: 12,
          landed: 0,
          pointsPerLanded: null,
        },
        {
          issueNumber: 398,
          originRef: 'issue:398',
          slot: slotOf.get(398) ?? 0,
          title: 'One exclusion matrix for the issue verdicts',
          costUsd: 6.1,
          points: 10.5,
          landed: 1,
          pointsPerLanded: 10.5,
        },
        {
          issueNumber: 417,
          originRef: 'issue:417',
          slot: slotOf.get(417) ?? 0,
          title: 'Read the pool bound off the agent cap',
          costUsd: 4.36,
          points: 7.5,
          landed: 3,
          pointsPerLanded: 2.5,
        },
      ],
    },
    projection: {
      usedPercentage: 69,
      capturedAt: ago(3),
      resetsAt: new Date(now + 34 * 3_600_000).toISOString(),
      ratePerHour: 1.1,
      exhaustsAt: new Date(now + 28 * 3_600_000).toISOString(),
      beforeReset: true,
      fittedFrom: 14,
    },
  };
}

function buildDemoUsage(): UsagePayload {
  const now = Date.now();
  const ask = (
    id: OperatorRow['id'],
    subject: UsageSubject,
    label: string,
    blurb: string,
    figures: Pick<
      OperatorRow,
      'offered' | 'settled' | 'declined' | 'openPastWindow' | 'medianAnswerMs' | 'parkedCostUsd'
    >,
  ): OperatorRow => ({ id, kind: 'ask', subject, label, blurb, ...figures });
  const act = (
    id: OperatorRow['id'],
    subject: UsageSubject,
    label: string,
    blurb: string,
    settled: number,
  ): OperatorRow => ({
    id,
    kind: 'act',
    subject,
    label,
    blurb,
    offered: null,
    settled,
    declined: null,
    openPastWindow: 0,
    medianAnswerMs: null,
    parkedCostUsd: null,
  });
  const reach = (
    subject: UsageSubject,
    verdict: SurfaceVerdict,
    views: number,
    linkedViews: number,
    operations: number,
  ): SurfaceRow => ({
    subject,
    label: DEMO_SUBJECT_LABEL[subject],
    verdict,
    verdictLabel: DEMO_VERDICT[verdict].label,
    verdictBlurb: DEMO_VERDICT[verdict].blurb,
    views,
    operations,
    linkedViews,
    byVerb: operations === 0 ? [] : [{ verb: 'expand', label: 'Opened something inside', count: operations }],
  });
  const rows = [
    reach('plan', 'operated', 41, 39, 22),
    reach('goal', 'operated', 88, 84, 31),
    reach('pr', 'operated', 63, 60, 12),
    reach('validation', 'visited-never-operated', 9, 9, 0),
    reach('review-pack', 'visited-never-operated', 4, 4, 0),
    reach('escalation', 'operated', 17, 17, 9),
    reach('human-task', 'operated', 12, 12, 5),
    reach('ticket', 'operated', 55, 50, 18),
    reach('feature', 'linked-never-visited', 0, 0, 0),
    reach('agent', 'operated', 74, 71, 26),
    reach('obstacle', 'linked-never-visited', 0, 0, 0),
    reach('local-run', 'visited-never-operated', 2, 2, 0),
    reach('job', 'operated', 8, 8, 3),
    reach('retro', 'never-linked', 0, 0, 0),
    reach('scratchpad', 'never-linked', 0, 0, 0),
    reach('insights', 'operated', 23, 23, 14),
    reach('pool', 'visited-never-operated', 3, 3, 0),
    reach('config', 'operated', 6, 6, 2),
    reach('upgrade', 'visited-never-operated', 2, 2, 0),
    reach('pet', 'operated', 5, 5, 1),
  ];
  return {
    insights: {
      window: demoWindow(now, 7),
      asks: [
        ask('escalation', 'escalation', 'Escalation', 'An agent stopped and asked', {
          offered: 21,
          settled: 17,
          declined: 3,
          openPastWindow: 1,
          medianAnswerMs: 47 * 60_000,
          parkedCostUsd: 18.4,
        }),
        ask('human-task', 'human-task', 'Human task', 'Work only a person could do', {
          offered: 14,
          settled: 12,
          declined: 1,
          openPastWindow: 1,
          medianAnswerMs: 3 * 60 * 60_000,
          parkedCostUsd: 9.2,
        }),
        ask('plan-approval', 'plan', 'Plan approval', 'A decomposition waiting to be released', {
          offered: 19,
          settled: 16,
          declined: 3,
          openPastWindow: 0,
          medianAnswerMs: 26 * 60_000,
          parkedCostUsd: 27.6,
        }),
        ask('obstacle-ownership', 'obstacle', 'Obstacle ownership', 'Something in the way, unowned', {
          offered: 4,
          settled: 1,
          declined: null,
          openPastWindow: 2,
          medianAnswerMs: null,
          parkedCostUsd: null,
        }),
        ask('validation-bench', 'validation', 'Validation bench', 'The close-out obligation on a delivered goal', {
          offered: 11,
          settled: 7,
          declined: 0,
          openPastWindow: 3,
          medianAnswerMs: 9 * 60 * 60_000,
          parkedCostUsd: 64.1,
        }),
        ask('upgrade', 'upgrade', 'Upgrade', 'A build the harness could rebuild itself onto', {
          offered: 1,
          settled: 0,
          declined: null,
          openPastWindow: 1,
          medianAnswerMs: null,
          parkedCostUsd: null,
        }),
      ],
      acts: [
        act('stack-landing', 'pr', 'Authorising a landing', 'A merge, or a whole stack, cleared to land', 12),
        act('plan-amendment', 'plan', 'Amending a plan', 'A correction to a plan already running', 5),
        act('plan-abandoned', 'plan', 'Abandoning a plan', 'The plan was dropped and nothing replaced it', 1),
        act(
          'validation-check',
          'validation',
          'Settling a check',
          'A person ran the procedure and said what it did',
          23,
        ),
        act('goal-retired', 'goal', 'Concluding a goal', 'The operator declared the work finished', 6),
        act('agent-stopped', 'agent', 'Stopping an agent', 'A running agent was halted by a person', 4),
      ],
      fleetRateUsdPerHour: 2.34,
    },
    reach: { rows, total: rows.reduce((n, r) => n + r.views + r.operations, 0), places: 14 },
  };
}

const DEMO_SUBJECT_LABEL: Record<UsageSubject, string> = {
  plan: 'Plans',
  goal: 'Goals',
  pr: 'Pull requests',
  validation: 'Validation',
  'review-pack': 'Review packs',
  escalation: 'Escalations',
  'human-task': 'The bench',
  ticket: 'Tickets',
  feature: 'The feature board',
  agent: 'Agents',
  obstacle: 'Obstacles',
  'local-run': 'The local run',
  job: 'Jobs',
  retro: 'Retros',
  scratchpad: 'The scratchpad',
  insights: 'Insights',
  pool: 'The pool',
  config: 'Configuration',
  upgrade: 'The build',
  pet: 'The vivarium',
};

const DEMO_VERDICT: Record<SurfaceVerdict, { label: string; blurb: string }> = {
  'console-dark': {
    label: 'Console dark',
    blurb: 'Nothing was reached at all in this window, so no reading of this surface in it means anything',
  },
  'never-linked': {
    label: 'Never linked',
    blurb: 'Nothing in the cockpit has ever carried anybody here — it is reachable only by address',
  },
  'linked-never-visited': {
    label: 'Linked, never visited',
    blurb: 'A link to it exists and has been taken before; in this window nobody went',
  },
  'visited-never-operated': {
    label: 'Visited, never operated',
    blurb: 'Reached, and nothing was done there — the one case where the silence is the surface’s own',
  },
  operated: { label: 'Operated', blurb: 'Somebody did something here' },
};

function buildDemoMcp(): McpInsights {
  const now = Date.now();
  const ago = (mins: number): string => new Date(now - mins * 60_000).toISOString();
  const fleet = 1_919;

  const tool = (
    name: string,
    naming: McpNaming,
    calls: number,
    refused: number,
    medianMs: number,
    lastMins: number | null,
    namedInPrompts: number,
  ): McpToolUsage => ({
    tool: name,
    channel: naming === 'desktop' ? 'desktop' : 'fleet',
    naming,
    calls,
    refused,
    share: Math.round((calls / fleet) * 100) / 100,
    medianMs: calls === 0 ? null : medianMs,
    lastCalledAt: lastMins === null ? null : ago(lastMins),
    namedInAddendum: naming === 'addendum',
    namedInPrompts,
    argsBytes: calls * 220,
  });

  const tools: McpToolUsage[] = [
    tool('note_progress', 'addendum', 412, 0, 3, 2, 0),
    tool('scratch_read', 'point-of-use', 208, 0, 5, 6, 31),
    tool('scratch_append', 'point-of-use', 197, 0, 6, 6, 31),
    tool('world_read', 'addendum', 173, 0, 41, 11, 0),
    tool('knowledge_ask', 'addendum', 156, 0, 780, 18, 0),
    tool('request_permission', 'point-of-use', 149, 0, 1_400, 9, 0),
    tool('conclude_part', 'point-of-use', 121, 4, 34, 22, 24),
    tool('raise', 'addendum', 96, 2, 28, 31, 0),
    tool('plan_submit', 'addendum', 84, 6, 96, 44, 0),
    tool('open_pr', 'addendum', 71, 5, 2_900, 51, 0),
    tool('validation_report', 'point-of-use', 58, 3, 22, 62, 12),
    tool('conclude_work', 'point-of-use', 47, 0, 41, 74, 19),
    tool('assess_issue', 'point-of-use', 39, 0, 26, 118, 9),
    tool('link_ticket', 'point-of-use', 31, 2, 310, 190, 7),
    tool('appraise_issue', 'point-of-use', 27, 0, 24, 205, 6),
    tool('retro_submit', 'point-of-use', 19, 0, 18, 300, 5),
    tool('escalate', 'addendum', 14, 1, 15, 470, 0),
    tool('report_remedy', 'point-of-use', 11, 11, 12, 540, 4),

    tool('report_finding', 'retired', 6, 6, 2, 96, 1),
    tool('request_human_task', 'addendum', 0, 0, 0, 27_360, 0),
    tool('validation_amend', 'point-of-use', 0, 0, 0, null, 0),
    tool('validation_read', 'desktop', 18, 0, 14, 130, 0),
    tool('validation_claim', 'desktop', 11, 0, 9, 133, 0),
    tool('validation_report', 'desktop', 9, 0, 21, 140, 0),
    tool('plan_read', 'desktop', 5, 0, 17, 1_440, 0),
    tool('local_run', 'desktop', 3, 0, 62, 1_450, 0),
    tool('plan_amend', 'desktop', 0, 0, 0, null, 0),
  ];

  const quiet: McpQuietTool[] = [
    {
      tool: 'report_remedy',
      channel: 'fleet',
      naming: 'point-of-use',
      verdict: 'always-refused',
      label: 'Called and always refused',
      blurb: 'Agents are reaching for it and its contract turns every one of them away.',
      remedy:
        'Read the refusals below — a tool refusing every call is either a schema nobody can satisfy or a prompt describing arguments it does not take.',
      calls: 11,
      refused: 11,
      namedInAddendum: false,
      namedInPrompts: 4,
      lastCalledAt: ago(540),
      lastRefusal: 'guard must be one of local_check, documented, undocumented, unpreventable',
    },
    {
      tool: 'report_finding',
      channel: 'fleet',
      naming: 'retired',
      verdict: 'retired',
      label: 'Retired, and still being called',
      blurb: 'This name was withdrawn. Something is still naming it, and every call to it spends a turn on a refusal.',
      remedy: 'Find the prompt override that names it and say `raise` instead. The Setup reading names the file.',
      calls: 6,
      refused: 6,
      namedInAddendum: false,
      namedInPrompts: 1,
      lastCalledAt: ago(96),
      lastRefusal: 'report_finding has been retired. Everything it did is now one call: raise(claim, evidence)',
    },
    {
      tool: 'validation_amend',
      channel: 'fleet',
      naming: 'point-of-use',
      verdict: 'never-named',
      label: 'Nothing named it',
      blurb:
        'Its name is in neither the protocol addendum nor any prompt dispatched in this window, so no agent was told it exists. Being in `tools/list` is not being told.',
      remedy:
        'Name it where it is used — in the dispatch prompt for the work it belongs to, or in the addendum if every agent may call it.',
      calls: 0,
      refused: 0,
      namedInAddendum: false,
      namedInPrompts: 0,
      lastCalledAt: null,
      lastRefusal: null,
    },
    {
      tool: 'request_human_task',
      channel: 'fleet',
      naming: 'addendum',
      verdict: 'named-never-called',
      label: 'Named, never reached for',
      blurb:
        'Agents were told about it and none called it. Either the job it does did not come up, or the wording is not landing.',
      remedy: 'Worth a look if the job it does plainly did come up — otherwise this is the tool waiting for its case.',
      calls: 0,
      refused: 0,
      namedInAddendum: true,
      namedInPrompts: 0,
      lastCalledAt: ago(27_360),
      lastRefusal: null,
    },
    {
      tool: 'plan_amend',
      channel: 'desktop',
      naming: 'desktop',
      verdict: 'desktop-unused',
      label: 'No desktop session used it',
      blurb:
        'A desktop tool is called by a person at their own keyboard, so zero means nobody ran one — not that anything is wrong.',
      remedy: null,
      calls: 0,
      refused: 0,
      namedInAddendum: false,
      namedInPrompts: 0,
      lastCalledAt: null,
      lastRefusal: null,
    },
  ];

  const silentRuns: McpSilentRun[] = [
    {
      agentId: 'agent_demo_1174',
      taskId: 'task_demo_1174',
      title: 'Build the pagination rung',
      originRef: 'issue:412',
      phase: 'build',
      phaseLabel: PHASE_COPY.build.label,
      profile: 'reviewer-fast',
      status: 'done',
      endedAt: ago(310),
    },
    {
      agentId: 'agent_demo_1181',
      taskId: 'task_demo_1181',
      title: 'Answer the red check on #409',
      originRef: 'pr:409',
      phase: 'ci',
      phaseLabel: PHASE_COPY.ci.label,
      profile: 'reviewer-fast',
      status: 'done',
      endedAt: ago(505),
    },
    {
      agentId: 'agent_demo_1206',
      taskId: 'task_demo_1206',
      title: 'Extract the settings reader on #390',
      originRef: 'issue:390',
      phase: 'build',
      phaseLabel: PHASE_COPY.build.label,
      profile: 'reviewer-fast',
      status: 'done',
      endedAt: ago(1_180),
    },
  ];

  const byPhase: McpPhaseUsage[] = [
    { phase: 'deliberation', runs: 22, calls: 486, perRun: 22.1, silentRuns: 0 },
    { phase: 'build', runs: 41, calls: 731, perRun: 17.8, silentRuns: 2 },
    { phase: 'ci', runs: 28, calls: 213, perRun: 7.6, silentRuns: 1 },
    { phase: 'landing', runs: 11, calls: 96, perRun: 8.7, silentRuns: 0 },
    { phase: 'evidence', runs: 19, calls: 268, perRun: 14.1, silentRuns: 0 },
    { phase: 'local', runs: 3, calls: 37, perRun: 12.3, silentRuns: 0 },
    { phase: 'job', runs: 8, calls: 88, perRun: 11, silentRuns: 0 },
  ].map((row) => ({ ...row, phase: row.phase as SpendPhase, label: PHASE_COPY[row.phase as SpendPhase].label }));

  const addendum = tools.filter((t) => t.naming === 'addendum');
  const point = tools.filter((t) => t.naming === 'point-of-use');
  const retired = tools.filter((t) => t.naming === 'retired');
  const namingRow = (naming: McpNaming, label: string, blurb: string, of: readonly McpToolUsage[]): McpNamingTotal => {
    const calls = of.reduce((sum, t) => sum + t.calls, 0);
    return {
      naming,
      label,
      blurb,
      calls,
      share: Math.round((calls / fleet) * 100) / 100,
      tools: of.length,
      toolsCalled: of.filter((t) => t.calls > 0).length,
    };
  };

  return {
    window: demoWindow(now, 7),
    totals: {
      calls: fleet,
      refused: 40,
      runs: 132,
      silentRuns: 3,
      callsPerRun: 14.56,
      medianCallsPerRun: 11,
      busiestRunCalls: 68,
      medianMs: 22,
      toolsAdvertised: 20,
      toolsQuiet: 4,
      toolsRetiredCalled: 0,
      argsBytes: 432_300,
      argsCompacted: 0,
    },
    channels: [
      { channel: 'fleet', calls: fleet, refused: 40, toolsAdvertised: 20, toolsCalled: 19 },
      { channel: 'desktop', calls: 46, refused: 0, toolsAdvertised: 6, toolsCalled: 5 },
    ],
    tools,
    quiet,
    silentRuns,
    byPhase,
    naming: [
      namingRow(
        'addendum',
        'Addendum',
        'Named to every agent on every dispatch. Silence here is a broken channel or a prompt that stopped naming it.',
        addendum,
      ),
      namingRow(
        'point-of-use',
        'Point of use',
        'Named by the prompt that dispatches the work it belongs to. Silence tracks what ran.',
        point,
      ),
      namingRow(
        'retired',
        'Retired',
        'A withdrawn name, answered only with a refusal naming `raise`. Any call at all is a prompt out of date.',
        retired,
      ),
    ],
    refusals: [
      {
        tool: 'report_remedy',
        channel: 'fleet',
        refused: 11,
        calls: 11,
        message: 'guard must be one of local_check, documented, undocumented, unpreventable',
        at: ago(540),
      },
      {
        tool: 'plan_submit',
        channel: 'fleet',
        refused: 6,
        calls: 84,
        message: 'a part names no files, so nothing could be dispatched for it',
        at: ago(44),
      },
      {
        tool: 'report_finding',
        channel: 'fleet',
        refused: 6,
        calls: 6,
        message: 'report_finding has been retired. Everything it did is now one call: raise(claim, evidence)',
        at: ago(96),
      },
      {
        tool: 'open_pr',
        channel: 'fleet',
        refused: 5,
        calls: 71,
        message: 'the branch has no commits the base does not already have',
        at: ago(51),
      },
      {
        tool: 'conclude_part',
        channel: 'fleet',
        refused: 4,
        calls: 121,
        message: 'this part has no open pull request, so there is nothing to conclude',
        at: ago(22),
      },
    ],
    allowedToolsOverridden: true,
  };
}

function buildDemoReliability(): ReliabilityInsights {
  const now = Date.now();
  const day = 24 * 3_600_000;
  const start = now - DEMO_CI_DAYS.length * day;
  const round = (n: number) => Math.round(n * 1e6) / 1e6;

  const byPhase = DEMO_PHASE_HEALTH.map((row) => ({
    phase: row.phase,
    label: PHASE_COPY[row.phase].label,
    settled: row.settled,
    completed: row.settled - row.lost - row.stopped,
    lost: row.lost,
    stopped: row.stopped,
    completionRate: (row.settled - row.lost - row.stopped) / row.settled,
    lostCostUsd: row.lostCostUsd,
    medianMs: row.medianMs,
  }));
  const tally = byPhase.reduce(
    (a, p) => ({
      settled: a.settled + p.settled,
      completed: a.completed + p.completed,
      lost: a.lost + p.lost,
      stopped: a.stopped + p.stopped,
    }),
    { settled: 0, completed: 0, lost: 0, stopped: 0 },
  );
  const reds = DEMO_CI_DAYS.reduce((a, [red]) => a + red, 0);
  const greens = DEMO_CI_DAYS.reduce((a, [, green]) => a + green, 0);

  return {
    generatedAt: new Date(now).toISOString(),
    window: demoWindow(now, DEMO_CI_DAYS.length),
    runs: {
      ...tally,
      live: 4,
      completionRate: tally.completed / tally.settled,
      costUsd: round(DEMO_OUTCOMES.reduce((a, o) => a + o.costUsd, 0)),
      lostCostUsd: round(DEMO_PHASE_HEALTH.reduce((a, p) => a + p.lostCostUsd, 0)),
      unmeasuredRuns: 2,
      byOutcome: DEMO_OUTCOMES.map((o) => ({ ...o, ...OUTCOME_COPY[o.outcome] })),
      byPhase,
      repeats: DEMO_REPEATS.map(({ hoursAgo, ...r }) => ({
        ...r,
        lastAt: new Date(now - hoursAgo * 3_600_000).toISOString(),
      })),
      repeatedOrigins: DEMO_REPEATS.length,
      timeline: {
        bucketMs: day,
        startsAt: new Date(start).toISOString(),
        buckets: DEMO_CI_DAYS.map(([red], i) => ({
          startsAt: new Date(start + i * day).toISOString(),
          settled: red + 1,
          lost: red > 1 ? 1 : 0,
        })),
      },
    },
    ci: {
      reds,
      greens,
      redRate: reds / (reds + greens),
      prsAffected: DEMO_FLAKY.length,
      prsObserved: 9,
      recoveries: 14,
      medianToGreenMs: 22 * 60_000,
      slowestToGreenMs: 5 * 3_600_000,
      unrecovered: DEMO_FLAKY.filter((f) => f.stillRed).length,
      flakiest: DEMO_FLAKY,
      ciCostUsd: round(DEMO_FLAKY.reduce((a, f) => a + f.costUsd, 0)),
      landingCostUsd: 2.1,
      timeline: {
        bucketMs: day,
        startsAt: new Date(start).toISOString(),
        buckets: DEMO_CI_DAYS.map(([red, green], i) => ({
          startsAt: new Date(start + i * day).toISOString(),
          red,
          green,
        })),
      },
    },
  };
}

function buildDemoThroughput(): ThroughputInsights {
  const now = Date.now();
  const day = 24 * 3_600_000;
  const start = now - DEMO_THROUGHPUT_DAYS.length * day;
  const sum = (at: 0 | 1 | 2 | 3 | 4): number => DEMO_THROUGHPUT_DAYS.reduce((a, row) => a + row[at], 0);
  const opened = sum(0);
  const merged = sum(1);
  const abandoned = sum(2);
  const received = sum(3);
  const replied = sum(4);
  const spanMs = DEMO_THROUGHPUT_DAYS.length * day;
  const counts: Record<ThroughputMeasure, number> = {
    'issue-opened': DEMO_THROUGHPUT_ISSUES['issue-opened'],
    'issue-closed': DEMO_THROUGHPUT_ISSUES['issue-closed'],
    'pr-opened': opened,
    'pr-merged': merged,
    'pr-closed': abandoned,
    'pr-approved': DEMO_THROUGHPUT_ISSUES['pr-approved'],
    'review-received': received,
    'reply-sent': replied,
  };
  const toMerge = DEMO_THROUGHPUT_BUSIEST.map((s) => s.toMergeHours).filter((h): h is number => h !== null);

  return {
    generatedAt: new Date(now).toISOString(),
    window: demoWindow(now, DEMO_THROUGHPUT_DAYS.length),
    spanMs,
    totals: THROUGHPUT_MEASURE_ORDER.map((measure) => ({
      measure,
      label: THROUGHPUT_COPY[measure].label,
      blurb: THROUGHPUT_COPY[measure].blurb,
      ours: THROUGHPUT_COPY[measure].ours,
      count: counts[measure],
      perDay: (counts[measure] * day) / spanMs,
    })),
    landing: {
      opened,
      settled: merged + abandoned,
      merged,
      abandoned,
      mergeRate: merged / (merged + abandoned),
      paired: toMerge.length,
      medianToMergeMs: 6.5 * 3_600_000,
      slowestToMergeMs: Math.max(...toMerge) * 3_600_000,
    },
    conversation: {
      received,
      replied,
      replyRate: replied / received,
      prsCommented: DEMO_THROUGHPUT_BUSIEST.length,
    },
    busiest: DEMO_THROUGHPUT_BUSIEST.map(({ toMergeHours, hoursAgo, ...row }) => ({
      ...row,
      toMergeMs: toMergeHours === null ? null : toMergeHours * 3_600_000,
      lastAt: new Date(now - hoursAgo * 3_600_000).toISOString(),
    })),
    prsTouched: DEMO_THROUGHPUT_BUSIEST.length + 6,
    timeline: {
      bucketMs: day,
      startsAt: new Date(start).toISOString(),
      buckets: DEMO_THROUGHPUT_DAYS.map(([o, m, c, comments, replies], i) => ({
        startsAt: new Date(start + i * day).toISOString(),
        opened: o,
        merged: m,
        closed: c,
        comments,
        replies,
      })),
    },
  };
}

function demoWindow(now: number, days: number): InsightsWindowView {
  const dayMs = 24 * 60 * 60 * 1000;
  return {
    key: '7d',
    label: '7d',
    bucketLabel: `${days} daily buckets`,
    since: new Date(now - days * dayMs).toISOString(),
    startsAt: new Date(now - days * dayMs).toISOString(),
    bucketMs: dayMs,
    buckets: days,
    session: null,
  };
}

function buildDemoSpend(): SpendInsights {
  const now = Date.now();
  const iso = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  const zero = (): Record<SpendPhase, number> => ({
    deliberation: 0,
    build: 0,
    ci: 0,
    landing: 0,
    evidence: 0,
    local: 0,
    obstacle: 0,
    job: 0,
    other: 0,
  });

  const goals: SpendGoal[] = DEMO_GOAL_SEEDS.map((seed) => {
    const byPhase = { ...zero(), ...seed.byPhase };
    const costUsd = round(Object.values(byPhase).reduce((a, b) => a + b, 0));
    return {
      originRef: `issue:${seed.issueNumber}`,
      issueNumber: seed.issueNumber,
      title: seed.title,
      localRuns: seed.localRuns,
      costUsd,
      ...demoTokens(costUsd),
      agents: seed.agents,
      byPhase,
      lastAt: iso(seed.hoursAgo),
    };
  }).sort((a, b) => b.costUsd - a.costUsd);

  const phaseCost = zero();
  const phaseRuns = zero();
  for (const goal of goals) {
    for (const [phase, cost] of Object.entries(goal.byPhase) as [SpendPhase, number][]) {
      phaseCost[phase] = round(phaseCost[phase] + cost);
      if (cost > 0) phaseRuns[phase] += 1;
    }
  }
  for (const loose of DEMO_LOOSE) {
    phaseCost[loose.phase] = round(phaseCost[loose.phase] + loose.costUsd);
    phaseRuns[loose.phase] += 1;
  }

  const order: SpendPhase[] = ['deliberation', 'build', 'ci', 'landing', 'evidence', 'local', 'job', 'other'];
  const phases = order
    .filter((phase) => phaseRuns[phase] > 0)
    .map((phase) => ({
      phase,
      ...PHASE_COPY[phase],
      costUsd: phaseCost[phase],
      ...demoTokens(phaseCost[phase]),
      runs: phaseRuns[phase],
    }));

  const costUsd = round(phases.reduce((a, p) => a + p.costUsd, 0));
  const measuredRuns = goals.reduce((a, g) => a + g.agents + g.localRuns, 0) + DEMO_LOOSE.length;
  const runs: SpendRun[] = DEMO_RUNS.map((r) => ({
    id: r.id,
    kind: r.kind,
    originRef: r.originRef,
    title: r.title,
    phase: r.phase,
    issueNumber: Number(/^issue:(\d+)/.exec(r.originRef)?.[1] ?? NaN) || null,
    costUsd: r.costUsd,
    ...demoTokens(r.costUsd),
    numTurns: r.turns,
    startedAt: iso(r.hoursAgo + 1),
    endedAt: iso(r.hoursAgo),
  }));

  return {
    generatedAt: new Date(now).toISOString(),
    totals: {
      costUsd,
      ...demoTokens(costUsd),
      ...demoCache(costUsd),
      turns: 268,
      measuredRuns,
      unmeasuredRuns: 2,
    },
    window: demoWindow(now, 14),
    landed: 9,
    lostCostUsd: round(DEMO_PHASE_HEALTH.reduce((a, p) => a + p.lostCostUsd, 0)),
    phases,
    goals,
    unattributedCostUsd: round(DEMO_LOOSE.reduce((a, l) => a + l.costUsd, 0)),
    taskTypes: DEMO_TASK_TYPES.map((t) => ({
      ...t,
      ...(RULE_COPY[t.rule ?? 'none'] ?? { label: t.rule ?? 'No rule', description: null }),
      perRunUsd: round(t.costUsd / t.runs),
    })),
    checks: {
      checks: DEMO_CHECKS.map((c) => ({ ...c, perRunUsd: round(c.costUsd / c.runs), lastAt: iso(c.hoursAgo) })),
      seen: DEMO_CHECKS.length,
      attributedCostUsd: round(DEMO_CHECKS.reduce((a, c) => a + c.costUsd, 0)),
      unnamedCostUsd: 0.42,
    },
    runs,
    rankedFrom: measuredRuns,
    timeline: {
      bucketMs: 86_400_000,
      startsAt: new Date(now - DEMO_DAYS.length * 86_400_000).toISOString(),
      buckets: DEMO_DAYS.map((cost, i) => ({
        startsAt: new Date(now - (DEMO_DAYS.length - i) * 86_400_000).toISOString(),
        costUsd: cost,
      })),
    },
  };
}

const DEMO_TREND_WEEKS: {
  costs: number[];
  byPhase: Partial<Record<SpendPhase, number>>;
  settled: number;
  completed: number;
  lostCostUsd: number;
  reds: number;
  reopened: number;
}[] = [
  {
    costs: [6.2, 9.1, 12.4, 8.8],
    byPhase: { deliberation: 1.28, build: 4.2, ci: 2.02, landing: 1.24, evidence: 0.38 },
    settled: 41,
    completed: 33,
    lostCostUsd: 3.1,
    reds: 10,
    reopened: 0,
  },
  {
    costs: [7.4, 8.9, 11.2],
    byPhase: { deliberation: 1.31, build: 4.11, ci: 1.94, landing: 1.2, evidence: 0.36 },
    settled: 38,
    completed: 32,
    lostCostUsd: 2.6,
    reds: 7,
    reopened: 1,
  },
  {
    costs: [5.9, 9.6, 10.8, 13.1, 7.2],
    byPhase: { deliberation: 1.22, build: 4.3, ci: 2.4, landing: 1.28, evidence: 0.4 },
    settled: 45,
    completed: 36,
    lostCostUsd: 3.4,
    reds: 14,
    reopened: 0,
  },
  {
    costs: [6.8, 8.4, 9.9, 11.6],
    byPhase: { deliberation: 1.34, build: 4.06, ci: 2.0, landing: 1.22, evidence: 0.36 },
    settled: 40,
    completed: 33,
    lostCostUsd: 2.8,
    reds: 9,
    reopened: 0,
  },
  {
    costs: [5.1, 7.2, 8.6, 6.4],
    byPhase: { deliberation: 1.62, build: 3.14, ci: 1.32, landing: 0.84, evidence: 0.28 },
    settled: 39,
    completed: 33,
    lostCostUsd: 1.9,
    reds: 6,
    reopened: 0,
  },
  {
    costs: [4.8, 6.8, 7.9, 6.1, 5.4],
    byPhase: { deliberation: 1.66, build: 2.88, ci: 1.14, landing: 0.78, evidence: 0.26 },
    settled: 42,
    completed: 36,
    lostCostUsd: 1.7,
    reds: 6,
    reopened: 1,
  },
  {
    costs: [4.4, 6.4, 7.1, 5.8],
    byPhase: { deliberation: 1.71, build: 2.6, ci: 0.98, landing: 0.74, evidence: 0.24 },
    settled: 37,
    completed: 32,
    lostCostUsd: 1.4,
    reds: 5,
    reopened: 0,
  },
  {
    costs: [4.2, 6.0],
    byPhase: { deliberation: 1.74, build: 2.52, ci: 0.94, landing: 0.72, evidence: 0.22 },
    settled: 16,
    completed: 14,
    lostCostUsd: 0.6,
    reds: 2,
    reopened: 0,
  },
];

function buildDemoTrend(): SpendTrend {
  const now = Date.now();
  const week = 7 * 86_400_000;
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  const zero = (): Record<SpendPhase, number> => ({
    deliberation: 0,
    build: 0,
    ci: 0,
    landing: 0,
    evidence: 0,
    local: 0,
    obstacle: 0,
    job: 0,
    other: 0,
  });
  const median = (xs: number[]): number | null => {
    if (xs.length === 0) return null;
    const sorted = [...xs].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? null;
  };
  const tokensOf = (costUsd: number) => Math.round(costUsd * 620_000);

  const start = now - DEMO_TREND_WEEKS.length * week;
  const buckets: SpendTrendBucket[] = DEMO_TREND_WEEKS.map((seed, i) => {
    const costs = [...seed.costs].sort((a, b) => a - b);
    return {
      startsAt: new Date(start + i * week).toISOString(),
      partial: i === DEMO_TREND_WEEKS.length - 1,
      goalsClosed: costs.length,
      goalsUnmeasured: i === 2 ? 1 : 0,
      medianCostUsd: median(costs),
      medianInputTokens: median(costs.map(tokensOf)),
      costs,
      byPhase: { ...zero(), ...seed.byPhase },
      reopened: seed.reopened,
      settled: seed.settled,
      completed: seed.completed,
      completionRate: seed.settled > 0 ? seed.completed / seed.settled : null,
      lostCostUsd: seed.lostCostUsd,
      reds: seed.reds,
      redsPerGoal: costs.length > 0 ? seed.reds / costs.length : null,
    };
  });

  const fold = (span: SpendTrendBucket[]): SpendTrendPeriod => {
    const costs = span.flatMap((w) => w.costs);
    const settled = span.reduce((n, w) => n + w.settled, 0);
    const completed = span.reduce((n, w) => n + w.completed, 0);
    const byPhase = zero();
    for (const phase of Object.keys(byPhase) as SpendPhase[]) {
      const total = span.reduce((n, w) => n + w.byPhase[phase] * w.goalsClosed, 0);
      byPhase[phase] = costs.length > 0 ? round(total / costs.length) : 0;
    }
    const last = span[span.length - 1];
    return {
      startsAt: span[0]?.startsAt ?? '',
      endsAt: new Date(Date.parse(last?.startsAt ?? '') + week).toISOString(),
      weeks: span.length,
      goalsClosed: costs.length,
      medianCostUsd: median(costs),
      medianInputTokens: median(costs.map(tokensOf)),
      byPhase,
      completionRate: settled > 0 ? completed / settled : null,
      lostCostPerGoalUsd: costs.length > 0 ? round(span.reduce((n, w) => n + w.lostCostUsd, 0) / costs.length) : null,
      redsPerGoal: costs.length > 0 ? span.reduce((n, w) => n + w.reds, 0) / costs.length : null,
      reopenedRate: costs.length > 0 ? span.reduce((n, w) => n + w.reopened, 0) / costs.length : null,
    };
  };

  const complete = buckets.filter((w) => !w.partial);
  const half = Math.floor(complete.length / 2);
  const earlier = fold(complete.slice(0, half));
  const recent = fold(complete.slice(complete.length - half));
  const shareOf = (p: SpendTrendPeriod, phase: SpendPhase) => {
    const total = Object.values(p.byPhase).reduce((a, b) => a + b, 0);
    return total > 0 ? p.byPhase[phase] / total : 0;
  };

  return {
    generatedAt: new Date(now).toISOString(),
    window: demoWindow(now, 7),
    periods: DEMO_TREND_WEEKS.length,
    bucketMs: week,
    startsAt: new Date(start).toISOString(),
    buckets,
    comparison: {
      earlier,
      recent,
      phases: (Object.keys(zero()) as SpendPhase[])
        .filter((phase) => earlier.byPhase[phase] > 0 || recent.byPhase[phase] > 0)
        .map((phase) => ({
          phase,
          label: PHASE_COPY[phase].label,
          earlierUsd: earlier.byPhase[phase],
          recentUsd: recent.byPhase[phase],
          earlierShare: shareOf(earlier, phase),
          recentShare: shareOf(recent, phase),
          changeRatio:
            earlier.byPhase[phase] > 0
              ? (recent.byPhase[phase] - earlier.byPhase[phase]) / earlier.byPhase[phase]
              : null,
        })),
    },
  };
}

async function demoWorkSubtree(ref: string): Promise<{ nodes: WorkNodeView[]; refUrls: Record<string, string> }> {
  const state = await getServer().getState();
  const page = buildGoalPage(state, ref, [], null);
  if (page === null) return { nodes: [], refUrls: {} };
  const at = state.world.takenAt;
  const seen = { firstSeenAt: at, lastSeenAt: at, provenance: null, baseRef: null };
  const nodes: WorkNodeView[] = [
    {
      ...seen,
      ref,
      kind: 'issue',
      parentRef: null,
      title: page.issue.title,
      status: page.issue.state,
      terminal: page.issue.state === 'closed',
    },
  ];
  if (page.plan !== null)
    nodes.push({
      ...seen,
      ref: `${ref}:plan`,
      kind: 'plan',
      parentRef: ref,
      title: page.plan.title,
      status: page.plan.status,
      terminal: page.plan.status === 'complete' || page.plan.status === 'abandoned',
    });
  const partOf = new Map<number, string>();
  for (const part of [...page.parts.map((p) => p.part), ...page.retiredParts]) {
    const partRef = `${ref}:part:${part.slug}`;
    if (part.prNumber !== null) partOf.set(part.prNumber, partRef);
    nodes.push({
      ...seen,
      ref: partRef,
      kind: 'part',
      parentRef: ref,
      title: part.title,
      status: part.status,
      terminal: part.status === 'merged' || part.status === 'retired',
    });
  }
  for (const pr of page.openPullRequests)
    nodes.push({
      ...seen,
      ref: `pr:${pr.number}`,
      kind: 'pr',
      parentRef: partOf.get(pr.number) ?? ref,
      title: pr.title,
      status: 'open',
      terminal: false,
    });
  for (const pr of page.closedPullRequests)
    nodes.push({
      ...seen,
      ref: `pr:${pr.number}`,
      kind: 'pr',
      parentRef: partOf.get(pr.number) ?? ref,
      title: pr.title,
      status: pr.merged === true ? 'merged' : 'closed',
      terminal: true,
      provenance: 'observed',
    });
  const refUrls: Record<string, string> = {};
  for (const n of nodes) {
    const url = state.refUrls[n.ref];
    if (url !== undefined) refUrls[n.ref] = url;
  }
  return { nodes, refUrls };
}

const DEMO_REPO_ROOT = '/Users/you/code/markdown-magpie';
const DEMO_ORIGIN = 'git@github.com:example/markdown-magpie.git';

let demoSetupWritten = false;

let demoConfigText = '{}\n';

function demoConfigTextFor(set: Record<string, unknown>): string {
  const lines = Object.entries(set).map(([path, value]) => `  ${JSON.stringify(path)}: ${JSON.stringify(value)}`);
  return `{\n  "//": "Written by Setup. Every key is OPTIONAL; the project file underneath this one wins nothing — this file wins key by key.",\n\n${lines.join(',\n')}\n}\n`;
}

function demoChanges(set: Record<string, unknown>): ConfigChange[] {
  return Object.entries(set).map(([path, value]) => ({ path, from: undefined, to: value, applied: false }));
}

function demoSetupReading(): SetupPayload {
  const checks: SetupCheck[] = demoSetupWritten
    ? [
        {
          id: 'pointed',
          label: 'Pointed at real work',
          verdict: 'ok',
          detail: 'issues via github, source control via github',
        },
        { id: 'credential', label: 'Credential', verdict: 'ok', detail: 'GITHUB_TOKEN present' },
        { id: 'identity', label: 'Who you are', verdict: 'ok', detail: 'userId is you' },
        {
          id: 'watch',
          label: 'Something to work',
          verdict: 'warn',
          detail:
            'none of the 12 open item(s) carries magpie-watch, so nothing is eligible and the fleet will correctly do nothing.',
          remedy: 'Tag something from the Tickets tab, or create magpie-watch on the tracker.',
        },
        { id: 'agent', label: 'Agent runtime', verdict: 'ok', detail: 'stream · 2.1.4' },
        {
          id: 'billing',
          label: 'Model billing',
          verdict: 'bad',
          detail:
            'ANTHROPIC_API_KEY is set, and agents inherit it — in non-interactive mode the CLI uses the key whenever it is present, with no prompt, so every agent bills the API rather than the login.',
          remedy: 'Unset it in the shell that starts the harness unless that is what you meant.',
        },
      ]
    : [
        {
          id: 'pointed',
          label: 'Pointed at real work',
          verdict: 'warn',
          detail: 'No config file at all, so this is the shipped mock: a fake tracker and a fake agent.',
          remedy: 'Answer the two questions and Setup will write the file.',
        },
        { id: 'credential', label: 'Credential', verdict: 'ok', detail: 'the fake provider needs none' },
        {
          id: 'identity',
          label: 'Who you are',
          verdict: 'warn',
          detail:
            'userId is unset, so all three ownership gates are off: any tagger counts, filed tickets go unassigned, and every open pull request is surfaced.',
          remedy: 'Setup resolves it from your email against the provider.',
        },
        {
          id: 'watch',
          label: 'Something to work',
          verdict: 'unknown',
          detail: 'no cycle has read the world yet, so there is nothing to count.',
        },
        {
          id: 'agent',
          label: 'Agent runtime',
          verdict: 'warn',
          detail: 'agentMode is raw, the mock — a dispatch writes a transcript and never calls a model.',
          remedy: 'Set agentMode to stream.',
        },
        {
          id: 'billing',
          label: 'Model billing',
          verdict: 'bad',
          detail:
            'ANTHROPIC_API_KEY is set, and agents inherit it — in non-interactive mode the CLI uses the key whenever it is present, with no prompt, so every agent bills the API rather than the login.',
          remedy: 'Unset it in the shell that starts the harness unless that is what you meant.',
        },
      ];
  return {
    configFile: '/Users/you/code/LubbDubb/lubbdubb.config.json',
    configFileExists: demoSetupWritten,
    prefill: {
      email: 'you@example.com',
      repoRoot: '/Users/you/code/LubbDubb',
      repoRootIsSelf: false,
    },
    checks,
  };
}

function demoSetupResolution(answers: { email: string; repoRoot: string }): SetupResolvePayload {
  const found = answers.repoRoot.trim() === DEMO_REPO_ROOT;
  if (!found) {
    return {
      repoRoot: answers.repoRoot,
      repoRootIsSelf: false,
      originUrl: null,
      isRepo: false,
      target: null,
      defaultBranch: null,
      identity: {
        email: answers.email,
        userId: null,
        confidence: 'unknown',
        why: 'no provider yet — nothing to resolve a login against',
      },
      credential: { variable: null, present: false, source: null },
      project: { file: null, keys: [] },
      watch: { label: 'lubbdubb-watch', fromProject: false },
      writes: { repoRoot: answers.repoRoot, agentMode: 'stream', maxConcurrentAgents: 1 },
    };
  }
  const login = answers.email.split('@')[0] || 'you';
  return {
    repoRoot: DEMO_REPO_ROOT,
    repoRootIsSelf: false,
    originUrl: DEMO_ORIGIN,
    isRepo: true,
    target: { provider: 'github', parts: ['example', 'markdown-magpie'], url: DEMO_ORIGIN },
    defaultBranch: { name: 'main', commit: '4f2a91c8e0d3b7a15c9f2e6d40b81a7c3e5f9d02' },
    identity: {
      email: answers.email,
      userId: login,
      confidence: 'confirmed',
      why: `the credential authenticates as ${login}`,
    },
    credential: { variable: 'GITHUB_TOKEN', present: true, source: 'env' },
    project: {
      file: `${DEMO_REPO_ROOT}/lubbdubb.project.json`,
      keys: ['ci', 'environments', 'issuePickupStates', 'labelPrefix'],
    },
    watch: { label: 'magpie-watch', fromProject: true },
    writes: {
      repoRoot: DEMO_REPO_ROOT,
      agentMode: 'stream',
      maxConcurrentAgents: 1,
      defaultBranch: 'main',
      userId: login,
      'integrations.sourceControl': 'github',
      'integrations.issues': 'github',
      'github.owner': 'example',
      'github.repo': 'markdown-magpie',
    },
  };
}

const DEMO_NO_BOARD = 'the demo has no obstacle board to act on';

export const demoApi = {
  getState: () => getServer().getState(),
  getTranscript: (agentId: string, from = 0) => getServer().getTranscript(agentId, from),
  getAgentFiles: (agentId: string) => getServer().getAgentFiles(agentId),
  getGoalAgents: (ref: string, prs: readonly number[]) => getServer().getGoalAgents(ref, prs),
  getWorkRoots: () =>
    Promise.resolve({ roots: [] as WorkNodeView[], unrecorded: [] as UnrecordedWorkView[], refUrls: {} }),
  getWorkSubtree: (ref: string) => demoWorkSubtree(ref),
  getFeatures: () => Promise.resolve(buildDemoFeatureBoard()),
  answerFeatureSequence: (): Promise<never> =>
    Promise.reject(new Error('the demo has no feature order, so there is nothing to answer')),
  getTickets: (query: {
    watch: string;
    tracking: string;
    state: string;
    feature: string | null;
    order: string;
    cursor: string | null;
  }) => Promise.resolve(demoTickets(query)),
  getRetrospective: (ref: string) =>
    Promise.resolve({ retrospective: ref === 'issue:364' ? DEMO_RETROSPECTIVE : null }),
  getScratchpad: (ref: string) =>
    Promise.resolve({
      padRef: ref,
      entries: ref === 'issue:364' ? DEMO_SCRATCHPAD : ref === 'pr:413' ? DEMO_PR_PAD : [],
    }),
  getReviewPack: (prNumber: number): Promise<ReviewPackReading> =>
    Promise.resolve(
      prNumber === DEMO_REVIEW_PACK.prNumber
        ? {
            kind: 'pack',
            payload: {
              pack: DEMO_REVIEW_PACK,
              writtenAt: DEMO_REVIEW_PACK_WRITTEN_AT,
              marks: [...demoReviewMarks.values()],
              head: DEMO_PACK_HEAD,
              stale: null,
              checking: false,
              sharing: { available: false, share: null },
            },
          }
        : { kind: 'none', writing: prNumber === DEMO_PACK_WRITING_PR },
    ),
  requestReviewPack: () => Promise.reject(new Error('the demo has no fleet to write a review pack')),
  shareReviewPack: () => Promise.reject(new Error('the demo has no pool to share a review pack into')),
  unshareReviewPack: () => Promise.reject(new Error('the demo has no pool to unshare a review pack from')),
  getReviewCalibration: () => Promise.resolve({ calibration: DEMO_REVIEW_CALIBRATION }),
  markReviewIdeaRead: (_prNumber: number, ideaId: string, read: boolean) => Promise.resolve(demoMark(ideaId, { read })),
  markReviewFindingSeen: (_prNumber: number, ideaId: string, seen: boolean) =>
    Promise.resolve(demoMark(ideaId, { seen })),
  overrideReviewAttention: (_prNumber: number, ideaId: string, attention: ReviewAttention | null) =>
    Promise.resolve(demoMark(ideaId, { attention })),
  getSpend: () => Promise.resolve({ insights: buildDemoSpend() }),
  getSpendTrend: () => Promise.resolve({ trend: buildDemoTrend() }),
  getReliability: () => Promise.resolve({ insights: buildDemoReliability(), remedies: buildDemoRemedies() }),
  getThroughput: () => Promise.resolve({ insights: buildDemoThroughput() }),
  getMcpUsage: () => Promise.resolve({ insights: buildDemoMcp() }),
  getUsage: () => Promise.resolve(buildDemoUsage()),
  logUsageEvents: () => Promise.resolve(),
  getAllowance: async () => {
    const allowance = buildDemoAllowance();
    const state = await getServer().getState();
    const tracker = Object.values(state.refUrls).find((url) => /\/issues\/\d+$/.test(url)) ?? null;
    const refUrls: Record<string, string> = {};
    if (tracker !== null)
      for (const goal of allowance.apportionment.goals)
        refUrls[goal.originRef] = tracker.replace(/\d+$/, String(goal.issueNumber));
    return { allowance, refUrls };
  },
  getObstacles: () =>
    Promise.resolve({
      rows: [],
      counts: {
        sightings: 0,
        goals: 0,
        told: 0,
        window: { since: new Date().toISOString(), calls: 0, callers: 0, agents: 0 },
      },
      dormantMs: 7 * 24 * 60 * 60 * 1000,
      canFileTickets: false,
    }),
  muteObstacle: (_id: string, _muted: boolean) => Promise.reject(new Error(DEMO_NO_BOARD)),
  ownObstacle: (_id: string, _ownerRef: string) => Promise.reject(new Error(DEMO_NO_BOARD)),
  retireObstacle: (_id: string) => Promise.reject(new Error(DEMO_NO_BOARD)),
  writeDownObstacle: (_id: string) => Promise.reject(new Error(DEMO_NO_BOARD)),
  getPoolInsights: (project: string | null) =>
    Promise.resolve({
      rollup: {
        project,
        fleets: [],
        days: [],
        byPhase: [],
        byCause: [],
        byCheck: project === null ? null : [],
        unaccounted: {
          key: '',
          label: 'Unaccounted returns',
          count: 0,
          costUsd: null,
          fleets: 0,
          dailyMeanCostUsd: null,
        },
        unmeasured: { key: '', label: 'Unmeasured runs', count: 0, costUsd: null, fleets: 0, dailyMeanCostUsd: null },
        byUsage: [],
        byThroughput: [],
      },
      projects: [],
      fleets: [],
    }),
  getPool: () => Promise.resolve({ status: null, fleets: [], claims: [] }),
  getPrompts: () => Promise.resolve({ dir: null, templates: [] as PromptTemplateView[] }),
  getMcp: (): Promise<McpChannelPayload> =>
    Promise.resolve({
      running: false,
      serverId: 'lubbdubb',
      registration: { command: 'node', args: [] },
      credentialPath: '',
      skillPath: '',
      tools: [],
    }),
  getPetCatalogue: (): Promise<PetCatalogue> =>
    Promise.resolve({
      rules: {
        rates: {
          job: ZERO_RATE,
          claim: ZERO_RATE,
          finding: ZERO_RATE,
          'human-task': ZERO_RATE,
          escalation: ZERO_RATE,
          plan: ZERO_RATE,
          landing: ZERO_RATE,
          upgrade: ZERO_RATE,
        },
        rarity: { common: 0, uncommon: 0, rare: 0, mythic: 0 },
        beatsPerDollar: 0,
        blendYield: 0,
      },
      rarities: [],
      species: [],
      sources: [],
    }),
  getSetup: () => Promise.resolve(demoSetupReading()),
  resolveSetup: (answers: { email: string; repoRoot: string }) => Promise.resolve(demoSetupResolution(answers)),
  getConfig: () =>
    Promise.resolve({
      groups: [] as RunningConfigGroup[],
      file: 'lubbdubb.config.json',
      projectFile: null,
      text: demoConfigText,
      revision: 'demo',
      pending: [],
      canRestart: false,
    }),
  saveConfig: (edits: { set?: Record<string, unknown>; clear?: string[]; baseline: string }) => {
    demoConfigText = demoConfigTextFor(edits.set ?? {});
    demoSetupWritten = true;
    return Promise.resolve({
      ok: true as const,
      revision: 'demo',
      changes: demoChanges(edits.set ?? {}),
      pending: demoChanges(edits.set ?? {}),
    });
  },
  restartHarness: () => Promise.reject(new Error('the demo has no process to restart')),
  previewConfig: (edits: { set?: Record<string, unknown>; clear?: string[]; text?: string; baseline: string }) =>
    Promise.resolve({
      ok: true as const,
      text: demoConfigTextFor(edits.set ?? {}),
      changes: demoChanges(edits.set ?? {}),
    }),
  saveRawConfig: () => Promise.reject(new Error('the demo has no config file to write')),
  getCiPolicy: () =>
    Promise.resolve({ policy: { rules: [], unmatched: 'dispatch', policyKinds: null } as CiPolicyDescription }),
  fileWorkItem: (_ref: string) => Promise.resolve({ ok: false }),
  raiseBug: (_issueNumber: number, _summary: string, _title?: string) => Promise.resolve({ ok: false }),
  probeFilingTarget: (): Promise<FilingTargetProbe> =>
    Promise.resolve({
      available: false,
      target: null,
      identity: null,
      reason: 'this is the demo — there is no harness behind it to file through',
    }),
  raiseIssue: (_title: string, _body: string, _watch: boolean): Promise<IssueFiled> =>
    Promise.reject(new Error('this is the demo — there is no harness behind it to file through')),
  setWorkItemIgnored: (_ref: string, _ignored: boolean) => Promise.resolve({ ok: true as const }),
  pulse: () => getServer().pulse(),
  clearErrors: () => getServer().clearErrors(),
  inject: (event: unknown) => getServer().inject(event),
  answerEscalation: (id: string, response: string) => getServer().answerEscalation(id, response),
  answerQuestions: (id: string, answers: (string | null)[]) => getServer().answerQuestions(id, answers),
  decidePermission: (id: string, allow: boolean, note?: string) => getServer().decidePermission(id, allow, note),
  dismissEscalation: (id: string, note?: string) => getServer().dismissEscalation(id, note),
  respondAgent: (id: string, text: string) => getServer().respondAgent(id, text),
  setControl: (patch: { cap?: number; paused?: boolean }) => getServer().setControl(patch),
  setPrWatched: (prNumber: number, watched: boolean) => getServer().setPrWatched(prNumber, watched),
  setStackLanding: (ref: string, landing: boolean) => getServer().setStackLanding(ref, landing),
  setIssueWatched: (issueNumber: number, watched: boolean) => getServer().setIssueWatched(issueNumber, watched),
  setIssueState: (issueNumber: number, state: string) => getServer().setIssueState(issueNumber, state),
  setGoalPriority: (issueNumber: number, priority: boolean) => getServer().setGoalPriority(issueNumber, priority),
  setFeaturePaused: (issueNumber: number, paused: boolean) => getServer().setFeaturePaused(issueNumber, paused),
  setIssueProfile: (issueNumber: number, profile: string | null) => getServer().setIssueProfile(issueNumber, profile),
  setIssueParent: (issueNumber: number, parent: number | null) => getServer().setIssueParent(issueNumber, parent),
  setIssueAreaPath: (issueNumber: number, areaPath: string | null) =>
    getServer().setIssueAreaPath(issueNumber, areaPath),
  setPartProfile: (planId: string, slug: string, profile: string | null) =>
    getServer().setPartProfile(planId, slug, profile),
  restartPart: (planId: string, slug: string) => getServer().restartPart(planId, slug),
  regroupPlan: (planId: string, groups: { slug: string; atoms: string[]; title?: string; scope?: string }[]) =>
    getServer().regroupPlan(planId, groups),
  setIssueConclusion: (issueNumber: number, verdict: 'done' | 'more_work' | null) =>
    getServer().setIssueConclusion(issueNumber, verdict),
  setIssueAppraisal: (issueNumber: number, verdict: 'workable' | 'unclear' | null) =>
    getServer().setIssueAppraisal(issueNumber, verdict),
  addInstruction: (issueNumber: number, text: string) => getServer().addInstruction(issueNumber, text),
  overruleShortfall: (issueNumber: number, text: string) => getServer().overruleShortfall(issueNumber, text),
  releaseEnvironmentGate: (issueNumber: number, released: boolean, note?: string) =>
    getServer().releaseEnvironmentGate(issueNumber, released, note),
  withdrawInstruction: (issueNumber: number, id: string) => getServer().withdrawInstruction(issueNumber, id),
  reopenPrThread: (prNumber: number, threadId: string, reopened: boolean) =>
    getServer().reopenPrThread(prNumber, threadId, reopened),
  dismissRun: (issueNumber: number, note?: string) => getServer().dismissRun(issueNumber, note),
  replan: (planId: string) => getServer().replan(planId),
  ruleRemoteQuery: (issueNumber: number, environment: string, rowId: string, accept: boolean) =>
    getServer().ruleRemoteQuery(issueNumber, environment, rowId, accept),
  ruleWatchProposal: (issueNumber: number, checkId: string, accept: boolean) =>
    getServer().ruleWatchProposal(issueNumber, checkId, accept),
  saveWatchCheck: (issueNumber: number, check: GoalWatchDeclaration) => getServer().saveWatchCheck(issueNumber, check),
  deleteWatchCheck: (issueNumber: number, checkId: string) => getServer().deleteWatchCheck(issueNumber, checkId),
  extendWatch: (issueNumber: number, environment: string) => getServer().extendWatch(issueNumber, environment),
  getPlanHistory: (planId: string) => Promise.resolve(demoPlanHistory(planId)),
  setValidation: (issueNumber: number, checkId: string, act: ValidationAct) =>
    getServer().setValidation(issueNumber, checkId, act),
  reorderUpNext: (origins: string[]) => getServer().reorderUpNext(origins),
  setUpNextProfile: (origin: string, profile: string | null) => getServer().setUpNextProfile(origin, profile),
  launchJob: (job: { prompt: string; title?: string; kind?: string; branch?: string | null }) =>
    getServer().launchJob(job),
  cancelJob: (id: string) => getServer().cancelJob(id),
  createSchedule: (schedule: { cron: string; prompt: string; title?: string; kind?: string }) =>
    getServer().createSchedule(schedule),
  updateSchedule: (
    id: string,
    patch: { cron?: string; prompt?: string; title?: string; kind?: string; enabled?: boolean },
  ) => getServer().updateSchedule(id, patch),
  runSchedule: (id: string) => getServer().runSchedule(id),
  deleteSchedule: (id: string) => getServer().deleteSchedule(id),
  openPet: (id: string) => getServer().openPet(id),
  feedPet: (id: string, beats: number) => getServer().feedPet(id, beats),
  renamePet: (id: string, name: string) => getServer().renamePet(id, name),
  placePet: (id: string, placed: boolean) => getServer().placePet(id, placed),
  blendPet: (id: string) => getServer().blendPet(id),
  completeHumanTask: (id: string, note?: string) => getServer().completeHumanTask(id, note),
  declineHumanTask: (id: string, note: string) => getServer().declineHumanTask(id, note),
  closeHumanTaskTicket: (id: string, note?: string) => getServer().closeHumanTaskTicket(id, note),
  dismissHumanTask: (id: string) => getServer().dismissHumanTask(id),
  acceptProposal: (id: string, note?: string, acknowledged?: string[], answers?: CaveatAnswerInput[]) =>
    getServer().acceptProposal(id, note, acknowledged, answers),
  rejectProposal: (id: string, note?: string) => getServer().rejectProposal(id, note),
  backOutProposal: (id: string, verdict: 'close' | 'hold', note?: string) =>
    getServer().backOutProposal(id, verdict, note),
  decideRecovery: (_taskId: string, _verdict: string) => Promise.resolve({ ok: true as const, remaining: 0 }),
  checkBuild: () => Promise.resolve({ ok: true as const, build: getServer().getBuild() }),
  upgrade: (action: string, _opts?: { interrupt?: boolean }) => getServer().upgrade(action),
  pullProject: () => getServer().pullProject(),
  snoozeUpdate: (target: SnoozeTarget) => getServer().snoozeUpdate(target),
  startLocalRun: (issue: number, ref?: string) => getServer().startLocalRun(issue, ref),
  validateLocally: (issue: number, opts?: { swap?: boolean; refresh?: boolean }) =>
    getServer().validateLocally(issue, opts),
  cancelLocalValidation: (issue: number) => getServer().cancelLocalValidation(issue),
  stopLocalRun: () => getServer().stopLocalRun(),
  messageLocalRun: (text: string) => getServer().messageLocalRun(text),
  refreshLocalRun: () => getServer().refreshLocalRun(),
  localRunOutput: () => Promise.resolve({ lines: getServer().localRunOutput() }),
  killAgent: (id: string) => getServer().killAgent(id),
  completeAgent: (id: string) => getServer().completeAgent(id),
  interruptAgent: (id: string) => getServer().interruptAgent(id),
  resumeAgent: (id: string) => getServer().resumeAgent(id),
  extendStall: (id: string) => getServer().extendStall(id),
  ejectAgent: (id: string, reason: string) => getServer().ejectAgent(id, reason),
  settleEjection: (id: string, outcome: EjectionOutcome, note?: string) =>
    getServer().settleEjection(id, outcome, note),
};

export function connectDemoWs(onEvent: (ev: unknown) => void, onStatus?: (connected: boolean) => void): WsClient {
  return getServer().connect(onEvent, onStatus);
}

const DEMO_STATE_MOVES = new Map<number, string>();

const DEMO_FEATURES = [
  { number: 900, title: 'Payments' },
  { number: 901, title: 'Onboarding' },
  { number: 902, title: 'Platform hygiene' },
  { number: 300, title: 'Source-grounded document patrols' },
  { number: 903, title: 'Search and console polish' },
];

const DEMO_PARENTS = new Map<number, number | null>([
  [332, 300],
  [333, 300],
  [341, null],
  [395, 903],
  [379, 903],
]);

const demoFeatureOf = (n: number): { number: number; title: string } | null => {
  const stated = DEMO_PARENTS.get(n);
  if (stated !== undefined) return stated === null ? null : (DEMO_FEATURES.find((f) => f.number === stated) ?? null);
  return n % 4 === 3 ? null : (DEMO_FEATURES[n % 3] ?? null);
};

const demoFeatureSlotOf = (feature: { number: number } | null): number | null =>
  feature === null ? null : DEMO_FEATURES.findIndex((f) => f.number === feature.number);

function demoTicketRows(iso: (hoursAgo: number) => string): TicketRow[] {
  const worked: TicketRow[] = DEMO_GOAL_SEEDS.map((seed) => ({
    number: seed.issueNumber,
    title: seed.title ?? `Goal #${seed.issueNumber}`,
    state: seed.open === true ? ('open' as const) : ('closed' as const),
    watch: 'watched' as const,
    labels: ['lubbdubb-watch'],
    costUsd: Object.values(seed.byPhase).reduce((a, b) => a + b, 0),
    outcome: seed.outcome,
    addedAt: iso(seed.hoursAgo + 48),
    changedAt: iso(seed.hoursAgo),
    tracking: seed.open === true ? ('live' as const) : ('frozen' as const),
    workItemState: DEMO_STATE_MOVES.get(seed.issueNumber) ?? (seed.open === true ? 'Active' : 'Closed'),
    issueType: 'Task',
    parent: demoFeatureOf(seed.issueNumber),
    featureSlot: demoFeatureSlotOf(demoFeatureOf(seed.issueNumber)),
  }));
  const untouched: TicketRow[] = DEMO_UNTRIAGED.map((seed) => ({
    number: seed.number,
    title: seed.title,
    state: 'open' as const,
    watch: 'unwatched' as const,
    labels: [],
    costUsd: null,
    outcome: null,
    addedAt: iso(seed.hoursAgo),
    changedAt: iso(seed.hoursAgo),
    tracking: 'live' as const,
    workItemState:
      DEMO_STATE_MOVES.get(seed.number) ?? (seed.number % 3 === 0 ? 'Ready' : seed.number % 3 === 1 ? 'New' : 'Active'),
    issueType: seed.issueType,
    parent: demoFeatureOf(seed.number),
    featureSlot: demoFeatureSlotOf(demoFeatureOf(seed.number)),
  }));
  return [...worked, ...untouched];
}

function demoTickets(query: {
  watch: string;
  tracking: string;
  state: string;
  feature: string | null;
  order: string;
  cursor: string | null;
}): TicketsPayload {
  const now = Date.now();
  const iso = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
  const all = demoTicketRows(iso).sort((a, b) => b.number - a.number);
  const matching = all.filter(
    (row) =>
      (query.tracking === 'any' || row.tracking === query.tracking) &&
      (query.state === 'any' || row.workItemState === query.state) &&
      (query.feature === null ||
        (query.feature === 'none' ? row.parent === null : row.parent?.number === Number(query.feature))) &&
      (query.watch === 'any' || row.watch === query.watch),
  );
  if (query.order === 'cost') matching.sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || b.number - a.number);
  if (query.order === 'changed')
    matching.sort((a, b) => (a.changedAt < b.changedAt ? 1 : a.changedAt > b.changedAt ? -1 : b.number - a.number));

  const key = (row: TicketRow) =>
    query.order === 'cost'
      ? `${row.costUsd ?? -1}:${row.number}`
      : query.order === 'changed'
        ? `${row.changedAt}:${row.number}`
        : `${row.number}`;
  const from = query.cursor === null ? 0 : matching.findIndex((row) => key(row) === query.cursor) + 1;
  const rows = matching.slice(from, from + 40);
  const last = rows[rows.length - 1];
  return {
    rows,
    total: matching.length,
    kept: all.length,
    live: all.filter((row) => row.tracking === 'live').length,
    totalCostUsd: Math.round(matching.reduce((n, r) => n + (r.costUsd ?? 0), 0) * 100) / 100,
    nextCursor: from + rows.length < matching.length && last ? key(last) : null,
    states: [
      ...all.reduce((counts, row) => {
        const state = row.workItemState;
        if (state !== null) {
          const seen = counts.get(state);
          counts.set(state, {
            count: (seen?.count ?? 0) + 1,
            live: (seen?.live ?? 0) + (row.tracking === 'live' ? 1 : 0),
          });
        }
        return counts;
      }, new Map<string, { count: number; live: number }>()),
    ]
      .map(([state, seen]) => ({ ...seen, state, pickup: state === 'Ready' || state === 'Active' }))
      .sort((a, b) => b.count - a.count || a.state.localeCompare(b.state)),
    features: DEMO_FEATURES.map((f) => ({
      ...f,
      slot: demoFeatureSlotOf(f) ?? 0,
      count: all.filter((row) => row.parent?.number === f.number).length,
    })).filter((f) => f.count > 0),
    orphanCount: all.filter((row) => row.parent === null).length,
    anchorAt: iso(24 * 30),
    backfilling: false,
    refUrls: {},
  };
}

const DEMO_FEATURE_PAUSES = new Map<number, string>();

function buildDemoFeatureBoard(): FeatureBoardPayload {
  const now = Date.now();
  const iso = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
  const tickets = new Map(demoTicketRows(iso).map((row) => [row.number, row]));
  const environments = ['staging', 'prod'];

  const ticket = (
    number: number,
    standing: FeatureChildStanding,
    over: Partial<FeatureChildRow> = {},
  ): FeatureChildRow => {
    const row = tickets.get(number);
    if (!row) throw new Error(`demo feature board names ticket #${number}, which the tickets tab does not carry`);
    return {
      number,
      title: row.title,
      issueType: row.issueType,
      standing,
      outcome: row.outcome,
      workItemState: row.workItemState,
      costUsd: row.costUsd,
      changedAt: row.changedAt,
      ...over,
    };
  };
  const goal = (
    number: number,
    title: string,
    standing: FeatureChildStanding,
    over: Partial<Omit<FeatureChildRow, 'number' | 'title' | 'standing'>> & { changedAt: string },
  ): FeatureChildRow => ({
    number,
    title,
    issueType: null,
    standing,
    outcome: null,
    workItemState: 'Active',
    costUsd: null,
    ...over,
  });

  const children: FeatureChildRow[] = [
    ticket(390, 'queued'),
    ticket(364, 'delivered'),
    ticket(382, 'fellShort'),
    ticket(331, 'fellShort', { title: 'Give each source-grounded job a read-only workspace' }),
    ...DEMO_UNTRIAGED.map((seed) => ticket(seed.number, 'unwatched')),
    goal(376, 'Read GitHub review decisions as proposal approval', 'inFlight', {
      issueType: 'Bug',
      costUsd: 0.31,
      changedAt: iso(4 / 60),
    }),
    goal(388, 'Cap the retrieval context at the token budget before ranking', 'inFlight', {
      costUsd: 0.84,
      changedAt: iso(8 / 60),
    }),
    goal(368, 'Retry transient 502s from the embeddings endpoint', 'inFlight', {
      issueType: 'Bug',
      costUsd: 0.27,
      changedAt: iso(6 / 60),
    }),
    goal(332, 'Give HTTP providers a bounded file-tool loop', 'inFlight', {
      issueType: 'User Story',
      costUsd: 0.52,
      changedAt: iso(23 / 60),
    }),
    goal(333, 'Verify a document against its sources before correcting it', 'queued', {
      issueType: 'User Story',
      changedAt: iso(20),
    }),
    goal(345, 'The watcher drops its claim when the API restarts mid-job', 'queued', {
      issueType: 'Bug',
      workItemState: 'Ready',
      costUsd: 3.08,
      changedAt: iso(80 / 60),
    }),
    goal(359, 'Embedding backfill times out on the 40k-section repository', 'queued', {
      issueType: 'Bug',
      workItemState: 'Ready',
      costUsd: 7.36,
      changedAt: iso(30),
    }),
    goal(341, 'Answers cite a heading the section splitter renamed', 'queued', { issueType: 'Bug', changedAt: iso(1) }),
    goal(395, 'Snapshot downloads 401 in the review console', 'queued', { workItemState: 'Ready', changedAt: iso(12) }),
    goal(379, 'Make retrieval smarter', 'queued', { workItemState: 'New', changedAt: iso(52) }),
  ];

  const since = new Map<number, string>([
    [376, iso(4 / 60)],
    [388, iso(8 / 60)],
    [368, iso(35 / 60)],
    [332, iso(23 / 60)],
  ]);
  const delivered = new Map<number, Omit<FeatureReportRow, 'number' | 'title'>>([
    [
      364,
      { summary: 'PR #410 landed the deadlock note and the console warning with it.', by: 'assessor', at: iso(1.5) },
    ],
  ]);
  const blocking = new Map<number, Omit<FeatureBlockRow, 'number' | 'title'>>([
    [
      376,
      {
        kind: 'question',
        summary: 'Rebase hit a conflict in review-decision.ts — resolve which side wins?',
        since: iso(2 / 60),
      },
    ],
    [
      368,
      {
        kind: 'question',
        summary:
          'The embeddings SDK already retries once on its own — bound our retry at three attempts on top of it, ' +
          'or turn the SDK’s off and own the whole policy?',
        since: iso(6 / 60),
      },
    ],
    [
      382,
      {
        kind: 'fellShort',
        summary:
          'The threshold was raised and the two example questions now cluster apart — but the goal asks for ' +
          'clusters that are “about one thing”, and no threshold decides that.',
        since: iso(4 / 60),
      },
    ],
    [
      331,
      {
        kind: 'fellShort',
        summary:
          'The workspace is read-only as asked, but it is a fresh clone per job — a 40k-section repository ' +
          'takes four minutes to check out before the patrol reads a line.',
        since: iso(74),
      },
    ],
  ]);
  const landings: FeatureLandingRow[] = [
    { goal: 390, prNumber: 406, at: iso(0.5) },
    { goal: 364, prNumber: 410, at: iso(52 / 60) },
    { goal: 382, prNumber: 405, at: iso(3) },
    { goal: 345, prNumber: 401, at: iso(3 * 24) },
    { goal: 331, prNumber: 396, at: iso(74) },
    { goal: 345, prNumber: 397, at: iso(9 * 24) },
  ];

  const newestFirst = (a: string, b: string) => b.localeCompare(a);
  const briefing = (rows: readonly FeatureChildRow[]): FeatureBriefing => {
    const working = rows
      .filter((c) => c.standing === 'inFlight')
      .map((c) => ({ number: c.number, title: c.title, since: since.get(c.number) ?? c.changedAt }))
      .sort((a, b) => newestFirst(a.since, b.since));
    const done = rows
      .flatMap((c) => {
        const verdict = delivered.get(c.number);
        return verdict ? [{ number: c.number, title: c.title, ...verdict }] : [];
      })
      .sort((a, b) => newestFirst(a.at, b.at));
    const blocked = rows
      .flatMap((c) => {
        const block = blocking.get(c.number);
        return block ? [{ number: c.number, title: c.title, ...block }] : [];
      })
      .sort((a, b) => (a.kind === b.kind ? newestFirst(a.since, b.since) : a.kind === 'question' ? -1 : 1));
    return {
      working: working.slice(0, 3),
      workingTotal: working.length,
      delivered: done.slice(0, 3),
      deliveredTotal: done.length,
      blocking: blocked.slice(0, 3),
      blockingTotal: blocked.length,
    };
  };
  const counts = (rows: readonly FeatureChildRow[]): FeatureCounts => {
    const out: FeatureCounts = {
      delivered: 0,
      inFlight: 0,
      queued: 0,
      fellShort: 0,
      settled: 0,
      unwatched: 0,
      total: 0,
    };
    for (const child of rows) {
      out[child.standing] += 1;
      out.total += 1;
    }
    return out;
  };
  const cost = (rows: readonly FeatureChildRow[]): number | null => {
    const spent = rows.map((c) => c.costUsd).filter((c): c is number => c !== null);
    return spent.length === 0 ? null : Math.round(spent.reduce((a, b) => a + b, 0) * 100) / 100;
  };
  const landedUnder = (rows: readonly FeatureChildRow[]): FeatureLandingRow[] => {
    const under = new Set(rows.map((c) => c.number));
    return landings.filter((l) => under.has(l.goal)).sort((a, b) => newestFirst(a.at, b.at));
  };
  const rank: Record<FeatureChildStanding, number> = {
    inFlight: 0,
    fellShort: 1,
    queued: 2,
    delivered: 3,
    settled: 4,
    unwatched: 5,
  };
  const ordered = (rows: readonly FeatureChildRow[]): FeatureChildRow[] =>
    [...rows].sort((a, b) => rank[a.standing] - rank[b.standing] || b.number - a.number);
  const reach = (status: Record<string, [FeatureReach['status'], number, number]>): FeatureReach[] =>
    environments.map((environment) => {
      const [verdict, goals, total] = status[environment] ?? ['absent', 0, 0];
      return { environment, status: verdict, goals, total };
    });
  const summary = (
    feature: number,
    standingKey: string,
    hoursAgo: number,
    text: Pick<FeatureSummary, 'standing' | 'usable' | 'blocked' | 'remaining'>,
  ): FeatureSummary => ({
    originRef: `issue:${feature}`,
    ...text,
    standingKey,
    agentId: `agent_fs${feature}`,
    taskId: `task_fs${feature}`,
    createdAt: iso(hoursAgo + 30),
    updatedAt: iso(hoursAgo),
  });

  const rollups: Record<
    number,
    Pick<FeatureRollup, 'reach' | 'summary' | 'standingKey'> &
      Partial<Pick<FeatureRollup, 'workItemState' | 'issueType'>>
  > = {
    901: {
      reach: reach({ staging: ['partial', 2, 3], prod: ['unknown', 0, 3] }),
      summary: summary(901, 'b7d02c4e19a3', 9, {
        standing:
          'Two of three worked stories are through: the two-watcher requirement is documented and the console ' +
          'warns on one watcher, and the gap-cluster threshold has been raised so the two questions from the ticket ' +
          'cluster apart. The review-decision mapping and the context budget are unstarted, and two items have ' +
          'not been opted in.',
        usable:
          'On staging, architecture.md carries the deadlock section and the review console warns when a single ' +
          'watcher is configured.',
        blocked: null,
        remaining:
          'Map a GitHub review decision of APPROVED onto the proposal’s own approval state (#376), cut the ' +
          'retrieval context to the budget (#388), and have the threshold change assessed against what the ticket ' +
          'actually asks for.',
      }),
      standingKey: '5e88f1a3c07d',
    },
    902: {
      reach: reach({}),
      summary: summary(902, 'c93af5d1e6b2', 0.4, {
        standing:
          'Nothing under this Feature has landed. One story is being worked: the embeddings client is getting a ' +
          'bounded retry on a 502, so an incremental index run no longer aborts whole-sale on one bad response.',
        usable: null,
        blocked:
          'The retry work is parked on a question — the embeddings SDK already retries once, and the agent wants a ' +
          'call on whether to stack a second policy on top of it.',
        remaining: 'The retry itself, and the link sweep over docs/ has not been opted in.',
      }),
      standingKey: 'c93af5d1e6b2',
    },
    900: {
      reach: reach({ staging: ['reached', 2, 2], prod: ['partial', 1, 2] }),
      summary: summary(900, 'a41c9e07f2d8', 0.3, {
        standing:
          'The catalog now owns every payload schema and the runners read it rather than re-parsing; the second of ' +
          '#390’s three parts is approved and waiting on a merge, and the third is written and stacks on it. The ' +
          'watcher’s claim bug has been fixed twice at the wrong layer and is sitting out its cooldown.',
        usable:
          'On staging, a job posted through the form is validated against the catalog’s schema — the first part ' +
          'landed there this morning.',
        blocked:
          'Nothing stopped. #345 waits on the operator’s note being taken up: both attempts patched the watcher, ' +
          'and the claim is the API’s to release.',
        remaining:
          'Merge #413, get #414 green, and take #345 up at the API. One item under this Feature has never been ' +
          'read by the fleet.',
      }),
      standingKey: 'a41c9e07f2d8',
    },
    300: {
      workItemState: 'Active',
      issueType: 'Feature',
      reach: reach({}),
      summary: summary(300, 'd1e4b7a20891', 26, {
        standing:
          'The read-only workspace landed and fell short of its goal — it checks out a fresh clone per job, which ' +
          'the assessor found too slow on the larger repositories. Neither of the two stories that build on it has ' +
          'started.',
        usable:
          'A patrol run against a local checkout reads the source files rather than a pasted sample — on the ' +
          'maintainer’s machine only; nothing is deployed.',
        blocked: null,
        remaining:
          'HTTP providers still have no file tools (#332), and the patrol still corrects from a single read rather ' +
          'than verifying first (#333).',
      }),
      standingKey: '0f6c3a9e75b4',
    },
    903: { reach: reach({}), summary: null, standingKey: 'e2a7c40b9f13' },
  };

  const under = (feature: number | null) => children.filter((c) => demoFeatureOf(c.number)?.number === (feature ?? -1));
  const features = [901, 902, 900, 300, 903].map((number): FeatureRollup => {
    const feature = DEMO_FEATURES.find((f) => f.number === number);
    const extra = rollups[number];
    if (!feature || !extra)
      throw new Error(`demo feature board names Feature #${number}, which DEMO_FEATURES does not carry`);
    const rows = under(number);
    const landed = landedUnder(rows);
    return {
      number,
      title: feature.title,
      slot: demoFeatureSlotOf(feature) ?? 0,
      workItemState: extra.workItemState ?? null,
      issueType: extra.issueType ?? null,
      counts: counts(rows),
      briefing: briefing(rows),
      children: ordered(rows),
      costUsd: cost(rows),
      reach: extra.reach,
      summary: extra.summary,
      sequence: null,
      lastLandingAt: landed[0]?.at ?? null,
      landings: landed,
      standingKey: extra.standingKey,
      paused: ((since) => (since === undefined ? null : { originRef: `issue:${number}`, since }))(
        DEMO_FEATURE_PAUSES.get(number),
      ),
    };
  });

  const orphanRows = children.filter((c) => demoFeatureOf(c.number) === null);
  const orphanLandings = landedUnder(orphanRows);
  return {
    features,
    orphans: {
      counts: counts(orphanRows),
      briefing: briefing(orphanRows),
      children: ordered(orphanRows),
      costUsd: cost(orphanRows),
      lastLandingAt: orphanLandings[0]?.at ?? null,
      landings: orphanLandings,
    },
    unresolved: 0,
    environments,
    backfilling: false,
    refUrls: {},
  };
}

const DEMO_UNTRIAGED: {
  number: number;
  title: string;
  hoursAgo: number;
  issueType: string;
}[] = [
  {
    number: 412,
    title: 'Document the two-watcher requirement for maintenance jobs',
    hoursAgo: 5,
    issueType: 'Task',
  },
  {
    number: 409,
    title: 'Gap clustering merges unrelated questions into one gap',
    hoursAgo: 30,
    issueType: 'Bug',
  },
  {
    number: 402,
    title: 'Spike: replace node-pty with a portable shim',
    hoursAgo: 72,
    issueType: 'Tech Debt',
  },
  {
    number: 398,
    title: 'Sweep docs/ for links that no longer resolve',
    hoursAgo: 96,
    issueType: 'User Story',
  },
  {
    number: 371,
    title: 'Retire the legacy priority override table',
    hoursAgo: 200,
    issueType: 'Capability',
  },
];
