import type {
  AppState,
  BugFiling,
  Ejection,
  EjectionOutcome,
  GoalWatchDeclaration,
  BuildReading,
  InsightsWindow,
  JobAttachmentInput,
  LocalRunView,
  LocalValidationView,
  RecoveryVerdict,
  StackLanding,
  StateSection,
  UpgradeAction,
  SnoozeTarget,
  CaveatAnswerInput,
} from './types.js';
import type {
  AgentFilesPayload,
  AllowancePayload,
  GoalAgentsPayload,
  AgentTranscript,
  CiPolicyPayload,
  FilingTargetProbe,
  IssueFiled,
  PetCatalogue,
  PlanHistory,
  McpChannelPayload,
  McpUsagePayload,
  UsagePayload,
  ObstacleBoardPayload,
  PoolInsightsPayload,
  PoolStatePayload,
  PromptsPayload,
  RetrospectivePayload,
  RunClearOut,
  RunningConfigPayload,
  SetupPayload,
  SetupResolvePayload,
  ConfigSavePayload,
  ConfigPreviewPayload,
  ReviewAttention,
  ReviewCalibrationPayload,
  ReviewMarksPayload,
  ReviewPackAbsence,
  ReviewPackPayload,
  ReviewPackSharing,
  ScratchpadPayload,
  ReliabilityPayload,
  SpendPayload,
  SpendTrendPayload,
  WorkRootsPayload,
  TicketsPayload,
  FeatureBoardPayload,
  FeatureSequence,
  WorkSubtreePayload,
} from '../../src/wire.js';
import { demoApi, connectDemoWs } from './demo/demoBackend.js';

// → docs/spec/16-http-api.md

export type ReviewPackReading = { kind: 'pack'; payload: ReviewPackPayload } | { kind: 'none'; writing: boolean };

export class UnauthorizedError extends Error {
  constructor(readonly status: number) {
    super(status === 403 ? 'Request refused by the cockpit' : 'Cockpit token missing or invalid');
    this.name = 'UnauthorizedError';
  }
}

const TOKEN_KEY = 'lubbdubb.cockpitToken';

