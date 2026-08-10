// In-browser fake backend for the GitHub Pages demo. It stands in for the whole
// server surface (`/api/*` + the `/ws` socket) so the cockpit runs, and stays
// interactive, with no Node process behind it. Every mutation the cockpit makes
// is applied to an in-memory AppState and echoed back as the same events the real
// Hub emits, so App.tsx needs zero changes to run against it.
//
// Kept side-effect-free at module scope: the real build imports this file but the
// `VITE_DEMO` branch in api.ts is statically false there, so Rollup drops it.
import type {
  AppState,
  CockpitDecision,
  Decision,
  Issue,
  Job,
  OpenPullRequest,
  CiPolicyDescription,
  PromptTemplateView,
  RunningConfigGroup,
  Proposal,
  Task,
  UnrecordedWorkView,
  WorkNodeView,
  WorldEvent,
  WorldEventKind,
} from '../types.js';
import type { WsClient } from '../api.js';
import { buildDemoState } from './fixtures.js';

type Emit = Record<string, unknown>;
interface Conn {
  onEvent: (ev: unknown) => void;
  subs: Set<string>;
}

// Plausible log lines a "running" agent emits, cycled to fake live progress.
const CHATTER = [
  'reading changed files …',
  'npm test',
  '  ✓ 128 passing',
  'editing src/harness.ts',
  'git add -A && git commit -m "wip"',
  'running npm run check …',
  '  lint ok · typecheck ok · knip ok',
  'thinking about the next step …',
];

type WatchConfig = { watchLabel: string; ignoreLabel: string };

/** Opt-in effective state: watched only with the watch tag and no ignore tag. */
function isWatched(labels: string[] | undefined, config: WatchConfig): boolean {
  const set = labels ?? [];
  if (set.includes(config.ignoreLabel)) return false;
  return set.includes(config.watchLabel);
}

/** Set the watch/ignore tags to reflect a toggle, keeping the two mutually exclusive. */
function applyWatch(labels: string[] | undefined, config: WatchConfig, watched: boolean): string[] {
  const set = new Set(labels ?? []);
  set.delete(config.watchLabel);
  set.delete(config.ignoreLabel);
  set.add(watched ? config.watchLabel : config.ignoreLabel);
  return [...set];
}

/** The dispatch action a kind of agent is sent as — the executor's two, by name. */
function dispatchAction(kind: Task['kind']): Decision['action']['type'] {
  return kind === 'desk' ? 'dispatch_desk_agent' : 'dispatch_code_agent';
}

/**
 * The three statuses `isActiveTask` calls outstanding, mirrored here because the
 * demo has no server to ask. It used to compare against `'active'`, which is not
 * a `TaskStatus` at all — so killing or completing an agent left its task row
 * saying `running` forever.
 */
function isLiveTask(task: Task): boolean {
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
  issue: Omit<Issue, 'assay' | 'conclusion' | 'delivery' | 'retrospective' | 'scratchpad' | 'shortfall' | 'pickup'>,
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
  };
}

class DemoServer {
  private seed = buildDemoState();
  private state: AppState = this.seed.state;
  private transcripts = new Map<string, string>(Object.entries(this.seed.transcripts));
  private readonly conns = new Set<Conn>();
  private chatterTimer: ReturnType<typeof setInterval> | null = null;
  private beatTimer: ReturnType<typeof setInterval> | null = null;
  private chatterIdx = 0;
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

