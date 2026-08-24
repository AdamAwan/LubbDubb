// In-browser fake backend for the GitHub Pages demo. It stands in for the whole
// server surface (`/api/*` + the `/ws` socket) so the cockpit runs, and stays
// interactive, with no Node process behind it. Every mutation the cockpit makes
// is applied to an in-memory AppState and echoed back as the same events the real
// Hub emits, so App.tsx needs zero changes to run against it.
//
// Kept side-effect-free at module scope: the real build imports this file but the
// `VITE_DEMO` branch in api.ts is statically false there, so Rollup drops it.
import type {
  ConfigChange,
  SetupCheck,
  SetupPayload,
  SetupResolvePayload,
  TicketRow,
  QueueItem,
  TicketsPayload,
  AppState,
  BuildReading,
  CockpitDecision,
  Decision,
  ContradictionRuling,
  FactExit,
  FactRuling,
  GraduationOutcome,
  FilingTargetProbe,
  Issue,
  IssueFiled,
  Job,
  LocalRunView,
  JobSchedule,
  KnowledgeFactPayload,
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
  SpendTrendBucket,
  SpendRun,
  TaskSummary,
  UnrecordedWorkView,
  WorkNodeView,
  WorldEvent,
  WorldEventKind,
} from '../types.js';
import type { WsClient } from '../api.js';
import type { ValidationAct } from '../cockpit/actions.js';
import { buildDemoState, demoPlanHistory } from './fixtures.js';
import { isContainerType } from '../issueGroups.js';
import { buildGoalPage } from '../view/goalPage.js';

/** The demo's catalogue carries no rates, so every kind names the same empty one. */
const ZERO_RATE = { dropChance: 0, pity: 0 };

type Emit = Record<string, unknown>;
interface Conn {
  onEvent: (ev: unknown) => void;
  subs: Set<string>;
}

// Plausible log lines a "running" agent emits, cycled to fake live progress.
// Markdown Magpie's own commands, so the drawer reads like the repository the
// rest of the demo world is about.
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

/** Opt-in effective state: watched only with the watch tag. */
function isWatched(labels: string[] | undefined, config: WatchConfig): boolean {
  return (labels ?? []).includes(config.watchLabel);
}

/** Set the watch tag to reflect a toggle — one label, added or taken off. */
function applyWatch(labels: string[] | undefined, config: WatchConfig, watched: boolean): string[] {
  const set = new Set(labels ?? []);
  if (watched) set.add(config.watchLabel);
  else set.delete(config.watchLabel);
  return [...set];
}

/** The dispatch action a kind of agent is sent as — the executor's two, by name. */
function dispatchAction(kind: TaskSummary['kind']): Decision['action']['type'] {
  return kind === 'desk' ? 'dispatch_desk_agent' : 'dispatch_code_agent';
}

/**
 * The three statuses `isActiveTask` calls outstanding, mirrored here because the
 * demo has no server to ask. It used to compare against `'active'`, which is not
 * a `TaskStatus` at all — so killing or completing an agent left its task row
 * saying `running` forever.
 */
/**
 * The issue an origin in the `issue:<n>` subtree belongs to — a planner, a part, an
 * assay — or null for a ref naming anything else.
 *
 * The server's `originIssueNumber`, restated rather than imported for the reason
 * `ownsPr` restates the branch convention: this is a *string shape*, not a verdict,
 * and the cockpit names `src/wire.ts` and nothing else. Anchored, because
 * `startsWith` alone reads `issue:14` as belonging to `issue:1`.
 */
function goalOriginIssue(originRef: string | null | undefined): number | null {
  const match = /^issue:(\d+)(?::|$)/.exec(originRef ?? '');
  return match ? Number(match[1]) : null;
}

function isLiveTask(task: TaskSummary): boolean {
  return task.status === 'queued' || task.status === 'running' || task.status === 'waiting';
}

/**
 * A pull request injected into the demo world, with the three verdicts the wire
 * always carries on an open one. `attention` is the injected PR's honest reading:
 * the demo dispatches an agent for it in the same breath.
 */
function injectedPr(pr: Omit<OpenPullRequest, 'attention' | 'ciVerdict'>): OpenPullRequest {
  return {
    ...pr,
    attention: { status: 'harness', reasons: ['queued for dispatch'] },
    ciVerdict: { actionable: true, dispatch: [], escalate: [], ignored: [], urgent: false },
  };
}

/** An injected issue, with the verdicts nothing has yet cast about its goal. */
function injectedIssue(
  issue: Omit<
    Issue,
    | 'assay'
    | 'conclusion'
    | 'delivery'
    | 'instructions'
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
    assay: null,
    retrospective: null,
    scratchpad: null,
    instructions: [],
    // A goal injected this second has had no agent on it, so nothing has been
    // measured — which is null, not zero. See `demoIssue`.
    spend: null,
    // And nothing has planned it, so it has no validation plan at all.
    validation: null,
  };
}

/**
 * One tool call as `renderBlocks` writes it, with its result under it — the blank
 * lines dropped, because {@link LocalRunner}'s tail drops them too.
 *
 * The line count is written only past one line, which is `renderBlocks`' own rule and
 * worth copying rather than approximating: this fixture is the only thing that
 * demonstrates the panel, so "· 1 lines" would be a demo of a bug nothing has.
 */
function toolLines(at: string, tool: string, summary: string, done: string, body: readonly string[]): string[] {
  const count = body.length > 1 ? `\x1b[2m · ${String(body.length)} lines\x1b[0m` : '';
  return [
    `\x1b[2m[${at}]\x1b[0m \x1b[36m⚙ ${tool}\x1b[0m \x1b[2m${summary}\x1b[0m`,
    `\x1b[90m  ↳ result\x1b[0m\x1b[2m [${done}]\x1b[0m${count}`,
    ...body.map((l) => `  ${l}`),
  ];
}

/**
 * A bring-up as the panel sees one: a phase, then the output of that phase.
 *
 * Scripted rather than instant, because "it takes minutes and says nothing" was the
 * complaint this answers — a demo that came up the moment it was asked to would
 * show none of it.
 *
 * **Real `renderBlocks` output, markers and stamps intact**, exactly as the drawer's
 * fixture is and for the same reason: what the runner puts in this tail is that
 * session's own transcript, so a demo of dressed-up prose would exercise none of the
 * folding the panel now draws it with. The times are literals like every other demo
 * value — nothing here reads a clock.
 */
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