function readToken(): string {
  try {
    const fromHash = /[#&]t=([A-Za-z0-9_-]+)/.exec(location.hash)?.[1];
    if (fromHash) {
      localStorage.setItem(TOKEN_KEY, fromHash);
      history.replaceState(null, '', location.pathname + location.search);
      return fromHash;
    }
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return typeof location === 'undefined' ? '' : (/[#&]t=([A-Za-z0-9_-]+)/.exec(location.hash)?.[1] ?? '');
  }
}

const token = readToken();

async function authFetch(url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  const res = await fetch(url, { ...init, headers });
  if (res.status === 401 || res.status === 403) throw new UnauthorizedError(res.status);
  return res;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error((await refusalText(res)) ?? `${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

async function refusalText(res: Response): Promise<string | null> {
  try {
    const body: unknown = await res.json();
    const error = (body as { error?: unknown }).error;
    return typeof error === 'string' && error ? error : null;
  } catch {
    return null;
  }
}

function post<T>(url: string, body?: unknown): Promise<T> {
  return authFetch(url, {
    method: 'POST',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  }).then((r) => json<T>(r));
}

function put<T>(url: string, body: unknown): Promise<T> {
  return authFetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => json<T>(r));
}

function del<T>(url: string): Promise<T> {
  return authFetch(url, { method: 'DELETE' }).then((r) => json<T>(r));
}

const realApi = {
  getState: (sections?: ReadonlySet<StateSection> | null) =>
    authFetch(
      sections === undefined || sections === null ? '/api/state' : `/api/state?sections=${[...sections].join(',')}`,
    ).then((r) => json<Partial<AppState>>(r)),
  getTranscript: (agentId: string, from = 0) =>
    authFetch(`/api/agents/${agentId}/transcript${from > 0 ? `?from=${from}` : ''}`).then((r) =>
      json<AgentTranscript>(r),
    ),
  getAgentFiles: (agentId: string) => authFetch(`/api/agents/${agentId}/files`).then((r) => json<AgentFilesPayload>(r)),
  getGoalAgents: (ref: string, prs: readonly number[]) =>
    authFetch(
      `/api/issues/${/^issue:(\d+)$/.exec(ref)?.[1] ?? ''}/agents${prs.length > 0 ? `?prs=${prs.join(',')}` : ''}`,
    ).then((r) => json<GoalAgentsPayload>(r)),
  getWorkRoots: () => authFetch('/api/work').then((r) => json<WorkRootsPayload>(r)),
  getWorkSubtree: (ref: string) =>
    authFetch(`/api/work/${encodeURIComponent(ref)}`).then((r) => json<WorkSubtreePayload>(r)),
  getTickets: (query: {
    watch: string;
    tracking: string;
    state: string;
    feature: string | null;
    order: string;
    cursor: string | null;
  }) => {
    const params = new URLSearchParams();
    if (query.watch !== 'any') params.set('watch', query.watch);
    if (query.tracking !== 'live') params.set('tracking', query.tracking);
    if (query.state !== 'any') params.set('state', query.state);
    if (query.feature !== null) params.set('feature', query.feature);
    if (query.order !== 'added') params.set('order', query.order);
    if (query.cursor !== null) params.set('cursor', query.cursor);
    const search = params.toString();
    return authFetch(`/api/tickets${search === '' ? '' : `?${search}`}`).then((r) => json<TicketsPayload>(r));
  },
  getFeatures: () => authFetch('/api/features').then((r) => json<FeatureBoardPayload>(r)),
  answerFeatureSequence: (number: number, answer: 'accepted' | 'declined', by: string) =>
    post<FeatureSequence>(`/api/features/${number}/sequence`, { answer, by }),
  setFeaturePaused: (number: number, paused: boolean) =>
    post<{ ok: true; paused: boolean }>(`/api/features/${number}/pause`, { paused }),
  getRetrospective: (ref: string) =>
    authFetch(`/api/retrospectives/${encodeURIComponent(ref)}`).then((r) => json<RetrospectivePayload>(r)),
  getScratchpad: (ref: string) =>
    authFetch(`/api/scratchpads/${encodeURIComponent(ref)}`).then((r) => json<ScratchpadPayload>(r)),
  getReviewPack: (prNumber: number): Promise<ReviewPackReading> =>
    authFetch(`/api/prs/${prNumber}/review-pack`).then(async (r) => {
      if (r.status === 404) {
        const absence = (await r.json()) as ReviewPackAbsence;
        return { kind: 'none', writing: absence.writing === true };
      }
      return { kind: 'pack', payload: await json<ReviewPackPayload>(r) };
    }),
  requestReviewPack: (prNumber: number) =>
    post<{ ok: true; prNumber: number; headSha: string }>(`/api/prs/${prNumber}/review-pack`),
  shareReviewPack: (prNumber: number) => post<ReviewPackSharing>(`/api/prs/${prNumber}/review-pack/share`),
  unshareReviewPack: (prNumber: number) => post<ReviewPackSharing>(`/api/prs/${prNumber}/review-pack/unshare`),
  markReviewIdeaRead: (prNumber: number, ideaId: string, read: boolean) =>
    post<ReviewMarksPayload>(`/api/prs/${prNumber}/review-pack/ideas/${encodeURIComponent(ideaId)}/read`, { read }),
  getReviewCalibration: (window: InsightsWindow) =>
    authFetch(`/api/review-calibration?window=${window}`).then((r) => json<ReviewCalibrationPayload>(r)),
  markReviewFindingSeen: (prNumber: number, ideaId: string, seen: boolean) =>
    post<ReviewMarksPayload>(`/api/prs/${prNumber}/review-pack/ideas/${encodeURIComponent(ideaId)}/seen`, { seen }),
  overrideReviewAttention: (prNumber: number, ideaId: string, attention: ReviewAttention | null) =>
    post<ReviewMarksPayload>(`/api/prs/${prNumber}/review-pack/ideas/${encodeURIComponent(ideaId)}/attention`, {
      attention,
    }),
  getSpend: (window: InsightsWindow) => authFetch(`/api/spend?window=${window}`).then((r) => json<SpendPayload>(r)),
  getSpendTrend: (window: InsightsWindow) =>
    authFetch(`/api/spend/trend?window=${window}`).then((r) => json<SpendTrendPayload>(r)),
  getAllowance: (window: InsightsWindow) =>
    authFetch(`/api/allowance?window=${window}`).then((r) => json<AllowancePayload>(r)),
  getReliability: (window: InsightsWindow) =>
    authFetch(`/api/reliability?window=${window}`).then((r) => json<ReliabilityPayload>(r)),
  getMcpUsage: (window: InsightsWindow) =>
    authFetch(`/api/mcp/usage?window=${window}`).then((r) => json<McpUsagePayload>(r)),
  getUsage: (window: InsightsWindow) => authFetch(`/api/usage?window=${window}`).then((r) => json<UsagePayload>(r)),
  logUsageEvents: (events: unknown[]): Promise<void> =>
    authFetch('/api/usage/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events }),
      keepalive: true,
    }).then(
      () => undefined,
      () => undefined,
    ),
  getPoolInsights: (project: string | null) =>
    authFetch(`/api/pool/insights${project === null ? '' : `?project=${encodeURIComponent(project)}`}`).then((r) =>
      json<PoolInsightsPayload>(r),
    ),
  getObstacles: () => authFetch('/api/obstacles').then((r) => json<ObstacleBoardPayload>(r)),
  muteObstacle: (id: string, muted: boolean) =>
    post<{ ok: true }>(`/api/obstacles/${encodeURIComponent(id)}/mute`, { muted }),
  ownObstacle: (id: string, ownerRef: string) =>
    post<{ ok: true }>(`/api/obstacles/${encodeURIComponent(id)}/own`, { ownerRef }),
  retireObstacle: (id: string) => post<{ ok: true }>(`/api/obstacles/${encodeURIComponent(id)}/retire`, {}),
  writeDownObstacle: (id: string) => post<{ ok: true }>(`/api/obstacles/${encodeURIComponent(id)}/write-up`, {}),
  getPool: () => authFetch('/api/pool').then((r) => json<PoolStatePayload>(r)),
  getPetCatalogue: () => authFetch('/api/pets/catalogue').then((r) => json<PetCatalogue>(r)),

  getPrompts: () => authFetch('/api/prompts').then((r) => json<PromptsPayload>(r)),
  getSetup: () => authFetch('/api/setup').then((r) => json<SetupPayload>(r)),
  resolveSetup: (answers: { email: string; repoRoot: string }) =>
    post<SetupResolvePayload>('/api/setup/resolve', answers),
  getConfig: () => authFetch('/api/config').then((r) => json<RunningConfigPayload>(r)),
  saveConfig: (edits: { set?: Record<string, unknown>; clear?: string[]; baseline: string }) =>
    post<ConfigSavePayload>('/api/config', edits),
  restartHarness: (interrupt: boolean) => post<{ ok: true }>('/api/config/restart', { interrupt }),
  previewConfig: (edits: { set?: Record<string, unknown>; clear?: string[]; text?: string; baseline: string }) =>
    post<ConfigPreviewPayload>('/api/config/preview', edits),
  saveRawConfig: (edits: { text: string; baseline: string }) => post<ConfigSavePayload>('/api/config/raw', edits),
  getCiPolicy: () => authFetch('/api/ci-policy').then((r) => json<CiPolicyPayload>(r)),
  getMcp: () => authFetch('/api/mcp').then((r) => json<McpChannelPayload>(r)),
  fileWorkItem: (ref: string) => post(`/api/work/${encodeURIComponent(ref)}/file`),
  setWorkItemIgnored: (ref: string, ignored: boolean) =>
    ignored
      ? post(`/api/work/${encodeURIComponent(ref)}/ignore`)
      : authFetch(`/api/work/${encodeURIComponent(ref)}/ignore`, { method: 'DELETE' }).then((r) =>
          json<{ ok: true }>(r),
        ),
  pulse: () => post('/api/pulse'),
  clearErrors: () => post<{ ok: true; cleared: number }>('/api/errors/clear'),
  answerEscalation: (id: string, response: string) => post(`/api/escalations/${id}/answer`, { response }),
  answerQuestions: (id: string, answers: (string | null)[]) => post(`/api/escalations/${id}/answer`, { answers }),
  dismissEscalation: (id: string, note?: string) =>
    post<{ ok: true; dismissedAs: string }>(`/api/escalations/${id}/dismiss`, { note }),
  decidePermission: (id: string, allow: boolean, note?: string) =>
    post<{ ok: true; allowed: boolean }>(`/api/escalations/${id}/permission`, { allow, note }),
  acceptProposal: (id: string, note?: string, acknowledged?: string[], answers?: CaveatAnswerInput[]) =>
    post<{ ok: boolean; detail: string }>(`/api/proposals/${id}/accept`, { note, acknowledged, answers }),
  rejectProposal: (id: string, note?: string) =>
    post<{ ok: boolean; detail: string }>(`/api/proposals/${id}/reject`, { note }),
  backOutProposal: (id: string, verdict: 'close' | 'hold', note?: string) =>
    post<{ ok: boolean; detail: string }>(`/api/proposals/${id}/back-out`, { verdict, note }),
  respondAgent: (id: string, text: string) => post(`/api/agents/${id}/respond`, { text }),
  setControl: (patch: { cap?: number; paused?: boolean }) =>
    post<{ ok: true; cap: number; paused: boolean }>('/api/control', patch),
  setPrWatched: (prNumber: number, watched: boolean) =>
    post<{ ok: true; watched: boolean }>(`/api/prs/${prNumber}/watch`, { watched }),
  setStackLanding: (ref: string, landing: boolean) =>
    landing
      ? post<{ ok: true; landing: StackLanding }>(`/api/stacks/${encodeURIComponent(ref)}/land`)
      : authFetch(`/api/stacks/${encodeURIComponent(ref)}/land`, { method: 'DELETE' }).then((r) =>
          json<{ ok: true; landing: StackLanding }>(r),
        ),
  setIssueWatched: (issueNumber: number, watched: boolean) =>
    post<{ ok: true; watched: boolean }>(`/api/issues/${issueNumber}/watch`, { watched }),
  setIssueState: (issueNumber: number, state: string) =>
    post<{ ok: true; state: string }>(`/api/issues/${issueNumber}/state`, { state }),
  setGoalPriority: (issueNumber: number, priority: boolean) =>
    post<{ ok: true; priority: boolean }>(`/api/issues/${issueNumber}/priority`, { priority }),
  setIssueProfile: (issueNumber: number, profile: string | null) =>
    post<{ ok: true }>(`/api/issues/${issueNumber}/profile`, { profile: profile ?? '' }),
  setIssueParent: (issueNumber: number, parent: number | null) =>
    post<{ ok: true }>(`/api/issues/${issueNumber}/parent`, parent === null ? {} : { parent }),
  setIssueAreaPath: (issueNumber: number, areaPath: string | null) =>
    post<{ ok: true }>(`/api/issues/${issueNumber}/area-path`, { areaPath: areaPath ?? '' }),
  setPartProfile: (planId: string, slug: string, profile: string | null) =>
    post<{ ok: true }>(`/api/plans/${planId}/part-profile`, { slug, profile: profile ?? '' }),
  restartPart: (planId: string, slug: string) =>
    post<{ ok: true; detail: string }>(`/api/plans/${planId}/restart-part`, { slug }),
  regroupPlan: (planId: string, groups: { slug: string; atoms: string[]; title?: string; scope?: string }[]) =>
    post<{ ok: true; detail: string }>(`/api/plans/${planId}/regroup`, { groups }),
  setIssueConclusion: (issueNumber: number, verdict: 'done' | 'more_work' | null) =>
    post<{ ok: true }>(`/api/issues/${issueNumber}/conclusion`, { verdict }),
  addInstruction: (issueNumber: number, text: string) =>
    post<{ ok: true }>(`/api/issues/${issueNumber}/instruction`, { text }),
  overruleShortfall: (issueNumber: number, text: string) =>
    post<{ ok: true }>(`/api/issues/${issueNumber}/shortfall/overrule`, { text }),
  releaseEnvironmentGate: (issueNumber: number, released: boolean, note?: string) =>
    post<{ ok: true }>(`/api/issues/${issueNumber}/environment-gate`, { released, note }),
  reopenPrThread: (prNumber: number, threadId: string, reopened: boolean) =>
    post<{ ok: true }>(`/api/prs/${prNumber}/threads/${encodeURIComponent(threadId)}/reopen`, { reopened }),
  withdrawInstruction: (issueNumber: number, id: string) =>
    authFetch(`/api/issues/${issueNumber}/instruction/${id}`, { method: 'DELETE' }).then((r) =>
      json<{ ok: true; standing: number }>(r),
    ),
  setIssueAppraisal: (issueNumber: number, verdict: 'workable' | 'unclear' | null) =>
    post<{ ok: true }>(`/api/issues/${issueNumber}/appraisal`, { verdict }),
  raiseBug: (issueNumber: number, summary: string, title?: string) =>
    post<{ ok: true; filing: BugFiling }>(`/api/issues/${issueNumber}/bug`, { summary, title }),
  probeFilingTarget: () => authFetch('/api/issues/filing-target').then((r) => json<FilingTargetProbe>(r)),
  raiseIssue: (title: string, body: string, watch: boolean) => post<IssueFiled>('/api/issues', { title, body, watch }),
  dismissRun: (issueNumber: number, note?: string) =>
    post<{ ok: true; cleared: RunClearOut }>(
      `/api/issues/${issueNumber}/dismiss-run`,
      note === undefined ? undefined : { note },
    ),
  replan: (planId: string) => post<{ ok: true }>(`/api/plans/${planId}/replan`),
  ruleWatchProposal: (issueNumber: number, checkId: string, accept: boolean) =>
    post<{ ok: true }>(`/api/issues/${issueNumber}/watch-proposals/${encodeURIComponent(checkId)}`, { accept }),
  saveWatchCheck: (issueNumber: number, check: GoalWatchDeclaration) =>
    put<{ ok: true; dryRun: string[] }>(
      `/api/issues/${issueNumber}/watch/checks/${encodeURIComponent(check.id)}`,
      check,
    ),
  deleteWatchCheck: (issueNumber: number, checkId: string) =>
    del<{ ok: true }>(`/api/issues/${issueNumber}/watch/checks/${encodeURIComponent(checkId)}`),
  extendWatch: (issueNumber: number, environment: string) =>
    post<{ ok: true }>(`/api/issues/${issueNumber}/watch/${encodeURIComponent(environment)}/extend`),
  getPlanHistory: (planId: string) => authFetch(`/api/plans/${planId}/history`).then((r) => json<PlanHistory>(r)),
  setValidation: (
    issueNumber: number,
    checkId: string,
    act:
      | { kind: 'result'; result: 'passed' | 'failed'; note: string }
      | { kind: 'defer'; reason: string }
      | { kind: 'waive'; reason: string }
      | { kind: 'reset' }
      | { kind: 'handover'; to: 'fleet' | 'human' },
  ) => {
    const base = `/api/issues/${issueNumber}/validation/${encodeURIComponent(checkId)}`;
    if (act.kind === 'result') return post<{ ok: true }>(`${base}/result`, { result: act.result, note: act.note });
    if (act.kind === 'defer') return post<{ ok: true }>(`${base}/defer`, { reason: act.reason });
    if (act.kind === 'waive') return post<{ ok: true }>(`${base}/waive`, { reason: act.reason });
    if (act.kind === 'handover') return post<{ ok: true }>(`${base}/handover`, { to: act.to });
    return post<{ ok: true }>(`${base}/reset`);
  },
  reorderUpNext: (origins: string[]) => post<{ ok: true }>('/api/upnext/order', { origins }),
  setUpNextProfile: (origin: string, profile: string | null) =>
    post<{ ok: true }>('/api/upnext/profile', { origin, profile: profile ?? '' }),
  launchJob: (job: {
    prompt: string;
    title?: string;
    kind?: string;
    branch?: string | null;
    attachments?: JobAttachmentInput[];
  }) => post<{ ok: true }>('/api/jobs', job),
  cancelJob: (id: string) => post<{ ok: true }>(`/api/jobs/${id}/cancel`),
  createSchedule: (schedule: { cron: string; prompt: string; title?: string; kind?: string }) =>
    post<{ ok: true }>('/api/schedules', schedule),
  updateSchedule: (
    id: string,
    patch: { cron?: string; prompt?: string; title?: string; kind?: string; enabled?: boolean },
  ) => post<{ ok: true }>(`/api/schedules/${id}`, patch),
  runSchedule: (id: string) => post<{ ok: true }>(`/api/schedules/${id}/run`),
  deleteSchedule: (id: string) =>
    authFetch(`/api/schedules/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: true }>(r)),
  promoteFinding: (id: string) => post<{ ok: true }>(`/api/findings/${id}/promote`),
  fileFinding: (id: string) => post<{ ok: true }>(`/api/findings/${id}/file`),
  dismissFinding: (id: string) => post<{ ok: true }>(`/api/findings/${id}/dismiss`),

  openPet: (id: string) => post<{ ok: true }>(`/api/pets/${id}/open`, {}),
  feedPet: (id: string, beats: number) => post<{ ok: true }>(`/api/pets/${id}/feed`, { beats }),
  renamePet: (id: string, name: string) => post<{ ok: true }>(`/api/pets/${id}/name`, { name }),
  placePet: (id: string, placed: boolean) => post<{ ok: true }>(`/api/pets/${id}/place`, { placed }),
  blendPet: (id: string) => post<{ ok: true }>(`/api/pets/${id}/blend`, {}),

  completeHumanTask: (id: string, note?: string) =>
    post<{ ok: true }>(`/api/human-tasks/${id}/done`, note === undefined ? undefined : { note }),
  declineHumanTask: (id: string, note: string) => post<{ ok: true }>(`/api/human-tasks/${id}/decline`, { note }),
  closeHumanTaskTicket: (id: string, note?: string) =>
    post<{ ok: true }>(`/api/human-tasks/${id}/close-ticket`, note === undefined ? undefined : { note }),
  dismissHumanTask: (id: string) => post<{ ok: true }>(`/api/human-tasks/${id}/dismiss`),
  decideRecovery: (taskId: string, verdict: RecoveryVerdict) =>
    post<{ ok: true; remaining: number }>(`/api/recovery/${taskId}`, { verdict }),
  checkBuild: () => post<{ ok: true; build: BuildReading }>('/api/upgrade/check'),
  pullProject: () => post<{ ok: true; build: BuildReading }>('/api/project/pull'),
  upgrade: (action: UpgradeAction, opts?: { interrupt?: boolean }) =>
    post<{ ok: true; build: BuildReading }>('/api/upgrade', { action, ...opts }),
  snoozeUpdate: (target: SnoozeTarget) => post<{ ok: true; build: BuildReading }>('/api/upgrade/snooze', { target }),
  startLocalRun: (issue: number, ref?: string) =>
    post<{ ok: true; run: LocalRunView }>('/api/local-run', { issue, ...(ref === undefined ? {} : { ref }) }),
  stopLocalRun: () => post('/api/local-run/stop'),
  messageLocalRun: (text: string) => post<{ ok: true }>('/api/local-run/message', { text }),
  refreshLocalRun: () => post<{ ok: true; run: LocalRunView }>('/api/local-run/refresh'),
  validateLocally: (issue: number, opts: { swap?: boolean; refresh?: boolean } = {}) =>
    post<{ ok: true; validation: LocalValidationView }>(`/api/issues/${String(issue)}/validate-locally`, opts),
  cancelLocalValidation: (issue: number) =>
    post<{ ok: true; validation: LocalValidationView }>(`/api/issues/${String(issue)}/validate-locally/cancel`),
  localRunOutput: () => authFetch('/api/local-run/output').then((r) => json<{ lines: string[] }>(r)),
  killAgent: (id: string) => post(`/api/agents/${id}/kill`),
  completeAgent: (id: string) => post(`/api/agents/${id}/complete`),
  interruptAgent: (id: string) => post(`/api/agents/${id}/interrupt`),
  resumeAgent: (id: string) => post(`/api/agents/${id}/resume`),
  extendStall: (id: string) => post<{ ok: true; expiresAt: string }>(`/api/agents/${id}/extend-stall`),
  ejectAgent: (id: string, reason: string) =>
    post<{ ok: true; ejection: Ejection }>(`/api/agents/${id}/eject`, { reason }),
  settleEjection: (id: string, outcome: EjectionOutcome, note?: string) =>
    post<{ ok: true; ejection: Ejection; jobId: string | null }>(`/api/ejections/${id}/settle`, { outcome, note }),
};

class ReconnectingWs {
  private ws: WebSocket | null = null;
  private closed = false;
  private backoff: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly subs = new Set<string>();
  private static readonly BASE = 500;
  private static readonly CAP = 8000;

  constructor(
    private readonly onEvent: (ev: unknown) => void,
    private readonly onStatus?: (connected: boolean) => void,
  ) {
    this.backoff = ReconnectingWs.BASE;
    this.open();
  }

  private open(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const query = token ? `?t=${encodeURIComponent(token)}` : '';
    const ws = new WebSocket(`${proto}://${location.host}/ws${query}`);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = ReconnectingWs.BASE;
      this.onStatus?.(true);
      for (const id of this.subs) this.rawSend({ type: 'subscribe', agentId: id });
    };
    ws.onmessage = (msg) => {
      try {
        this.onEvent(JSON.parse(msg.data as string));
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      this.onStatus?.(false);
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, ReconnectingWs.CAP);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) this.open();
    }, delay);
  }

  private rawSend(frame: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  subscribe(agentId: string): void {
    this.subs.add(agentId);
    this.rawSend({ type: 'subscribe', agentId });
  }

  unsubscribe(agentId: string): void {
    this.subs.delete(agentId);
    this.rawSend({ type: 'unsubscribe', agentId });
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      try {
        this.ws.close();
      } catch {
        /* noop */
      }
      this.ws = null;
    }
  }
}

export interface WsClient {
  subscribe(agentId: string): void;
  unsubscribe(agentId: string): void;
  close(): void;
}

function connectRealWs(onEvent: (ev: unknown) => void, onStatus?: (connected: boolean) => void): WsClient {
  return new ReconnectingWs(onEvent, onStatus);
}

const DEMO = typeof import.meta.env !== 'undefined' && import.meta.env.VITE_DEMO === '1';

export const isDemo = DEMO;
export const api = DEMO ? demoApi : realApi;
export const connectWs: typeof connectRealWs = DEMO ? connectDemoWs : connectRealWs;

export const injectDemoEvent: (event: unknown) => Promise<{ ok: true }> = DEMO
  ? demoApi.inject
  : () => Promise.reject(new Error('event injection is a demo-only control'));