  /** Toggle the exclusion tag on a PR — the demo mirror of the real label write-back. */
  async setPrExcluded(prNumber: number, excluded: boolean): Promise<{ ok: true; excluded: boolean }> {
    const tag = this.state.config.ignoreLabel;
    const pr = this.state.world.pullRequests.find((p) => p.number === prNumber);
    if (pr) {
      const labels = new Set(pr.labels ?? []);
      if (excluded) labels.add(tag);
      else labels.delete(tag);
      pr.labels = [...labels];
      this.addDecision(
        'no_op',
        'executed',
        `${excluded ? 'tagged' : 'untagged'} PR #${prNumber} (${tag})`,
        undefined,
        undefined,
        undefined,
        `pr:${prNumber}`,
      );
      this.dirty();
    }
    return { ok: true, excluded };
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
   * End a run — the demo mirror of the one way a goal leaves the floor (#203,
   * #234). Marks the run dismissed wherever it rides (a still-present issue, or a
   * forgotten-issue entry in `retainedRuns`), which is what the floor filters on.
   */
  async dismissRun(issueNumber: number): Promise<{ ok: true }> {
    const present = this.state.world.issues.find((i) => i.number === issueNumber);
    const forgotten = (this.state.retainedRuns ?? []).find((i) => i.number === issueNumber);
    const target = present ?? forgotten;
    if (target?.run) {
      target.run = { ...target.run, dismissed: true };
      this.addDecision(
        'no_op',
        'executed',
        `issue #${issueNumber} run dismissed`,
        undefined,
        undefined,
        undefined,
        `issue:${issueNumber}`,
      );
      this.dirty();
    }
    return { ok: true };
  }

  /** Toggle an issue's watch/ignore tags — the demo mirror of the real write-back (opt-in). */
  async setIssueWatched(issueNumber: number, watched: boolean): Promise<{ ok: true; watched: boolean }> {
    const issue = this.state.world.issues.find((i) => i.number === issueNumber);
    if (issue) {
      issue.labels = applyWatch(issue.labels, this.state.config, watched);
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
   * Abandon a released decomposition — the demo mirror of
   * `POST /api/plans/:id/abandon`. Mirrors the server's guards too (active, and no
   * part started), because a demo that offers what the real route refuses teaches
   * the control wrong.
   */
  async abandonPlan(planId: string): Promise<{ ok: true }> {
    const plan = (this.state.plans ?? []).find((p) => p.id === planId);
    const parts = (this.state.planParts ?? []).filter((p) => p.planId === planId && p.status !== 'retired');
    const started = parts.some((p) => ['dispatched', 'in_review', 'merged', 'concluded'].includes(p.status));
    if (plan?.status === 'active' && parts.length > 0 && !started) {
      // Retiring the parts *is* the collapse: the shape is the live part list, so
      // the status stays `active` — the same write the real route makes.
      for (const part of parts) part.status = 'retired';
      plan.updatedAt = new Date().toISOString();
      this.dirty();
    }
    return { ok: true };
  }

  /**
   * Talk it through with an agent instead of accepting or rejecting — the demo
   * mirror of `POST /api/plans/:id/discuss`. Marks the plan `discussing` (nothing
   * is scheduled while that's true) and spawns the same discussion agent a real
   * planner-origin dispatch would be, so the modal's live discussion pane has
   * something to show.
   */
  async discussPlan(planId: string): Promise<{ ok: true }> {
    const plan = (this.state.plans ?? []).find((p) => p.id === planId);
    if (plan && !plan.discussing) {
      plan.discussing = true;
      plan.updatedAt = new Date().toISOString();
      this.trySpawn('desk', `Discuss ${plan.title}`, null, `${plan.originRef}:plan`);
      this.addDecision('dispatch_desk_agent', 'executed', `discussing ${plan.title}`, 'issue-plan');
      this.dirty();
    }
    return { ok: true };
  }

  /**
   * Stop the conversation and put the plan back up for approval unchanged — the
   * demo mirror of `POST /api/plans/:id/discuss/end`.
   */
  async endPlanDiscussion(planId: string): Promise<{ ok: true }> {
    const plan = (this.state.plans ?? []).find((p) => p.id === planId);
    if (plan) {
      plan.discussing = false;
      plan.updatedAt = new Date().toISOString();
      this.dirty();
    }
    return { ok: true };
  }

  /**
   * Promote a finding into a queued job — the demo mirror of
   * `POST /api/findings/:id/promote`, and the only path from a finding to work in
   * either backend: the operator's click is the gate.
   */
  async promoteFinding(id: string): Promise<{ ok: true }> {
    const finding = (this.state.findings ?? []).find((f) => f.id === id);
    if (finding && finding.status === 'open') {
      const title = `[${finding.kind}]${finding.ref ? ` ${finding.ref}` : ''} ${finding.summary.split('\n')[0]!}`.slice(
        0,
        80,
      );
      await this.launchJob({ prompt: finding.summary, title });
      finding.status = 'promoted';
      finding.jobId = this.state.jobs[0]?.id ?? null;
      finding.updatedAt = new Date().toISOString();
      this.dirty();
    }
    return { ok: true };
  }

  /**
   * File a finding as a ticket — the demo mirror of `POST /api/findings/:id/file`.
   *
   * It stops at `filing`, which is the honest demo: the real transition to
   * `filed` is a desk agent creating the ticket and calling `link_ticket`, and
   * the demo has no tracker to create one in.
   */
  async fileFinding(id: string): Promise<{ ok: true }> {
    const finding = (this.state.findings ?? []).find((f) => f.id === id);
    if (finding && finding.status === 'open') {
      await this.launchJob({ prompt: `File this finding as a ticket:\n\n${finding.summary}`, title: 'File ticket' });
      finding.status = 'filing';
      finding.jobId = this.state.jobs[0]?.id ?? null;
      finding.updatedAt = new Date().toISOString();
      this.dirty();
    }
    return { ok: true };
  }

  /** Dismiss a finding (demo mirror of POST /api/findings/:id/dismiss). */
  async dismissFinding(id: string): Promise<{ ok: true }> {
    const finding = (this.state.findings ?? []).find((f) => f.id === id);
    if (finding && finding.status === 'open') {
      finding.status = 'dismissed';
      finding.updatedAt = new Date().toISOString();
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

  async interruptAgent(id: string): Promise<{ ok: true }> {
    this.append(id, '\n^C interrupt received');
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
    kind: Task['kind'],
    title: string,
    branch: string | null,
    originRef: string | null,
    prompt?: string,
  ): string | null {
    // A PR tagged with the exclusion label is left alone — mirrors the server
    // harness filtering tagged PRs out of the dispatch view, so the ignore toggle
    // visibly matters in the demo.
    const prNumber = originRef?.startsWith('pr:') ? Number(originRef.slice(3)) : NaN;
    const taggedPr = this.state.world.pullRequests.find((p) => p.number === prNumber);
    if (taggedPr && (taggedPr.labels ?? []).includes(this.state.config.ignoreLabel)) {
      this.addDecision(dispatchAction(kind), 'skipped', `PR #${prNumber} is ignored — held ${title}`, 'pr excluded');
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
        prompt: prompt ?? title,
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
        numTurns: null,
        // A fresh agent has said nothing yet — the card falls back to its output
        // tail, which is exactly the state note_progress must not paper over.
        note: null,
        notedAt: null,
        resumedAt: null,
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
    const taskId = this.trySpawn(kind, title, branch, `job:${id}`, prompt);
    if (taskId) {
      job.status = 'dispatched';
      job.taskId = taskId;
      job.updatedAt = new Date().toISOString();
    }
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
  originRef: 'issue:205',
  summary: 'Delivered in one PR, but two agents were spent chasing a red base that was never ours.',
  document: [
    '## What shipped',
    '',
    'PR #140 documents the sentinel protocol and where detection lives, including the cross-chunk case in the PTY runtime. Nothing was left outstanding.',
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
    padRef: 'issue:205',
    authorOriginRef: 'issue:205',
    agentId: 'agent-4',
    taskId: 'task-4',
    topic: 'detection',
    note: 'Detection lives in two places, not one: sentinels.ts has the pure helpers, and PtySession additionally handles a sentinel split across two data chunks. The README section has to cover both or it describes half the protocol.',
    createdAt: new Date(Date.now() - 9_000_000).toISOString(),
  },
  {
    id: 'scr_demo2',
    padRef: 'issue:205',
    authorOriginRef: 'issue:205',
    agentId: 'agent-4',
    taskId: 'task-4',
    topic: 'ci',
    note: 'CI on this branch is red and none of it is ours — the failures are all in the base PR (#137). Do not chase them.',
    createdAt: new Date(Date.now() - 7_800_000).toISOString(),
  },
  {
    id: 'scr_demo3',
    padRef: 'issue:205',
    authorOriginRef: 'issue:205:part:docs',
    agentId: 'agent-6',
    taskId: 'task-6',
    topic: 'ci',
    note: 'Spent about an hour on the red suite before working out the failures come from the base branch. Reading the pad first would have saved all of it.',
    createdAt: new Date(Date.now() - 4_800_000).toISOString(),
  },
  {
    id: 'scr_demo4',
    padRef: 'issue:205',
    authorOriginRef: 'issue:205:assess',
    agentId: 'agent-7',
    taskId: 'task-7',
    topic: null,
    note: 'PR #140 covers both runtimes and the stripping rule. Nothing outstanding that I can see.',
    createdAt: new Date(Date.now() - 4_200_000).toISOString(),
  },
];

export const demoApi = {
  getState: () => getServer().getState(),
  getTranscript: (agentId: string) => getServer().getTranscript(agentId),
  // The demo's world is built fresh in the browser each load, so nothing has ever
  // been recorded for it — an empty graph is the honest answer, and these exist to
  // keep the two API shapes interchangeable.
  getWorkRoots: () =>
    Promise.resolve({ roots: [] as WorkNodeView[], unrecorded: [] as UnrecordedWorkView[], refUrls: {} }),
  getWorkSubtree: (_ref: string) => Promise.resolve({ nodes: [] as WorkNodeView[], refUrls: {} }),
  // The demo's one written-up goal, so the Manifest station has something to open.
  // Everything else answers null, which is the same thing the real route says for a
  // goal nobody wrote up — silence, not an error.
  getRetrospective: (ref: string) =>
    Promise.resolve({ retrospective: ref === 'issue:205' ? DEMO_RETROSPECTIVE : null }),
  // The pad behind that write-up. Every other goal answers an empty trail, which
  // is what the real route says for a pad nobody has written to — and no way in
  // is drawn for one, since the snapshot's reading is what the control keys on.
  getScratchpad: (ref: string) => Promise.resolve({ padRef: ref, entries: ref === 'issue:205' ? DEMO_SCRATCHPAD : [] }),
  // The prompt book lives in the server's template registry, and the web bundle
  // deliberately imports no server code. Shipping a copy of eighteen prompts here
  // to fill the demo panel would be a duplicate free to drift from the originals
  // with nothing to catch it, so the demo shows an empty book and says so.
  getPrompts: () => Promise.resolve({ dir: null, templates: [] as PromptTemplateView[] }),
  // Same answer as the prompt book, for the same reason: the running config is
  // resolved by `loadConfig` on the server, and the web bundle imports no server
  // code — so a demo copy would be a duplicate free to drift with nothing to
  // catch it. The demo shows an empty config and says so.
  getConfig: () => Promise.resolve({ groups: [] as RunningConfigGroup[] }),
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
  setWorkItemIgnored: (_ref: string, _ignored: boolean) => Promise.resolve({ ok: true as const }),
  pulse: () => getServer().pulse(),
  clearErrors: () => getServer().clearErrors(),
  inject: (event: unknown) => getServer().inject(event),
  answerEscalation: (id: string, response: string) => getServer().answerEscalation(id, response),
  decidePermission: (id: string, allow: boolean, note?: string) => getServer().decidePermission(id, allow, note),
  dismissEscalation: (id: string, note?: string) => getServer().dismissEscalation(id, note),
  respondAgent: (id: string, text: string) => getServer().respondAgent(id, text),
  setControl: (patch: { cap?: number; paused?: boolean }) => getServer().setControl(patch),
  setPrExcluded: (prNumber: number, excluded: boolean) => getServer().setPrExcluded(prNumber, excluded),
  setStackLanding: (ref: string, landing: boolean) => getServer().setStackLanding(ref, landing),
  setIssueWatched: (issueNumber: number, watched: boolean) => getServer().setIssueWatched(issueNumber, watched),
  setIssueConclusion: (issueNumber: number, verdict: 'done' | 'more_work' | null) =>
    getServer().setIssueConclusion(issueNumber, verdict),
  setIssueAssay: (issueNumber: number, verdict: 'workable' | 'unclear' | null) =>
    getServer().setIssueAssay(issueNumber, verdict),
  dismissRun: (issueNumber: number) => getServer().dismissRun(issueNumber),
  replan: (planId: string) => getServer().replan(planId),
  abandonPlan: (planId: string) => getServer().abandonPlan(planId),
  discussPlan: (planId: string) => getServer().discussPlan(planId),
  endPlanDiscussion: (planId: string) => getServer().endPlanDiscussion(planId),
  reorderUpNext: (origins: string[]) => getServer().reorderUpNext(origins),
  launchJob: (job: { prompt: string; title?: string; kind?: string; branch?: string | null }) =>
    getServer().launchJob(job),
  cancelJob: (id: string) => getServer().cancelJob(id),
  promoteFinding: (id: string) => getServer().promoteFinding(id),
  fileFinding: (id: string) => getServer().fileFinding(id),
  dismissFinding: (id: string) => getServer().dismissFinding(id),
  acceptProposal: (id: string, note?: string) => getServer().acceptProposal(id, note),
  rejectProposal: (id: string, note?: string) => getServer().rejectProposal(id, note),
  // The demo has no previous run to have crashed, so there is never anything to
  // decide — the panel is absent and this exists only to keep the two API shapes
  // interchangeable.
  decideRecovery: (_taskId: string, _verdict: string) => Promise.resolve({ ok: true as const, remaining: 0 }),
  killAgent: (id: string) => getServer().killAgent(id),
  completeAgent: (id: string) => getServer().completeAgent(id),
  interruptAgent: (id: string) => getServer().interruptAgent(id),
};

export function connectDemoWs(onEvent: (ev: unknown) => void, onStatus?: (connected: boolean) => void): WsClient {
  return getServer().connect(onEvent, onStatus);
}