/**
 * And the teardown, which is a turn of its own: the project's stop command, because
 * a dev environment is not a process tree — the containers a start brought up belong
 * to the Docker daemon and no signal the harness can send reaches them.
 */
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
  /** What the local run's session has 'printed', for the panel's tail. */
  private lines: string[] = [
    'Bringing #395 up on this machine — the compose file first, then the app.',
    ...toolLines('09:12:04', 'Bash', 'docker compose up -d', '09:12:31', [
      'Container demo-shop-postgres  Started',
      'Container demo-shop-redis     Started',
    ]),
    ...toolLines('09:12:32', 'Bash', 'npm run dev -- --host', '09:12:34', ['VITE ready in 1180 ms']),
    'Up on http://localhost:5173. Nothing needed that the instruction did not mention.',
  ];
  /** Which step of {@link BRINGUP} is next. Past the end: the fixture is already up. */
  private bringUp = BRINGUP.length;
  /** Which step of {@link TEARDOWN} is next. */
  private teardown = TEARDOWN.length;
  private deskBeats = 0;
  private seq = 1000;

  private id(prefix: string): string {
    return `${prefix}-${++this.seq}`;
  }

  // --- REST surface -------------------------------------------------------
  async getState(): Promise<AppState> {
    // Fresh clone so React sees a new reference and re-renders.
    return structuredClone(this.state);
  }

  async getTranscript(agentId: string): Promise<{ transcript: string }> {
    return { transcript: this.transcripts.get(agentId) ?? '' };
  }

  async pulse(): Promise<{ ok: true }> {
    // A heartbeat with nothing new to do — just advance the clock + audit it.
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

  /**
   * The demo's stand-in for the fold the real route does in
   * `src/escalation/questionnaire.ts`. Restated rather than imported: that module
   * carries runtime, and the cockpit reaches the harness through `src/wire.ts`
   * alone — see `test/wireContract.test.ts`. Kept to the same shape so the demo
   * transcript reads like a real one.
   */
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

  /**
   * Clear an item without answering it. Nothing is typed into the agent — that is
   * the point of the button — so the agent's own status is left exactly as it was,
   * and the stale-alert chip goes with the item.
   */
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

  /**
   * Authorize (or call off) landing a whole stack. The demo has no pulse that
   * merges anything, so this records the intent and lets the rack draw it —
   * which is the half worth demonstrating, since the effects of the real one
   * arrive over several cycles.
   */
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

  /** Toggle the watch tag on a PR — the demo mirror of the real label write-back. */
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

  /**
   * Set or clear an issue's conclusion — the demo mirror of the operator override.
   * Purely local, as on the server: concluding an issue records the harness's own
   * view and never touches the tracker.
   */
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

  /**
   * Write an instruction on a goal — the demo mirror of the operator saying what
   * they actually want, in words.
   *
   * Both halves, as on the server: the instruction the next agent would read, and
   * the `more_work` that makes there be a next agent. A demo that wrote only the
   * first would draw the operator's words and quietly park the goal, which is the
   * exact failure the pair exists to prevent.
   *
   * And the server's exception, mirrored with it: on a delivered goal the second
   * half is skipped, because there a `more_work` conclusion would clear the
   * delivery instead of scheduling anything.
   */
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

  /**
   * Overrule a standing shortfall — the demo mirror of "that assessment is wrong,
   * and here is why".
   *
   * Both rows again, and the shortfall going is the *delivery's* doing rather than
   * a line of its own: the exclusion matrix is what clears it on the server, and a
   * demo that deleted it separately would draw a control whose effects do not come
   * from where the real one's come from.
   */
  /**
   * Stop a goal waiting on an environment, or put it back — the demo's own arm of
   * the escape hatch. It rewrites the reach row rather than a table of its own,
   * because the row *is* what the card draws: a release that left `gateHold`
   * standing would draw a control that changes nothing.
   */
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

  /**
   * Take one back. The last one out clears the `more_work` it wrote — the server's
   * rule, mirrored, because a demo that left the goal bounced back to pickup for
   * withdrawn words would be teaching the wrong model of the control.
   */
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

  /**
   * Override the goal assay — the demo mirror of the escape hatch a blocking gate
   * has to have. `null` deletes the row rather than storing a third verdict, so
   * "nobody has decided" keeps one representation here too.
   */
  async setIssueAssay(issueNumber: number, verdict: 'workable' | 'unclear' | null): Promise<{ ok: true }> {
    const issue = this.state.world.issues.find((i) => i.number === issueNumber);
    if (issue) {
      issue.assay =
        verdict === null
          ? null
          : {
              verdict,
              by: 'operator',
              commentRef: null,
              // An operator's own verdict proposes no profile: the pin is its own
              // control, and a hand-set assay must not raise a question nobody asked.
              proposedProfile: null,
              awaitingProfileAnswer: false,
              summary: 'Set by the operator from the cockpit.',
              decidedAt: new Date().toISOString(),
            };
      this.addDecision(
        'no_op',
        'executed',
        `issue #${issueNumber} → ${verdict ?? 'unassayed'}`,
        undefined,
        undefined,
        undefined,
        `issue:${issueNumber}`,
      );
      this.dirty();
    }
    return { ok: true };
  }

  /**
   * End a run — the demo mirror of the one way a goal leaves the console (#203,
   * #234). Marks the run dismissed wherever it rides (a still-present issue, or a
   * forgotten-issue entry in `retainedRuns`), which is what the console filters on.
   *
   * The note the route requires while the goal's validation plan is flagged goes
   * into the decision line, which is the demo's only record of what happened —
   * dropping it would show a run ended with no account of what was said.
   *
   * The clear-out is mirrored too, and it is the half worth demonstrating: the
   * confirmation states that ending a run kills the goal's live agents, cancels
   * its queued jobs and settles its standing instructions, and a demo where the
   * agents kept running under a dismissed run would teach the opposite of what the
   * sentence says.
   */
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

  /**
   * Pin a goal to a profile, or clear the pin — the demo mirror of the label
   * write, and of the answer it doubles as.
   *
   * The tag write and the settling are one act here as they are on the route: an
   * operator who picks a profile has answered the assayer's proposal, whether
   * they took it or kept their own.
   */
  async setIssueProfile(issueNumber: number, profile: string | null): Promise<{ ok: true }> {
    const issue = this.state.world.issues.find((i) => i.number === issueNumber);
    if (issue) {
      issue.modelPin = { profile, ignoredTags: [] };
      if (issue.assay) issue.assay = { ...issue.assay, awaitingProfileAnswer: false };
      this.dirty();
    }
    return { ok: true };
  }

  /** Override one part's profile — `null` returns it to inheriting the goal's pin. */
  async setPartProfile(planId: string, slug: string, profile: string | null): Promise<{ ok: true }> {
    const part = (this.state.planParts ?? []).find((p) => p.planId === planId && p.slug === slug);
    if (part) {
      part.profile = profile;
      this.dirty();
    }
    return { ok: true };
  }

  /**
   * Toggle an issue's watch/ignore tags — the demo mirror of the real write-back
   * (opt-in), **including the container cascade**: watching a Feature tags every
   * descendant, as the route does, or the demo would show a click that the real
   * cockpit turns into eight writes doing nothing.
   */
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

  /**
   * Move a work item to one of the tracker's own states — the demo's half of the
   * board's drag.
   *
   * It moves the card for real. A demo whose drop animates and then springs back
   * would teach a visitor that the feature does not work, which is worse than not
   * demonstrating it.
   */
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

  /**
   * Mark a goal a priority, or clear it. The demo does not re-rank anything — its
   * queue is scripted — so this writes the reading the chip and the button draw and
   * stops there, which is the honest half: the ordering is the server's.
   */
  async setGoalPriority(issueNumber: number, priority: boolean): Promise<{ ok: true; priority: boolean }> {
    const issue = this.state.world.issues.find((i) => i.number === issueNumber);
    if (issue) {
      issue.priority = priority ? { since: new Date().toISOString() } : null;
      this.dirty();
    }
    return { ok: true, priority };
  }

  /**
   * Send a plan back for replanning — the demo mirror of `POST /api/plans/:id/replan`.
   * Like the real endpoint it only flips the plan's status; the part rows are left
   * alone, because what an amendment does to them is decided when a planner's new
   * declaration actually lands.
   */
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

  /**
   * One validation check's current reading — the demo mirror of the four routes
   * under `/api/issues/:number/validation/:checkId`.
   *
   * Everything the last reading left behind is cleared here too, because that is
   * the property worth mirroring: a demo that left a deferral's reason standing
   * under a "passed" chip would teach the control wrong.
   */
  async setValidation(issueNumber: number, checkId: string, act: ValidationAct): Promise<{ ok: true }> {
    const origin = `issue:${issueNumber}`;
    const check = (this.state.validationChecks ?? []).find((c) => c.originRef === origin && c.id === checkId);
    if (check && check.supersededReason === null) {
      // The hand-over writes who runs it, never a reading — mirrored separately
      // because folding it into the branch below would have the demo record a
      // state the real route does not touch.
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
      // A blank note reads as absent, matching the real route: a noteless pass
      // draws no dangling "— " beside it, exactly as a reset does.
      check.resultNote =
        act.kind === 'result' ? (act.note.length > 0 ? act.note : null) : act.kind === 'reset' ? null : act.reason;
      check.resultBy = act.kind === 'reset' ? null : 'operator';
      check.resultAt = act.kind === 'reset' ? null : new Date().toISOString();
      check.deferUntil = null;
      check.handbackNote = null;
      // The reading is in, so the run is over — the same clearing the store does,
      // and without it the demo would draw "running at …" beside a settled check.
      check.claimedBy = null;
      check.claimedAt = null;
      this.dirty();
    }
    return { ok: true };
  }

  /**
   * A reviewer ticking one acceptance criterion. Mirrors the real route's key:
   * the criterion's **text**, so a re-worded criterion loses its tick here too.
   */
  async setAcceptance(planId: string, slug: string, criterion: string, met: boolean): Promise<{ ok: true }> {
    const part = (this.state.planParts ?? []).find((p) => p.planId === planId && p.slug === slug);
    if (part) {
      part.acceptanceMet = met
        ? [...part.acceptanceMet.filter((c) => c !== criterion), criterion]
        : part.acceptanceMet.filter((c) => c !== criterion);
      part.acceptanceCriteria = part.acceptanceCriteria.map((c) => (c.text === criterion ? { text: c.text, met } : c));
      this.dirty();
    }
    return { ok: true };
  }

  /**
   * Promote a finding into a queued job — the demo mirror of
   * `POST /api/findings/:id/promote`, and the only path from a finding to work in
   * either backend: the operator's click is the gate.
   */
  /** The build fixture, unchanged — see the note on `demoApi.checkBuild`. */
  getBuild(): BuildReading {
    return this.state.build;
  }

  /**
   * Opening a shell, and the vivarium's three acts (demo mirrors of
   * POST /api/pets/:id/*).
   *
   * The wallet is recomputed here rather than left alone: the demo has no usage
   * events to derive `earned` from, so `spent` moving without the balance moving
   * would show a meter that never runs out — which is the one thing the real
   * economy is built to do.
   */
  async openPet(id: string): Promise<{ ok: true }> {
    const pet = this.state.pets?.pets.find((p) => p.id === id);
    // Stamped, never rolled — the species the demo already gave it is the one the
    // shell comes off to reveal, exactly as the harness's hash decides it there.
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
    // Same rule the server enforces: a duplicate only, and the row is marked
    // rather than dropped so its origin line survives the blend.
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

  /**
   * Write a claim down — the demo mirror of `POST /api/knowledge/facts`.
   *
   * It lands a **proposal**, as it does on the real route: the gate has no bypass,
   * and a demo that showed one would be teaching the wrong thing about the surface.
   */
  async raiseFact(claim: string, originRef: string | null): Promise<{ ok: true }> {
    const at = new Date().toISOString();
    this.state.knowledge = [
      {
        id: `fact-${this.state.knowledge.length + 1}-demo`,
        claim,
        scope: 'fleet',
        lifetime: 'standing',
        expiresAt: null,
        reach: 'proposal',
        supersedes: null,
        originRef,
        ruledAt: null,
        resolvesWhen: null,
        aboutRef: null,
        where: null,
        createdAt: at,
        updatedAt: at,
        // One voice — the operator's own. Nothing about typing it into the page
        // makes it agreed with.
        corroborations: 1,
        contradictions: 0,
        contradictionRatio: 0,
        openContradictions: 0,
        asks: 0,
        lastAskedAt: null,
        scopeStale: false,
        scopeLastMatchedAt: null,
      },
      ...this.state.knowledge,
    ];
    this.dirty();
    return { ok: true };
  }

  /**
   * Where a claim stands — the demo mirror of `POST /api/knowledge/facts/:id/reach`
   * (#27 phase 2), including the one refusal the real store makes: a rejected
   * claim does not move, because the bar is what stops a killed claim coming back.
   */
  async setFactReach(id: string, reach: FactRuling): Promise<{ ok: true }> {
    const fact = this.state.knowledge.find((f) => f.id === id);
    if (fact && fact.reach !== 'rejected') {
      fact.reach = reach;
      // Ruled, whether or not the reach moved: saying a corroborated claim belongs
      // exactly where it is *is* the decision, and it is what takes the row out of
      // the page's "Needs you" section.
      fact.ruledAt = new Date().toISOString();
      fact.updatedAt = fact.ruledAt;
      this.dirty();
    }
    return { ok: true };
  }

  /**
   * One claim's observations, in the observers' own words — the demo mirror of
   * `GET /api/knowledge/facts/:id`. Synthesised from the count rather than stored,
   * since the fixture ships the reading and not the rows behind it.
   */
  async knowledgeFact(id: string): Promise<KnowledgeFactPayload> {
    const fact = this.state.knowledge.find((f) => f.id === id);
    if (!fact) throw new Error('fact not found');
    const corroborations = Array.from({ length: Math.max(1, fact.corroborations) }, (_, i) => ({
      id: `knc-${fact.id}-${i + 1}`,
      factId: fact.id,
      agentId: null,
      taskId: null,
      goalRef: i === 0 ? fact.originRef : `issue:${340 + i}`,
      sessionId: null,
      words:
        i === 0
          ? 'What I actually saw when I wrote this down.'
          : 'I hit the same wall on a different goal, and this is what it looked like.',
      createdAt: fact.createdAt,
    }));
    // The disputes, synthesised the same way and from the same two readings the
    // row already ships: `contradictions` is how many voices spoke against the
    // claim and `openContradictions` how many of those an operator has still to
    // answer, so the first N rows are open and the rest are answered. The
    // amendment is the fixture's own — the fact naming this one in `supersedes` —
    // because an operator cannot answer a dispute without reading the sentence
    // being offered in place of the claim.
    const amendment = this.state.knowledge.find((f) => f.supersedes === fact.id) ?? null;
    const contradictions = Array.from({ length: fact.contradictions }, (_, i) => ({
      id: `knx-${fact.id}-${i + 1}`,
      factId: fact.id,
      amendmentId: amendment?.id ?? 'fact-gone',
      amendment,
      agentId: null,
      taskId: null,
      goalRef: amendment?.originRef ?? null,
      sessionId: null,
      words:
        'The claim did not hold here: the ticket named the failing check, and that was enough to plan from. ' +
        'What I saw is in the amendment.',
      resolution: i < fact.openContradictions ? null : ('dismissed' as const),
      resolvedAt: i < fact.openContradictions ? null : fact.updatedAt,
      createdAt: fact.updatedAt,
    }));
    return { fact, corroborations, contradictions };
  }

  /**
   * Answer one contradiction — the demo mirror of
   * `POST /api/knowledge/contradictions/:id/resolve` (#27 phase 5), including the
   * property that makes it one route: adopting the amendment moves **both** facts,
   * so the demo cannot show the half-landed state where the sharper claim and the
   * blunter one are both in the block.
   */
  async resolveContradiction(id: string, ruling: ContradictionRuling): Promise<{ ok: true }> {
    // The synthesised id carries the claim it disputes: `knx-<factId>-<n>`.
    const factId = id.slice('knx-'.length).replace(/-\d+$/, '');
    const fact = this.state.knowledge.find((f) => f.id === factId);
    if (!fact || fact.openContradictions === 0) return { ok: true };
    const amendment = this.state.knowledge.find((f) => f.supersedes === fact.id) ?? null;
    const at = new Date().toISOString();
    if (ruling.resolution === 'amended' && amendment) {
      // The amendment takes the claim's place exactly, and the claim is superseded
      // rather than rejected: it was not judged untrue, and a rejection would bar
      // the amendment's own words, which contain it.
      amendment.reach = fact.reach;
      amendment.ruledAt = at;
      amendment.updatedAt = at;
      fact.reach = 'superseded';
    }
    if (ruling.resolution === 'narrowed') fact.claim = ruling.claim;
    if (ruling.resolution !== 'dismissed') {
      fact.ruledAt = at;
      fact.updatedAt = at;
    }
    // Answered either way — the queue is what an operator has left to decide, and
    // dismissing is a decision.
    fact.openContradictions -= 1;
    this.dirty();
    return { ok: true };
  }

  /**
   * Send a claim on — the demo mirror of `POST /api/knowledge/facts/:id/exit`,
   * including the property that is the whole of the intermediate state: **the reach
   * does not move**. The claim goes on being delivered while the work is in flight,
   * and reaches `graduated` only when the exit is actually taken.
   */
  async exitFact(id: string, exit: FactExit): Promise<{ ok: true }> {
    const fact = this.state.knowledge.find((f) => f.id === id);
    if (!fact || this.state.knowledgeGraduations.some((g) => g.factId === id && g.outcome === null)) {
      return { ok: true };
    }
    const at = new Date().toISOString();
    const headline = fact.claim.split('\n')[0]!;
    // What each exit queues, mirrored so the demo's Up next shows what the control
    // the operator just clicked actually asks for.
    const title = (
      exit.exit === 'docs'
        ? `Document: ${headline}`
        : exit.exit === 'ticket'
          ? `File ticket: ${headline}`
          : `${fact.aboutRef ? `${fact.aboutRef} ` : ''}${headline}`
    ).slice(0, 80);
    await this.launchJob({ prompt: fact.claim, title });
    this.state.knowledgeGraduations = [
      {
        id: `kng-${id}`,
        factId: id,
        exit: exit.exit,
        jobId: this.state.jobs[0]?.id ?? `job-${exit.exit}-${id}`,
        target: exit.exit === 'docs' ? exit.target : null,
        bar: exit.exit === 'docs' && exit.target === 'claudeMd' ? exit.bar : null,
        prRef: null,
        ticketRef: null,
        outcome: null,
        settledAt: null,
        createdAt: at,
        reading: 'waiting',
      },
      ...this.state.knowledgeGraduations,
    ];
    this.dirty();
    return { ok: true };
  }

  /**
   * Say what became of a graduation the harness will not read for itself — the
   * demo mirror of `POST /api/knowledge/graduations/:id/settle`. `landed` is the
   * one place `graduated` is an operator's own word, and it moves the claim out of
   * every prompt; `abandoned` moves nothing at all.
   */
  async settleGraduation(id: string, outcome: GraduationOutcome): Promise<{ ok: true }> {
    const graduation = this.state.knowledgeGraduations.find((g) => g.id === id);
    if (!graduation || graduation.outcome !== null) return { ok: true };
    graduation.outcome = outcome;
    graduation.reading = outcome;
    graduation.settledAt = new Date().toISOString();
    if (outcome === 'landed') {
      const fact = this.state.knowledge.find((f) => f.id === graduation.factId);
      if (fact) {
        fact.reach = 'graduated';
        fact.ruledAt = graduation.settledAt;
        fact.updatedAt = graduation.settledAt;
      }
    }
    this.dirty();
    return { ok: true };
  }

  /**
   * Settle a human task (demo mirror of POST /api/human-tasks/:id/done). The note
   * is what the route requires on a close-out whose goal's validation is flagged,
   * and it is kept for the same reason the route keeps it: the settled row is the
   * only account of what was decided about the checks nobody ran.
   */
  async completeHumanTask(id: string, note?: string): Promise<{ ok: true }> {
    return this.settleHumanTask(id, 'done', note ?? null);
  }

  /** Decline one, with the note the route requires (POST /api/human-tasks/:id/decline). */
  async declineHumanTask(id: string, note: string): Promise<{ ok: true }> {
    return this.settleHumanTask(id, 'declined', note);
  }

  /** Clear a settled one off the bench (POST /api/human-tasks/:id/dismiss). */
  async dismissHumanTask(id: string): Promise<{ ok: true }> {
    const task = (this.state.humanTasks ?? []).find((t) => t.id === id);
    // Settled only, and once — the route's own guard, so the demo cannot show a
    // button the real cockpit refuses.
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

  /**
   * Accept a proposed act — the demo mirror of `POST /api/proposals/:id/accept`,
   * and the one thing the demo has to show faithfully: the accept *performs the
   * act*. So a merge marks the PR merged and a reply marks its comment handled,
   * exactly as the real sink would, rather than only flipping a status.
   */
  async acceptProposal(id: string, note?: string): Promise<{ ok: boolean; detail: string }> {
    const proposal = (this.state.proposals ?? []).find((p) => p.id === id);
    if (!proposal || proposal.status !== 'pending') return { ok: false, detail: 'already decided' };
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

  /** Reject it: nothing goes out, and the reason is recorded (demo mirror of /reject). */
  async rejectProposal(id: string, note?: string): Promise<{ ok: boolean; detail: string }> {
    const proposal = (this.state.proposals ?? []).find((p) => p.id === id);
    if (!proposal || proposal.status !== 'pending') return { ok: false, detail: 'already decided' };
    this.settle(proposal, 'rejected', note);
    const detail = `Rejected by you${proposal.note ? `: ${proposal.note}` : ''} — nothing was sent (${proposal.id}).`;
    this.addDecision(proposal.action.type, 'skipped', detail);
    this.dirty();
    return { ok: true, detail };
  }

  /** The verdict itself: one-way, and it answers the inbox item it hangs off. */
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

  /**
   * Start the local run on another goal, which is also the swap: one environment, so
   * the old row ends as the new one begins — the same transaction the real store
   * does in one write.
   */
  startLocalRun(issue: number, ref?: string): Promise<{ ok: true; run: LocalRunView }> {
    const now = new Date().toISOString();
    // Where this goal runs, and what has happened there — read off the same rows the
    // panel drew, so the header after a start says what the row said before it.
    const target = this.state.localRunTargets.find((t) => t.issueNumber === issue) ?? null;
    const chosen = ref === undefined ? null : (target?.options.find((o) => o.option.ref === ref) ?? null);
    const facts = chosen?.facts ?? target?.target ?? null;
    const starting: LocalRunView = {
      id: `run-${String(this.state.localRun === null ? 2 : Number(this.state.localRun.id.split('-')[1] ?? 1) + 1)}`,
      originRef: `issue:${String(issue)}`,
      ref: ref ?? facts?.ref ?? 'main',
      dir: '/Users/you/code/demo-shop/.lubbdubb/local-run',
      pid: 48000 + issue,
      // `starting`, not `running`, because that is the state an operator spends the
      // minutes in and the one the panel had nothing to say about. The scripted
      // bring-up below walks out of it.
      status: 'starting',
      // Nothing reported yet: the figure appears with the session's first turn end,
      // which is what an unmeasured run looks like on the real thing too.
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
      live: true,
      phase: null,
      refFacts: facts,
    };
    this.state.localRun = starting;
    this.lines = [`Bringing #${String(issue)} up on this machine — the compose file first, then the app.`];
    this.bringUp = 0;
    // The first phase now rather than on the next poll, so the panel never draws a
    // start with nothing under it.
    this.advanceBringUp();
    return Promise.resolve({ ok: true as const, run: this.state.localRun ?? starting });
  }

  /**
   * One step of the scripted bring-up: the phase, then that phase's output.
   *
   * Driven by {@link localRunOutput} rather than a timer, because the panel polls
   * that while a run is live — which is the cadence the real runner's own output
   * arrives at anyway, and a timer here would be one more thing to start, stop and
   * clean up for the same effect.
   */
  private advanceBringUp(): void {
    const run = this.state.localRun;
    if (run === null || run.status !== 'starting') return;
    const step = BRINGUP[this.bringUp];
    if (step === undefined) {
      // The turn ending is the environment being up — the real runner's rule, and
      // the reason `running` here carries no phase: nothing is in flight.
      this.state.localRun = { ...run, status: 'running', phase: null, note: 'Up on http://localhost:5173.' };
      this.dirty();
      return;
    }
    this.bringUp += 1;
    this.lines = [...this.lines, `phase: ${step.phase}`, ...step.lines];
    // The money climbs with the work, because that is what the panel is showing: a
    // reading that only appeared at the end would demonstrate the opposite of it.
    this.state.localRun = { ...run, phase: step.phase, ...localRunSpent(run, 0.06) };
    this.dirty();
  }

  /**
   * Start the teardown. Not finish it — stopping is a session's turn, because a dev
   * environment is not a process tree and no signal reaches a container, so
   * `stopping` is a live state the panel sits in for a while.
   */
  stopLocalRun(): Promise<{ ok: true }> {
    if (this.state.localRun !== null) {
      this.state.localRun = { ...this.state.localRun, status: 'stopping', phase: null };
      this.lines = [...this.lines, 'phase: stopping the containers'];
      this.teardown = 0;
      this.dirty();
    }
    return Promise.resolve({ ok: true as const });
  }

  /** The teardown, one step per look, exactly as {@link advanceBringUp} runs. */
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
        endedAt: new Date().toISOString(),
        note: 'stopped from the cockpit — 6 containers stopped, :5173 is free',
      };
      this.dirty();
      return;
    }
    this.teardown += 1;
    this.lines = [...this.lines, `phase: ${step.phase}`, ...step.lines];
    // A teardown is a turn too, and it is billed to the run it takes down — which is
    // the whole reason the row accumulates rather than being written once.
    this.state.localRun = { ...run, phase: step.phase, ...localRunSpent(run, 0.03) };
    this.dirty();
  }

  localRunOutput(): string[] {
    this.advanceBringUp();
    this.advanceTeardown();
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
      // Any open escalation from this agent is moot now.
      for (const e of this.state.escalations) if (e.agentId === id && e.status === 'open') e.status = 'dismissed';
      this.addDecision('no_op', 'executed', `killed ${id}`);
      this.dirty();
    }
    return { ok: true };
  }

  /**
   * The operator declaring the work finished — the clean terminal, where
   * {@link killAgent} records an abandonment. The task follows the agent to `done`
   * rather than `interrupted`, and the open question goes with it.
   */
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

  /**
   * Buy fifteen more minutes before a stall park settles itself. The demo world
   * holds no stall parks, so this is the refusal arm made visible rather than a
   * second copy of the clock: the real route 409s an agent with no countdown, and a
   * demo that silently succeeded would teach the panel a shape the server never
   * sends.
   */
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

  /**
   * End a usage-limit park (issue #318): the agent leaves `parkedOnLimit` and goes
   * back to work, which is what the real route does once it has re-opened the
   * session. No escalation is touched — a limit park never raised one.
   */
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

  // --- WS surface ---------------------------------------------------------
  connect(onEvent: (ev: unknown) => void, onStatus?: (connected: boolean) => void): WsClient {
    const conn: Conn = { onEvent, subs: new Set() };
    this.conns.add(conn);
    // Report "live" on the next tick, mirroring a real socket's async open.
    setTimeout(() => onStatus?.(true), 0);
    this.startTimers();
    return {
      subscribe: (agentId: string) => {
        conn.subs.add(agentId);
        // Prime the drawer with a fresh tail so it feels immediately connected.
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

  // --- internals ----------------------------------------------------------
  private emit(ev: Emit): void {
    for (const c of this.conns) c.onEvent(ev);
  }

  private dirty(): void {
    this.state.world.takenAt = new Date().toISOString();
    // The real snapshot's world is whatever the last pulse observed, so the demo
    // moves its observation stamp with the world it is pretending to re-read.
    this.state.worldObservedAt = this.state.world.takenAt;
    this.emit({ type: 'dirty' });
  }

  // Append to an agent's transcript and stream it: a delta to subscribers (the
  // open drawer) and a compact tail to everyone (the fleet-card preview).
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

  /**
   * `rule` names what proposed the act, `admission` what became of it — the same
   * two columns the server records, so the demo's log renders like a real one.
   */
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
      // The demo composes actions as `{type, reason}` alone, so there is no
      // payload for the server's `decisionSubjectRef` to read even in principle:
      // the caller names the subject, or the row has none and draws a dash.
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

  // Spawn an agent for a piece of work — honouring pause + the concurrency cap,
  // so the FleetControl and pause button visibly matter in the demo.
  private trySpawn(
    kind: TaskSummary['kind'],
    title: string,
    branch: string | null,
    originRef: string | null,
  ): string | null {
    // A PR without the watch label is left alone — mirrors the server harness
    // filtering unwatched PRs out of the dispatch view, so the watch toggle visibly
    // matters in the demo.
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
        // A fresh agent has said nothing yet — the card falls back to its output
        // tail, which is exactly the state note_progress must not paper over.
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

  /**
   * Queue an operator-launched job, then try to dispatch it immediately —
   * mirroring the real server: it spawns an agent when there's headroom, else
   * the job waits in the queue (and the FleetControl/pause state visibly gates it).
   */
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

  /**
   * The four schedule routes, mirrored (POST /api/schedules and friends).
   *
   * The demo has no clock driving the pulse, so **nothing here ever fires on its
   * own** — writing a recurrence, editing it and deleting it are real, and "run
   * now" queues the job exactly as the launch composer does. That is the honest
   * demo of the feature rather than a fake one: what a schedule *does* is queue a
   * job, and the queue is right there.
   *
   * `next_run_at` is not computed either, for the reason the prompt book ships
   * empty: the cron parser is server code and the web bundle imports none, so a
   * second implementation here would be a copy free to disagree with the one that
   * actually schedules anything.
   */
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

  /** Fire one by hand — the same queue-and-try-to-dispatch the launch composer does. */
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

  /** Drop a still-queued job (demo mirror of POST /api/jobs/:id/cancel). */
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

  /** Re-order the Up next queue (demo mirror of POST /api/upnext/order). */
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

  /**
   * Price one queued row (demo mirror of POST /api/upnext/profile). The real
   * dispatcher re-resolves the whole pin chain on the next pulse; here the row
   * carries the answer, so the override and the profile it resolves to are set
   * together — which is the same two facts, and the demo has no rule table to
   * fall back through when the override is cleared.
   */
  async setUpNextProfile(origin: string, profile: string | null): Promise<{ ok: true }> {
    const item = this.state.upcoming?.items.find((i) => i.origin === origin);
    if (item) {
      if (profile === null) {
        // Both halves go back, not just the name: a row restored to its rule's
        // own profile while still reading `pin` would draw "Pinned (standard)"
        // over a row nothing pins — the price would be right and the sentence
        // beside it wrong.
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

  /**
   * What each overridden row resolved to before the operator priced it, so
   * clearing the override puts the row back rather than blanking it. The real
   * harness needs no such memory — it re-derives the answer from the world every
   * pulse.
   */
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
            // No proposing rule: a branch note folds every fresh signal on the
            // PR, so it is an admission with nothing single behind it.
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
        // Opt-in: only a watched issue is worked. An untagged injected issue shows
        // up unwatched with a "watch" toggle, mirroring the real dispatcher gate.
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
        // Unknown/raw injection — record it so the feed shows *something* happened.
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
        // A pulse is what observes the world, so the stamp moves with the beat.
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

  /**
   * The desktop claim ending by itself — the whole point of drawing it as an
   * in-flight entry rather than a control.
   *
   * Of the three endings a claim has, this is the one a demo can show: the
   * reading lands, so the run is over. The other two need a terminal to be
   * closed and an hour of wall clock to pass. Nobody presses anything: two beats
   * in, the check carries a `desktop` reading, the claim clears, and the entry
   * leaves the fleet list on its own.
   */
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
    // No world event and no decision: the world did not move and the harness did
    // not act. That is the fact this whole entry exists to draw.
    this.dirty();
  }

  // Stream a line of progress into every running agent so the fleet looks alive.
  private tickChatter(): void {
    const running = this.state.agents.filter((a) => a.status === 'running');
    if (running.length === 0) return;
    const line = CHATTER[this.chatterIdx % CHATTER.length];
    this.chatterIdx++;
    for (const a of running) this.append(a.id, `\n${line}`);
  }
}

// Lazily constructed so the module has no side effects until the demo build runs.
let server: DemoServer | null = null;
function getServer(): DemoServer {
  if (!server) server = new DemoServer();
  return server;
}

/**
 * The demo's retrospective: written after the goal was delivered, and deliberately
 * about the *process* rather than the diff — that is what the station is for.
 */
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

/**
 * The demo's scratchpad: the trail the retrospective above was written from, and
 * deliberately the *same story from the inside* — the second agent rediscovering
 * what the first had already established is what the write-up calls out, and it
 * is only visible here because the pad kept both entries.
 */
const DEMO_SCRATCHPAD = [
  {
    id: 'scr_demo1',
    padRef: 'issue:364',
    authorOriginRef: 'issue:364',
    agentId: 'agent-4',
    taskId: 'task-4',
    topic: 'deadlock',
    note: 'The starvation is not "the queue is busy": a maintenance orchestrator holds its watcher while it blocks in the API callback, and the follow-up AI jobs it enqueued can only be claimed by a *second* watcher. With one watcher it waits for itself. The docs have to say that, not "run more watchers if it feels slow".',
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
    createdAt: new Date(Date.now() - 4_200_000).toISOString(),
  },
];

/**
 * The demo's spend breakdown.
 *
 * Authored rather than derived, for the reason every fixture in this file is: the
 * real figure comes from `buildSpendInsights` walking the store, and the web
 * bundle imports no server code. What is *not* authored is any of the arithmetic —
 * the phase totals, the fleet totals and the run count are all summed from the
 * seeds below, because a hand-typed set of totals that disagrees with its own
 * rows is a demo of a bug.
 *
 * The two goals the world fixture already prices — 364 at $6.14 over 4 runs and
 * 390 at $18.42 over 7 — carry those exact figures here. A panel contradicting the
 * card three inches behind it is the one thing this screen must not do.
 */
const DEMO_GOAL_SEEDS: {
  issueNumber: number;
  title: string | null;
  agents: number;
  /** Local runs of this goal — the operator's own previews, priced in `byPhase.local`. */
  localRuns: number;
  hoursAgo: number;
  byPhase: Partial<Record<SpendPhase, number>>;
}[] = [
  {
    issueNumber: 390,
    title: 'Validate job payloads in the catalog, not in each runner',
    agents: 7,
    // The goal that has been looked at locally, twice — the row that shows a total
    // holding money no agent spent.
    localRuns: 2,
    hoursAgo: 2,
    byPhase: { deliberation: 3.4, build: 9.8, ci: 2.6, landing: 1.3, evidence: 1.32, local: 0.74 },
  },
  {
    issueNumber: 364,
    title: 'Document the two-watcher requirement for maintenance jobs',
    agents: 4,
    localRuns: 0,
    hoursAgo: 1,
    byPhase: { deliberation: 1.6, build: 3.24, ci: 0.3, landing: 0.2, evidence: 0.8 },
  },
  {
    issueNumber: 382,
    title: 'Gap clustering merges unrelated questions into one gap',
    agents: 3,
    localRuns: 1,
    hoursAgo: 26,
    // The goal whose CI dwarfs its build — the shape the split exists to surface,
    // on screen in the demo rather than only in the argument for it. Sums to the
    // $4.20 the goal's own card states.
    byPhase: { deliberation: 0.3, build: 1.1, ci: 2.6, landing: 0.1, evidence: 0.1, local: 0.18 },
  },
  {
    // A goal the world snapshot no longer carries — closed and aged out of the
    // open list — so the panel has one row that can only draw its number.
    issueNumber: 331,
    title: null,
    agents: 2,
    localRuns: 0,
    hoursAgo: 74,
    byPhase: { deliberation: 0.3, build: 0.62, evidence: 0.5 },
  },
];

/** Spend that reached no goal: an operator's job, and one agent dispatched against nothing. */
const DEMO_LOOSE: { phase: SpendPhase; costUsd: number }[] = [
  { phase: 'job', costUsd: 0.96 },
  { phase: 'other', costUsd: 0.7 },
];

/**
 * A local run's usage after one more turn — the accumulation the real store does,
 * so the demo shows the figure climbing rather than appearing.
 */
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

/** The demo world's token ratio, shared with `demoSpend` in the fixtures. */
const demoTokens = (costUsd: number) => ({
  inputTokens: Math.round(costUsd * 180_000),
  outputTokens: Math.round(costUsd * 9_000),
});

/** The cached share of {@link demoTokens}'s input: a fleet reading ~78% from cache. */
const demoCache = (costUsd: number) => ({
  cacheReadTokens: Math.round(costUsd * 140_000),
  cacheCreationTokens: Math.round(costUsd * 11_000),
  cacheMeasuredInputTokens: Math.round(costUsd * 180_000),
});

const PHASE_COPY: Record<SpendPhase, { label: string; blurb: string }> = {
  deliberation: { label: 'Deliberation', blurb: 'Planning and assaying — deciding what the work is' },
  build: { label: 'Build', blurb: 'The pickup and every part — where a branch is cut and a PR is written' },
  ci: { label: 'CI', blurb: 'Answering a pull request’s failing or blocked checks — what a red pipeline costs' },
  landing: { label: 'Landing', blurb: 'The rest of getting a pull request in — review comments, retargets, the merge' },
  evidence: { label: 'Evidence', blurb: 'Assessing what shipped, and writing the run up' },
  local: { label: 'Local runs', blurb: 'Bringing a goal’s branch up on this machine to look at it' },
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
    // A local run in the ranking, because the ranking is of what money went on and
    // an operator's preview is money. It carries the branch rather than a task title
    // — nothing asked it to do anything, so there is nothing else to name it by.
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

/**
 * Cost by kind of work. The rules are real `DISPATCH_RULES` ids and the labels
 * are their real names — the demo must not invent a vocabulary the running
 * harness does not use.
 */
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

/** The registry's own ids and names — the demo must not invent a vocabulary the harness does not use. */
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

/**
 * What each failing check costs. The Postgres-backed suite is the shape the table
 * exists to expose: fewer runs than the unit tests, but nearly twice as expensive
 * each time — the reading only the per-dispatch column gives.
 */
const DEMO_CHECKS: { name: string; costUsd: number; runs: number; soleRuns: number; hoursAgo: number }[] = [
  { name: 'test (unit)', costUsd: 1.94, runs: 5, soleRuns: 3, hoursAgo: 4 },
  { name: 'test:db (postgres)', costUsd: 1.18, runs: 2, soleRuns: 2, hoursAgo: 9 },
  { name: 'build (ubuntu-latest)', costUsd: 0.46, runs: 3, soleRuns: 0, hoursAgo: 26 },
  { name: 'lint', costUsd: 0.24, runs: 2, soleRuns: 1, hoursAgo: 31 },
];

/** The trend: a fortnight of daily totals, busiest at the near end. */
const DEMO_DAYS = [0.4, 0, 1.1, 2.3, 1.8, 0, 0.9, 3.4, 2.2, 1.6, 0.7, 2.9, 4.1, 5.3];

/**
 * The reliability breakdown, authored to the same totals the snapshot's Yield
 * gauge reads (`fixtures.ts`).
 *
 * The two agreeing is not decoration: the whole claim the real panel makes is
 * that the gauge and the reading behind it come from one fold, and a demo where
 * clicking through changes the number would teach an operator the opposite. So
 * the phase rows below sum to 24 settled, 20 finished, and they are checked in
 * `test/demoReliability.test.ts` rather than trusted.
 */
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

/** How each ending divides the 24, and what it cost. Sums to the phase rows above. */
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

/** A fortnight of CI verdicts, red and green, busiest at the near end. */
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

/**
 * The pull requests CI kept sending back. One is still red, which is the state
 * worth drawing — and #151 cost nothing, which is the other one: a red a human
 * fixed draws an em dash rather than `$0.00`, and the demo has to show that cell
 * or nobody sees the branch. The costs sum to `ciCostUsd` below.
 */
const DEMO_FLAKY: CiSubject[] = [
  { ref: 'pr:414', prNumber: 414, reds: 6, greens: 5, redMs: 4.2 * 3_600_000, stillRed: true, costUsd: 1.9 },
  { ref: 'pr:413', prNumber: 413, reds: 4, greens: 4, redMs: 1.6 * 3_600_000, stillRed: false, costUsd: 1.1 },
  { ref: 'pr:410', prNumber: 410, reds: 3, greens: 3, redMs: 52 * 60_000, stillRed: false, costUsd: 0.6 },
  { ref: 'pr:412', prNumber: 412, reds: 3, greens: 2, redMs: 2.1 * 3_600_000, stillRed: true, costUsd: 0.7 },
  { ref: 'pr:405', prNumber: 405, reds: 1, greens: 1, redMs: 14 * 60_000, stillRed: false, costUsd: 0 },
];

/** Origins the harness went round more than once — the reading no card shows. */
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

/**
 * The Causes reading, authored against the same fixture as the reliability one
 * beside it and for the same reason: the demo's world is built fresh in the
 * browser each load, so no agent has ever filed an account.
 *
 * The shape it is authored *into* is the point. A demo where every account was
 * `undocumented` would teach an operator that the guard axis is decoration, and
 * one where everything was a flake would teach them the panel cannot see their
 * own mistakes. So the split below is the uncomfortable one — the largest single
 * share is work the repository's own gate would have caught — because that is
 * what the panel is for.
 */
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
    // Non-zero on purpose: a demo claiming every dispatch filed one would hide the
    // panel's own honesty figure, which is the line an operator most needs to read.
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

/**
 * The MCP tab's fixture, authored for `buildDemoSpend`'s reason and one of its own.
 *
 * The demo's world is built fresh in the browser on every load, so there is no
 * `mcp_calls` table behind it and never will be — folded, this tab would draw a
 * page of zeroes. That is worse here than anywhere else on the page: a page of
 * zeroes is *precisely* what this tab looks like when a real deployment's grants
 * have been dropped, so a demo showing one would teach a reader to recognise a
 * working channel as a broken one.
 *
 * The figures are authored to show the tab doing its job rather than to flatter
 * it: three runs that called nothing, a retired name something is still calling,
 * a tool nothing named, and a tool whose every call is refused. Those are the
 * four verdicts, and a demo that showed only healthy traffic would not explain
 * what the tab is for.
 */
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
    tool('assay_issue', 'point-of-use', 27, 0, 24, 205, 6),
    tool('retro_submit', 'point-of-use', 19, 0, 18, 300, 5),
    tool('escalate', 'addendum', 14, 1, 15, 470, 0),
    // Called and refused every time — a schema nobody can satisfy, which is the
    // one verdict where the silence is the tool's own fault.
    tool('report_remedy', 'point-of-use', 11, 11, 12, 540, 4),

    // Retired, and something is still reaching for it: a prompt override that has
    // not caught up. Every call is a refusal naming `raise`.
    tool('report_finding', 'retired', 6, 6, 2, 96, 1),
    // Advertised on every dispatch and called by nobody.
    tool('request_human_task', 'addendum', 0, 0, 0, 27_360, 0),
    // The verdict that matters most: nothing named it at all.
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
    // The flag the demo exists to show off: three runs went dark, and this is why.
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
      live: 3,
      completionRate: tally.completed / tally.settled,
      costUsd: round(DEMO_OUTCOMES.reduce((a, o) => a + o.costUsd, 0)),
      lostCostUsd: round(DEMO_PHASE_HEALTH.reduce((a, p) => a + p.lostCostUsd, 0)),
      // Two PTY runs, so the panel's "counted in every rate and in no dollar"
      // caveat is on screen rather than being a branch nobody sees.
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

/**
 * The window a demo payload says it was taken over.
 *
 * The demo's figures are authored, not folded, so this describes them rather
 * than producing them — but it has to be *there*, because the page draws its
 * caption and its bucket labels off the payload rather than off the key it asked
 * with, and a demo missing it renders "reading…" forever.
 */
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

  // Every phase's money and every phase's run count, summed from the rows above
  // rather than typed out beside them.
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
      // A warm fleet: most of the input is cache reads, a slice of it writes.
      // The demo's whole input carries a breakdown, so the panel's "share is
      // over the runs that reported one" caveat stays off screen here — the
      // unmeasured-runs caveat below is the one this fixture is making.
      ...demoCache(costUsd),
      turns: 268,
      measuredRuns,
      // Two PTY runs, so the panel's "unmeasured, not free" caveat is on screen
      // where it belongs rather than being a branch nobody sees.
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
      // A provider reporting no per-check detail, so the panel's footnote about
      // CI money in none of the rows is on screen rather than a dead branch.
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

/**
 * Eight weeks of closed goals, authored — `buildDemoSpend`'s reason exactly.
 *
 * The seed carries the shape the tab exists to show, because a demo that only
 * demonstrates the chrome demonstrates nothing: goals get steadily cheaper,
 * **deliberation's dollars rise while its share rises faster**, CI's fall by more
 * than deliberation gains, and completion holds. That is the one reading the tab
 * is built around — planning more in order to review less — and it is on screen
 * here rather than only in the argument for it.
 *
 * The last week is partial, so the hollow bar and the "still filling" caveat are
 * drawn rather than being branches nobody sees.
 */
const DEMO_TREND_WEEKS: {
  /** Every goal that closed that week, as its total cost. */
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
  // The prompt change lands here: deliberation goes up in dollars, everything
  // downstream of it goes down by more.
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
  // Still filling — two goals in, where a whole week runs to four or five.
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
    job: 0,
    other: 0,
  });
  const median = (xs: number[]): number | null => {
    if (xs.length === 0) return null;
    const sorted = [...xs].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? null;
  };
  // Tokens track cost at the same rate the breakdown's fixture uses, so the two
  // tabs cannot state a goal's size two different ways.
  const tokensOf = (costUsd: number) => Math.round(costUsd * 620_000);

  const start = now - DEMO_TREND_WEEKS.length * week;
  const buckets: SpendTrendBucket[] = DEMO_TREND_WEEKS.map((seed, i) => {
    const costs = [...seed.costs].sort((a, b) => a - b);
    return {
      startsAt: new Date(start + i * week).toISOString(),
      partial: i === DEMO_TREND_WEEKS.length - 1,
      goalsClosed: costs.length,
      // One goal a fortnight closes with nothing recorded, so the caveat about
      // unmeasured goals is on screen rather than a dead branch.
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

  /** The same fold `buildSpendTrend` does, over the complete weeks of one half. */
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

/**
 * The demo's answer for one goal's record.
 *
 * `getWorkRoots` above still returns an empty graph and this does not, because the
 * two are asked different questions. The tab lists roots **nothing has claimed**,
 * and a world rebuilt in the browser each load has none — empty is the honest
 * answer there. The goal page asks what happened **under a goal that is on
 * screen**, and answering "nothing is recorded" for a goal the demo is visibly
 * working would misrepresent the surface rather than under-claim it. That is the
 * ticket mirror's argument below, in the one other place a fetched-on-open panel
 * would otherwise show a reader an empty box and call it a feature.
 *
 * **Derived, never authored**, through the same `buildGoalPage` the page itself
 * uses — so the record cannot contradict the cards above it: the plan, its parts
 * and the pull requests are the very ones already drawn. What it cannot show is
 * the thing the record exists for, a merge the world has since forgotten, since
 * this world has never forgotten anything.
 */
async function demoWorkSubtree(ref: string): Promise<{ nodes: WorkNodeView[]; refUrls: Record<string, string> }> {
  const state = await getServer().getState();
  const page = buildGoalPage(state, ref, []);
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
  // `parts` are the page's view rows and `retiredParts` the plan rows themselves —
  // unwrapped to one shape here so a retired part is on the record like any other.
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

// ---- Setup, scripted -------------------------------------------------------
//
// The demo's repository is the one its whole world is built on:
// `example/markdown-magpie`, cloned over SSH, with a project file its "team"
// committed. The two checks that are *not* green are the two the real reading
// most often finds outstanding on a first run, and they are the reason the
// surface exists — a fleet that is idle and correct, and a stray key that moves
// every agent onto API billing.

const DEMO_REPO_ROOT = '/Users/you/code/markdown-magpie';
const DEMO_ORIGIN = 'git@github.com:example/markdown-magpie.git';

/** Whether the demo's setup flow has been run this session. Flips the reading. */
let demoSetupWritten = false;

/** The demo's `lubbdubb.config.json`, as bytes. Replaced by a save. */
let demoConfigText = '{}\n';

/** The file a given set of edits would produce — the demo's stand-in for the server's splice. */
function demoConfigTextFor(set: Record<string, unknown>): string {
  const lines = Object.entries(set).map(([path, value]) => `  ${JSON.stringify(path)}: ${JSON.stringify(value)}`);
  return `{\n  "//": "Written by Setup. Every key is OPTIONAL; the project file underneath this one wins nothing — this file wins key by key.",\n\n${lines.join(',\n')}\n}\n`;
}

/** Every edited key, reported as landed-but-waiting. See the note on `saveConfig`. */
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
      // The demo's harness and the repository it works on are two directories, as
      // they are in every deployment that is not dogfooding.
      repoRootIsSelf: false,
    },
    checks,
  };
}

function demoSetupResolution(answers: { email: string; repoRoot: string }): SetupResolvePayload {
  // The scripted repository answers only to its own path — so pointing the demo
  // somewhere else shows the *other* half of the design: a directory that could
  // not be read, said out loud rather than papered over with the fake provider.
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
      // Written, unlike `labelPrefix` and the rest below, because the project
      // file does not select a provider — only the remote does. Leaf paths, as
      // the real resolver emits them: `POST /api/config` validates every key
      // against a registry of leaves, so a nested object here would be refused.
      'integrations.sourceControl': 'github',
      'integrations.issues': 'github',
      'github.owner': 'example',
      'github.repo': 'markdown-magpie',
    },
  };
}

export const demoApi = {
  getState: () => getServer().getState(),
  getTranscript: (agentId: string) => getServer().getTranscript(agentId),
  // The demo's world is built fresh in the browser each load, so nothing has ever
  // been recorded for it — an empty graph is the honest answer, and these exist to
  // keep the two API shapes interchangeable.
  getWorkRoots: () =>
    Promise.resolve({ roots: [] as WorkNodeView[], unrecorded: [] as UnrecordedWorkView[], refUrls: {} }),
  getWorkSubtree: (ref: string) => demoWorkSubtree(ref),
  // The ticket mirror, authored for `getSpend`'s reason: the demo's world is built
  // fresh in the browser each load, so there is no swept history to page through
  // and a fixture is the only way the tab shows what it is for. The filtering,
  // ordering and paging are performed here rather than faked, so what a reader
  // clicks behaves exactly as it will against a real mirror.
  getTickets: (query: {
    watch: string;
    tracking: string;
    state: string;
    feature: string | null;
    order: string;
    cursor: string | null;
  }) => Promise.resolve(demoTickets(query)),
  // The demo's one written-up goal, so the Manifest station has something to open.
  // Everything else answers null, which is the same thing the real route says for a
  // goal nobody wrote up — silence, not an error.
  getRetrospective: (ref: string) =>
    Promise.resolve({ retrospective: ref === 'issue:364' ? DEMO_RETROSPECTIVE : null }),
  // The pad behind that write-up. Every other goal answers an empty trail, which
  // is what the real route says for a pad nobody has written to — and no way in
  // is drawn for one, since the snapshot's reading is what the control keys on.
  getScratchpad: (ref: string) => Promise.resolve({ padRef: ref, entries: ref === 'issue:364' ? DEMO_SCRATCHPAD : [] }),
  // The spend breakdown, authored above. The real route derives it from every
  // agent the store holds; the demo's world is built fresh in the browser each
  // load, so a fixture is the only honest way to show the panel at all.
  // The window is accepted and ignored: the demo's figures are authored rather
  // than folded, so there is nothing to re-cut — and a demo that answered `6h`
  // with an empty page would teach the reader the feature is broken.
  getSpend: () => Promise.resolve({ insights: buildDemoSpend() }),
  // The trend behind it, authored for the same reason and against the same
  // fixture: the demo's store holds no closed goals to cohort, so a fixture is
  // the only way the tab shows what it is for.
  getSpendTrend: () => Promise.resolve({ trend: buildDemoTrend() }),
  // The reliability breakdown, authored for the spend panel's reason exactly: the
  // demo's world is built fresh in the browser each load, so there are no settled
  // agents and no CI history to fold.
  getReliability: () => Promise.resolve({ insights: buildDemoReliability(), remedies: buildDemoRemedies() }),
  // The tool channel, authored for the same reason and one sharper: a page of
  // zeroes is what this tab looks like when a deployment's grants have been
  // dropped, so a demo folding the browser's empty store would teach a reader to
  // read a working channel as a broken one.
  getMcpUsage: () => Promise.resolve({ insights: buildDemoMcp() }),
  // The prompt book lives in the server's template registry, and the web bundle
  // deliberately imports no server code. Shipping a copy of eighteen prompts here
  // to fill the demo panel would be a duplicate free to drift from the originals
  // with nothing to catch it, so the demo shows an empty book and says so.
  getPrompts: () => Promise.resolve({ dir: null, templates: [] as PromptTemplateView[] }),
  // There is no harness behind the demo, so there is no socket to register and no
  // credential minted anywhere. Answered as a channel that is *down* rather than
  // with a plausible-looking command line: a registration that pointed at nothing
  // is the one thing this tab must never hand somebody, and the tab already draws
  // the not-running case honestly.
  getMcp: (): Promise<McpChannelPayload> =>
    Promise.resolve({
      running: false,
      serverId: 'lubbdubb',
      registration: { command: 'node', args: [] },
      credentialPath: '',
      skillPath: '',
      tools: [],
    }),
  // And the pet catalogue, for the third time and the same reason: what exists and
  // what it costs is decided by tables in `src/pets/`, which the web bundle
  // deliberately does not import. A hand-written demo copy of twenty species would
  // be stale the first time one is added, with nothing to catch it — so the demo
  // ships an empty catalogue and the page says why. The rules ride at zero because
  // the page draws none of them without species to draw them for.
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
  // ---- Setup -----------------------------------------------------------
  //
  // The demo's config file is a **text buffer in memory**, and that is a
  // narrower fabrication than it looks. What the demo refuses to invent is the
  // *running* config — `describeRunningConfig` resolves it server-side from
  // `loadConfig` and a copy here would be a duplicate free to drift. A file's
  // bytes are not that: the setup flow's whole subject is what would be written,
  // and a buffer is a truthful stand-in for a path nobody can write to from a
  // static page. So the flow runs end to end here, against the scripted
  // repository this demo's world is already built on.
  getSetup: () => Promise.resolve(demoSetupReading()),
  resolveSetup: (answers: { email: string; repoRoot: string }) => Promise.resolve(demoSetupResolution(answers)),
  // Same answer as the prompt book, for the same reason: the running config is
  // resolved by `loadConfig` on the server, and the web bundle imports no server
  // code — so a demo copy would be a duplicate free to drift with nothing to
  // catch it. The demo shows an empty config and says so.
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
  // Writes land in the buffer above. The *effect* is still honestly refused —
  // `applied: false` on every key, because there is no live config object here to
  // re-seat and claiming otherwise would be the one lie the setup flow exists to
  // prevent operators from being told.
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
  // The demo configures no `ci.checks`, so an empty policy is not a stand-in —
  // it is what this backend is actually running on, and the tab's empty state is
  // the true reading of it. `unmatched` is a constant of `classifyCiFailures`
  // rather than config, which is why stating it here cannot drift from a value
  // the demo chose.
  getCiPolicy: () =>
    Promise.resolve({ policy: { rules: [], unmatched: 'dispatch', policyKinds: null } as CiPolicyDescription }),
  // Nothing to file into either: the demo has no tracker, which is the same
  // reason the real route refuses when the issues provider is `fake`.
  fileWorkItem: (_ref: string) => Promise.resolve({ ok: false }),
  // Same reason, and the cockpit never calls it: `canFileTickets` is false in the
  // demo fixtures, so the "raise issue" button is not drawn to be clicked.
  raiseBug: (_issueNumber: number, _summary: string, _title?: string) => Promise.resolve({ ok: false }),
  // The demo answers the probe the way the real route does with no `gh` behind it —
  // `available: false` with the reason — rather than refusing, because that reading
  // is what the compose modal is built to fall back from, and the fallback (the
  // external new-issue form) works perfectly well from a demo in a browser.
  probeFilingTarget: (): Promise<FilingTargetProbe> =>
    Promise.resolve({
      available: false,
      target: null,
      identity: null,
      reason: 'this is the demo — there is no harness behind it to file through',
    }),
  // No arm to give this one: the demo has no CLI to file with. It rejects rather
  // than resolving a made-up issue number, since the modal's success state is a link
  // to the thing that was filed and there would be nothing at the other end of it.
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
  setIssueProfile: (issueNumber: number, profile: string | null) => getServer().setIssueProfile(issueNumber, profile),
  setPartProfile: (planId: string, slug: string, profile: string | null) =>
    getServer().setPartProfile(planId, slug, profile),
  setIssueConclusion: (issueNumber: number, verdict: 'done' | 'more_work' | null) =>
    getServer().setIssueConclusion(issueNumber, verdict),
  setIssueAssay: (issueNumber: number, verdict: 'workable' | 'unclear' | null) =>
    getServer().setIssueAssay(issueNumber, verdict),
  addInstruction: (issueNumber: number, text: string) => getServer().addInstruction(issueNumber, text),
  overruleShortfall: (issueNumber: number, text: string) => getServer().overruleShortfall(issueNumber, text),
  releaseEnvironmentGate: (issueNumber: number, released: boolean, note?: string) =>
    getServer().releaseEnvironmentGate(issueNumber, released, note),
  withdrawInstruction: (issueNumber: number, id: string) => getServer().withdrawInstruction(issueNumber, id),
  dismissRun: (issueNumber: number, note?: string) => getServer().dismissRun(issueNumber, note),
  replan: (planId: string) => getServer().replan(planId),
  // The demo's plans have one revision each — no replan has landed in a browser
  // session — so the history is that single revision and a null diff, which is
  // exactly what the real route answers for a plan nobody has amended.
  getPlanHistory: (planId: string) => Promise.resolve(demoPlanHistory(planId)),
  setAcceptance: (planId: string, slug: string, criterion: string, met: boolean) =>
    getServer().setAcceptance(planId, slug, criterion, met),
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
  setFactReach: (id: string, reach: FactRuling) => getServer().setFactReach(id, reach),
  exitFact: (id: string, exit: FactExit) => getServer().exitFact(id, exit),
  raiseFact: (claim: string, originRef: string | null) => getServer().raiseFact(claim, originRef),
  settleGraduation: (id: string, outcome: GraduationOutcome) => getServer().settleGraduation(id, outcome),
  knowledgeFact: (id: string) => getServer().knowledgeFact(id),
  resolveContradiction: (id: string, ruling: ContradictionRuling) => getServer().resolveContradiction(id, ruling),
  completeHumanTask: (id: string, note?: string) => getServer().completeHumanTask(id, note),
  declineHumanTask: (id: string, note: string) => getServer().declineHumanTask(id, note),
  dismissHumanTask: (id: string) => getServer().dismissHumanTask(id),
  acceptProposal: (id: string, note?: string) => getServer().acceptProposal(id, note),
  rejectProposal: (id: string, note?: string) => getServer().rejectProposal(id, note),
  // The demo has no previous run to have crashed, so there is never anything to
  // decide — the panel is absent and this exists only to keep the two API shapes
  // interchangeable.
  decideRecovery: (_taskId: string, _verdict: string) => Promise.resolve({ ok: true as const, remaining: 0 }),
  // The demo is a browser tab with no process behind it, so there is no build to
  // upgrade. Both calls hand back the fixture unchanged: the gauge and the panel
  // render exactly as they do live, and neither control pretends to have worked.
  checkBuild: () => Promise.resolve({ ok: true as const, build: getServer().getBuild() }),
  upgrade: (_action: string, _opts?: { interrupt?: boolean }) =>
    Promise.resolve({ ok: true as const, build: getServer().getBuild() }),
  // The local run, which the demo can model honestly because the *state* is the
  // whole feature and the process is not: starting moves the row onto another goal
  // and stopping ends it, exactly as the panel would see it live. What a visitor
  // cannot get here is a server on a port, and nothing here pretends otherwise —
  // the URL is the fixture's, and it will not answer.
  startLocalRun: (issue: number, ref?: string) => getServer().startLocalRun(issue, ref),
  stopLocalRun: () => getServer().stopLocalRun(),
  localRunOutput: () => Promise.resolve({ lines: getServer().localRunOutput() }),
  killAgent: (id: string) => getServer().killAgent(id),
  completeAgent: (id: string) => getServer().completeAgent(id),
  interruptAgent: (id: string) => getServer().interruptAgent(id),
  resumeAgent: (id: string) => getServer().resumeAgent(id),
  extendStall: (id: string) => getServer().extendStall(id),
};

export function connectDemoWs(onEvent: (ev: unknown) => void, onStatus?: (connected: boolean) => void): WsClient {
  return getServer().connect(onEvent, onStatus);
}

/**
 * The demo's ticket mirror: the goals the spend fixture already names, plus a tail
 * of untouched backlog so the two filter axes have something to separate.
 *
 * The query is genuinely applied — filtered, ordered and paged the same way the
 * route does it — because a demo whose controls do nothing demonstrates the chrome
 * and not the tab.
 */
/**
 * States the visitor has dragged a card into, by issue number.
 *
 * `demoTickets` derives a row's state from its number, which is what makes the demo's
 * board reproducible — so a drag needs somewhere to say otherwise. Module-level for
 * the same reason the rest of the demo world is mutable: a board that looks draggable
 * and springs back would teach a visitor the wrong thing about the product.
 */
const DEMO_STATE_MOVES = new Map<number, string>();

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
  // Three features and a hue apiece, so the legend, the grouping and the orphan
  // bucket all have something to draw. The fourth of every group is deliberately
  // left parentless — an orphan is a state the surface has to be able to show.
  const features = [
    { number: 900, title: 'Payments' },
    { number: 901, title: 'Onboarding' },
    { number: 902, title: 'Platform hygiene' },
  ];
  const featureOf = (n: number) => (n % 4 === 3 ? null : (features[n % 3] ?? null));
  // The demo's stand-in for the store's least-used-first assignment: the position
  // in the list, which for three features is the same answer.
  const featureSlotOf = (feature: { number: number } | null) =>
    feature === null ? null : features.findIndex((f) => f.number === feature.number);
  const worked: TicketRow[] = DEMO_GOAL_SEEDS.map((seed, i) => ({
    number: seed.issueNumber,
    title: seed.title ?? `Goal #${seed.issueNumber}`,
    // The fixture's goals are the closed ones — they are what the spend tab cohorts.
    state: 'closed' as const,
    watch: 'watched' as const,
    labels: ['lubbdubb-watch'],
    costUsd: Object.values(seed.byPhase).reduce((a, b) => a + b, 0),
    outcome: i % 5 === 3 ? 'fell short' : 'delivered',
    addedAt: iso(seed.hoursAgo + 48),
    changedAt: iso(seed.hoursAgo),
    // Closed in the tracker, so the mirror has stopped enriching them.
    tracking: 'frozen' as const,
    workItemState: DEMO_STATE_MOVES.get(seed.issueNumber) ?? 'Closed',
    issueType: 'Task',
    parent: featureOf(seed.issueNumber),
    featureSlot: featureSlotOf(featureOf(seed.issueNumber)),
  }));
  // A tail nobody has triaged, so `unwatched` is not an empty answer.
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
    parent: featureOf(seed.number),
    featureSlot: featureSlotOf(featureOf(seed.number)),
  }));

  const all = [...worked, ...untouched].sort((a, b) => b.number - a.number);
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
          // `live` beside the count for the real route's reason: `Closed` is on
          // frozen rows only, and the tier reads this to widen the tracking axis
          // rather than answering an empty list.
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
    features: features
      .map((f) => ({
        ...f,
        slot: featureSlotOf(f) ?? 0,
        count: all.filter((row) => row.parent?.number === f.number).length,
      }))
      .filter((f) => f.count > 0),
    orphanCount: all.filter((row) => row.parent === null).length,
    anchorAt: iso(24 * 30),
    backfilling: false,
    refUrls: {},
  };
}

/** Backlog the demo's fleet has never been pointed at — the unwatched tail. */
// The types are spread across the families deliberately: a demo where everything is
// a Task shows the tickets list with one tone in it, which reads as a list that has
// no tones. `Capability` is the untinted case, and is the one worth seeing.
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
