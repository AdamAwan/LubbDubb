// In-browser fake backend for the GitHub Pages demo. It stands in for the whole
// server surface (`/api/*` + the `/ws` socket) so the cockpit runs, and stays
// interactive, with no Node process behind it. Every mutation the cockpit makes
// is applied to an in-memory AppState and echoed back as the same events the real
// Hub emits, so App.tsx needs zero changes to run against it.
//
// Kept side-effect-free at module scope: the real build imports this file but the
// `VITE_DEMO` branch in api.ts is statically false there, so Rollup drops it.
import type { AppState, Decision, WorldEvent, WorldEventKind } from '../types.js';
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
    this.addDecision('heartbeat', 'ok', 'nothing to dispatch this cycle', undefined, 'idle');
    this.emit({ type: 'cycle:end', cycleId: this.id('cycle'), rationale: 'manual pulse' });
    this.dirty();
    return { ok: true };
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
      this.addDecision('answer', 'ok', `answered escalation for ${esc.context.taskTitle ?? esc.id}`);
    }
    this.dirty();
    return { ok: true };
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

  /** Toggle the exclusion tag on a PR — the demo mirror of the real label write-back. */
  async setPrExcluded(prNumber: number, excluded: boolean): Promise<{ ok: true; excluded: boolean }> {
    const tag = this.state.config.ignoreLabel;
    const pr = this.state.world.pullRequests.find((p) => p.number === prNumber);
    if (pr) {
      const labels = new Set(pr.labels ?? []);
      if (excluded) labels.add(tag);
      else labels.delete(tag);
      pr.labels = [...labels];
      this.addDecision('pr_label_set', 'ok', `${excluded ? 'tagged' : 'untagged'} PR #${prNumber} (${tag})`);
      this.dirty();
    }
    return { ok: true, excluded };
  }

  /** Toggle an issue's watch/ignore tags — the demo mirror of the real write-back (opt-in). */
  async setIssueWatched(issueNumber: number, watched: boolean): Promise<{ ok: true; watched: boolean }> {
    const issue = this.state.world.issues.find((i) => i.number === issueNumber);
    if (issue) {
      issue.labels = applyWatch(issue.labels, this.state.config, watched);
      this.addDecision('issue_label_set', 'ok', `${watched ? 'watching' : 'ignoring'} issue #${issueNumber}`);
      if (watched)
        this.trySpawn(
          'implement_issue',
          `Implement issue #${issueNumber}`,
          `issue/${issueNumber}`,
          `issue:${issueNumber}`,
        );
      this.dirty();
    }
    return { ok: true, watched };
  }

  async killAgent(id: string): Promise<{ ok: true }> {
    const agent = this.state.agents.find((a) => a.id === id);
    if (agent && agent.status !== 'done') {
      agent.status = 'killed';
      agent.endedAt = new Date().toISOString();
      agent.waitingReason = null;
      const task = this.state.tasks.find((t) => t.id === agent.taskId);
      if (task && task.status === 'active') task.status = 'interrupted';
      // Any open escalation from this agent is moot now.
      for (const e of this.state.escalations) if (e.agentId === id && e.status === 'open') e.status = 'dismissed';
      this.addDecision('kill', 'ok', `killed ${id}`);
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

  private addDecision(type: string, outcome: string, detail: string, reason?: string, rule?: string): void {
    const dec: Decision = {
      id: this.id('dec'),
      cycleId: this.id('cycle'),
      action: reason ? { type, reason } : { type },
      outcome,
      detail,
      rule: rule ?? null,
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
    kind: string,
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
      this.addDecision(`dispatch_${kind}`, 'skipped', `PR #${prNumber} is ignored — held ${title}`, 'pr excluded');
      return null;
    }
    if (this.state.control.paused) {
      this.addDecision(`dispatch_${kind}`, 'deferred', `paused — held ${title}`, 'dispatch paused');
      return null;
    }
    if (this.liveCount() >= this.state.control.cap) {
      this.addDecision(`dispatch_${kind}`, 'deferred', `at cap (${this.state.control.cap}) — held ${title}`);
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
        status: 'active',
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
        startedAt: nowIso,
        endedAt: null,
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
        numTurns: null,
      },
      ...this.state.agents,
    ];
    this.transcripts.set(agentId, `$ claude ${kind}\nPicking up: ${title}`);
    this.addDecision(`dispatch_${kind}`, 'ok', `dispatched agent for ${title}`);
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
    const job = {
      id,
      title,
      prompt,
      kind,
      branch,
      status: 'queued',
      taskId: null as string | null,
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
      this.addDecision('job_cancel', 'ok', `cancelled queued job ${job.title}`);
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
          {
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
          },
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
          this.trySpawn('fix_ci', `Fix failing CI on PR #${n}`, pr.branch, `pr:${n}`);
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
            'ok',
            `notified branch agent about comment on PR #${n}`,
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
          {
            id: this.id('iss'),
            number,
            title: String(ev.title ?? `Issue #${number}`),
            body: String(ev.body ?? ''),
            labels,
            state: 'open',
            linkedPrNumber: null,
          },
        ];
        this.addWorldEvent('issue_opened', `issue:${number}`, `Issue #${number} opened`);
        // Opt-in: only a watched issue is worked. An untagged injected issue shows
        // up unwatched with a "watch" toggle, mirroring the real dispatcher gate.
        if (isWatched(labels, this.state.config)) {
          this.trySpawn('implement_issue', `Implement issue #${number}`, `issue/${number}`, `issue:${number}`);
        } else {
          this.addDecision('dispatch_code', 'skipped', `issue #${number} is not watched — left alone`, 'unwatched');
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
          pr.mergeableState = String(ev.mergeableState ?? (mergeable ? 'clean' : 'dirty'));
          pr.health = mergeable ? { blocked: false, reasons: [] } : { blocked: true, reasons: ['merge conflict'] };
          this.addWorldEvent('pr_mergeable', `pr:${n}`, `PR #${n} is ${mergeable ? 'mergeable' : 'conflicted'}`);
          if (!mergeable) this.trySpawn('resolve_conflict', `Resolve conflict on PR #${n}`, pr.branch, `pr:${n}`);
        }
        break;
      }
      case 'meeting': {
        // The Desk redesign moved the agenda onto the briefing and dropped the
        // World calendar, so an injected meeting lands in `briefing.meetings`
        // (the live surface) — otherwise the "+ Meeting" button would do nothing
        // visible. A default 30-minute online event, relevant to the operator.
        const start = String(ev.startsAt ?? new Date().toISOString());
        const end = new Date(new Date(start).getTime() + 30 * 60_000).toISOString();
        const subject = String(ev.title ?? 'Meeting');
        if (this.state.briefing) {
          this.state.briefing.meetings = [
            ...this.state.briefing.meetings,
            {
              id: this.id('evt'),
              subject,
              start,
              end,
              isOnline: true,
              joinUrl: 'https://teams.microsoft.com/l/meetup-join/demo-injected',
              organizer: 'You',
              attendeeCount: 5,
              responseRequested: true,
              showAs: 'busy',
              relevance: 'mine',
            },
          ];
        }
        this.addWorldEvent('meeting_added', null, `meeting added: ${subject}`);
        break;
      }
      default:
        // Unknown/raw injection — record it so the feed shows *something* happened.
        this.addDecision('inject', 'ok', `injected ${kind || 'event'}`);
    }
  }

  private startTimers(): void {
    if (!this.chatterTimer) {
      this.chatterTimer = setInterval(() => this.tickChatter(), 1400);
    }
    if (!this.beatTimer) {
      const beat = this.state.config.heartbeatIntervalMs;
      this.beatTimer = setInterval(() => {
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

export const demoApi = {
  getState: () => getServer().getState(),
  getTranscript: (agentId: string) => getServer().getTranscript(agentId),
  pulse: () => getServer().pulse(),
  inject: (event: unknown) => getServer().inject(event),
  answerEscalation: (id: string, response: string) => getServer().answerEscalation(id, response),
  respondAgent: (id: string, text: string) => getServer().respondAgent(id, text),
  setControl: (patch: { cap?: number; paused?: boolean }) => getServer().setControl(patch),
  setPrExcluded: (prNumber: number, excluded: boolean) => getServer().setPrExcluded(prNumber, excluded),
  setIssueWatched: (issueNumber: number, watched: boolean) => getServer().setIssueWatched(issueNumber, watched),
  launchJob: (job: { prompt: string; title?: string; kind?: string; branch?: string | null }) =>
    getServer().launchJob(job),
  cancelJob: (id: string) => getServer().cancelJob(id),
  killAgent: (id: string) => getServer().killAgent(id),
  interruptAgent: (id: string) => getServer().interruptAgent(id),
};

export function connectDemoWs(onEvent: (ev: unknown) => void, onStatus?: (connected: boolean) => void): WsClient {
  return getServer().connect(onEvent, onStatus);
}
