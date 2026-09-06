import type {
  AppState,
  BugFiling,
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
} from './types.js';
// The fetched-on-open routes, as whole payloads rather than shapes re-typed at each call
// site: a renamed or re-nested key is a compile error here instead of an empty panel.
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

/**
 * What `getReviewPack` answers: the pack, or its absence with whether an author is on its
 * way. A union rather than a thrown 404 — the absence is a state the row draws.
 */
export type ReviewPackReading = { kind: 'pack'; payload: ReviewPackPayload } | { kind: 'none'; writing: boolean };

/** Thrown when the server refuses the cockpit's credential. Every request goes through
 * {@link authFetch}, so there is exactly one place it can arise. */
export class UnauthorizedError extends Error {
  constructor(readonly status: number) {
    super(status === 403 ? 'Request refused by the cockpit' : 'Cockpit token missing or invalid');
    this.name = 'UnauthorizedError';
  }
}

const TOKEN_KEY = 'lubbdubb.cockpitToken';

/**
 * The cockpit's bearer token, taken from the `#t=` fragment the server prints at startup
 * and remembered thereafter. The fragment is the transport because a browser never sends
 * it to a server (no access log, no `Referer` leak); `localStorage`, not a cookie, so a
 * hostile page can't attach the credential to its own request.
 */
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
    // Storage can throw when cookies/site data are blocked; only persistence is lost.
    // This also catches the no-browser case, where `location` is undefined (the cockpit
    // imported under node) — an empty token is the right answer, not a crash at import.
    return typeof location === 'undefined' ? '' : (/[#&]t=([A-Za-z0-9_-]+)/.exec(location.hash)?.[1] ?? '');
  }
}

const token = readToken();

/** Every request to the harness, with the credential attached in one place. */
async function authFetch(url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  const res = await fetch(url, { ...init, headers });
  if (res.status === 401 || res.status === 403) throw new UnauthorizedError(res.status);
  return res;
}

async function json<T>(res: Response): Promise<T> {
  // A refusal carries the server's own words in `{error}`, and showing "400 Bad Request"
  // instead throws away the half that says what to do. The status line is the fallback
  // for a body that is not ours — a proxy's 502, fastify's own 413.
  if (!res.ok) throw new Error((await refusalText(res)) ?? `${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/** The server's `{error}` for a refused request, or null when the body isn't one. */
async function refusalText(res: Response): Promise<string | null> {
  try {
    const body: unknown = await res.json();
    const error = (body as { error?: unknown }).error;
    return typeof error === 'string' && error ? error : null;
  } catch {
    return null;
  }
}

/** POST a JSON body. Collapses the header/stringify boilerplate every action repeated. */
function post<T>(url: string, body?: unknown): Promise<T> {
  return authFetch(url, {
    method: 'POST',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  }).then((r) => json<T>(r));
}

/**
 * PUT a JSON body, and DELETE — a check is written at its own address and dropped from it,
 * which is what makes one verb enough for both a new one and an edit.
 */
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
  /**
   * The snapshot, whole or in named parts. `sections` is what a `dirty` frame said it
   * touched; `null` asks for the lot. A partial answer is merged over the state the
   * cockpit holds. → `docs/spec/16-http-api.md#sections`
   */
  getState: (sections?: ReadonlySet<StateSection> | null) =>
    authFetch(
      sections === undefined || sections === null ? '/api/state' : `/api/state?sections=${[...sections].join(',')}`,
    ).then((r) => json<Partial<AppState>>(r)),
  // Ranged: `from` is what the caller already holds, so the drawer's poll ships the tail.
  getTranscript: (agentId: string, from = 0) =>
    authFetch(`/api/agents/${agentId}/transcript${from > 0 ? `?from=${from}` : ''}`).then((r) =>
      json<AgentTranscript>(r),
    ),
  // The files one agent wrote. Fetched when a drawer opens and on its poll while the
  // agent is live — never shipped on `/api/state`, where it dominated the payload.
  getAgentFiles: (agentId: string) => authFetch(`/api/agents/${agentId}/files`).then((r) => json<AgentFilesPayload>(r)),
  // Every agent that has worked one goal, fetched when its page opens: the snapshot
  // carries only live agents and a bounded tail. `prs` names the pull requests the page
  // has already resolved as this goal's, a match the server does not copy.
  getGoalAgents: (ref: string, prs: readonly number[]) =>
    authFetch(
      `/api/issues/${/^issue:(\d+)$/.exec(ref)?.[1] ?? ''}/agents${prs.length > 0 ? `?prs=${prs.join(',')}` : ''}`,
    ).then((r) => json<GoalAgentsPayload>(r)),
  // The work graph is fetched, never polled: it only grows, so roots are read once on
  // mount and a subtree when one is opened.
  getWorkRoots: () => authFetch('/api/work').then((r) => json<WorkRootsPayload>(r)),
  getWorkSubtree: (ref: string) =>
    authFetch(`/api/work/${encodeURIComponent(ref)}`).then((r) => json<WorkSubtreePayload>(r)),
  // The Tickets tab's list: fetched when the tab opens and per page as it is scrolled,
  // never polled — the mirror is all-time and only grows.
  getTickets: (query: {
    watch: string;
    tracking: string;
    state: string;
    feature: string | null;
    order: string;
    cursor: string | null;
  }) => {
    // Defaults omitted, exactly as `placeQuery` omits them, so the URL an operator is
    // looking at and the request behind it are the same question.
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
  // The feature board, fetched when the tab opens and never polled — it reads the whole
  // mirror, as `/api/tickets` does. No query: narrowing is the Tickets tab one click down.
  getFeatures: () => authFetch('/api/features').then((r) => json<FeatureBoardPayload>(r)),
  // The operator answering a proposed story order. `declined` — 'run them all' — is a
  // real answer and is stored so the fleet stops asking. The row comes back whole.
  answerFeatureSequence: (number: number, answer: 'accepted' | 'declined', by: string) =>
    post<FeatureSequence>(`/api/features/${number}/sequence`, { answer, by }),
  // A goal's retrospective, fetched when the Manifest station is opened; the snapshot
  // carries only the summary, since a document per issue per poll is not affordable.
  getRetrospective: (ref: string) =>
    authFetch(`/api/retrospectives/${encodeURIComponent(ref)}`).then((r) => json<RetrospectivePayload>(r)),
  // The shared pad the agents on a goal wrote each other, fetched when a reader opens it.
  // `padOriginFor` resolves a subtree ref to its issue, so any origin on the goal works.
  getScratchpad: (ref: string) =>
    authFetch(`/api/scratchpads/${encodeURIComponent(ref)}`).then((r) => json<ScratchpadPayload>(r)),
  /**
   * A pull request's review pack with the reviewer's marks, or the fact that there is
   * none — and whether one is on its way. The 404 is an answer, not a failure: "not asked
   * for" and "being written" are two states, so it is read off the body rather than
   * thrown. → `docs/spec/31-review-packs.md#when-a-pack-is-made`
   */
  getReviewPack: (prNumber: number): Promise<ReviewPackReading> =>
    authFetch(`/api/prs/${prNumber}/review-pack`).then(async (r) => {
      if (r.status === 404) {
        const absence = (await r.json()) as ReviewPackAbsence;
        return { kind: 'none', writing: absence.writing === true };
      }
      return { kind: 'pack', payload: await json<ReviewPackPayload>(r) };
    }),
  /** Ask for a pack. `202` — the author is an agent run, and the pack arrives through the read above. */
  requestReviewPack: (prNumber: number) =>
    post<{ ok: true; prNumber: number; headSha: string }>(`/api/prs/${prNumber}/review-pack`),
  /**
   * Share the pack into the pool — a second, deliberate act, never part of asking for one.
   * `202`: the document goes out on the pool's own clock. A refusal is a 409 whose message
   * names the line the secret backstop stopped on.
   * → docs/spec/31-review-packs.md#sharing-a-pack
   */
  shareReviewPack: (prNumber: number) => post<ReviewPackSharing>(`/api/prs/${prNumber}/review-pack/share`),
  unshareReviewPack: (prNumber: number) => post<ReviewPackSharing>(`/api/prs/${prNumber}/review-pack/unshare`),
  markReviewIdeaRead: (prNumber: number, ideaId: string, read: boolean) =>
    post<ReviewMarksPayload>(`/api/prs/${prNumber}/review-pack/ideas/${encodeURIComponent(ideaId)}/read`, { read }),
  /**
   * The operator's reading over every pack — the overrides, the plumbing ratio and whether
   * false claims get read. Obeys the Insights page's window.
   */
  getReviewCalibration: (window: InsightsWindow) =>
    authFetch(`/api/review-calibration?window=${window}`).then((r) => json<ReviewCalibrationPayload>(r)),
  markReviewFindingSeen: (prNumber: number, ideaId: string, seen: boolean) =>
    post<ReviewMarksPayload>(`/api/prs/${prNumber}/review-pack/ideas/${encodeURIComponent(ideaId)}/seen`, { seen }),
  overrideReviewAttention: (prNumber: number, ideaId: string, attention: ReviewAttention | null) =>
    post<ReviewMarksPayload>(`/api/prs/${prNumber}/review-pack/ideas/${encodeURIComponent(ideaId)}/attention`, {
      attention,
    }),
  // The breakdown behind the cost indicators, fetched when the Spend panel opens: every
  // agent the harness has run, split by phase and by goal. The window is a parameter
  // rather than a per-route constant, or two tabs of one page would cover two stretches.
  getSpend: (window: InsightsWindow) => authFetch(`/api/spend?window=${window}`).then((r) => json<SpendPayload>(r)),
  // The trend, fetched when its tab is first opened: it reads *eight* windows of world
  // events on top of the same agent walk.
  getSpendTrend: (window: InsightsWindow) =>
    authFetch(`/api/spend/trend?window=${window}`).then((r) => json<SpendTrendPayload>(r)),
  // The allowance as a series, fetched on the Allowance tab's first visit for
  // `getSpendTrend`'s reason. Same window as everything else: the apportionment is a
  // percentage laid over the money the Economics tab prices.
  getAllowance: (window: InsightsWindow) =>
    authFetch(`/api/allowance?window=${window}`).then((r) => json<AllowancePayload>(r)),
  // What the spending bought. Same stance and window as the breakdown: read a tab apart,
  // they must describe one stretch of the fleet's life.
  getReliability: (window: InsightsWindow) =>
    authFetch(`/api/reliability?window=${window}`).then((r) => json<ReliabilityPayload>(r)),
  // The tool channel, fetched on the MCP tab's first visit for the trend's reason: the
  // naming evidence scans every dispatch prompt in the window, the one bulk read of
  // `tasks.prompt` in the harness.
  getMcpUsage: (window: InsightsWindow) =>
    authFetch(`/api/mcp/usage?window=${window}`).then((r) => json<McpUsagePayload>(r)),
  // The operator ledger and the reach beside it, on one payload over one window — a
  // pairing only if both describe the same stretch. Fetched on first visit for
  // `getMcpUsage`'s reason: it sweeps every settled-record table kept about a person.
  getUsage: (window: InsightsWindow) => authFetch(`/api/usage?window=${window}`).then((r) => json<UsagePayload>(r)),
  /**
   * The cockpit's batch of `ui` events — the one request here whose response is never read
   * and whose failure is of no consequence. Deliberately **not** through {@link json}:
   * letting `UnauthorizedError` out of a telemetry write would raise the session-expiry
   * banner over a lost metric. `keepalive` lets the unload flush outlive its document.
   */
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
  // The cross-fleet pool. **No window**: the digest's bucket is a UTC day with ninety
  // days' retention, so the question is a number of days rather than one of the page's
  // spans. It takes a project, because `byCheck` is only comparable inside one pipeline.
  getPoolInsights: (project: string | null) =>
    authFetch(`/api/pool/insights${project === null ? '' : `?project=${encodeURIComponent(project)}`}`).then((r) =>
      json<PoolInsightsPayload>(r),
    ),
  // The obstacle board. Fetched on its own tab rather than riding the snapshot: it is
  // every sighting's prose for every row. The four writes below are the operator's whole
  // arm on this store, and none is a step on a path the harness waits on — *every state
  // has an exit that is not you*.
  getObstacles: () => authFetch('/api/obstacles').then((r) => json<ObstacleBoardPayload>(r)),
  // Never tell the fleet this, or tell them again. The one state whose exit is a person.
  muteObstacle: (id: string, muted: boolean) =>
    post<{ ok: true }>(`/api/obstacles/${encodeURIComponent(id)}/mute`, { muted }),
  // A ticket you are already using. Takes the same `UPDATE … WHERE owner_ref IS NULL` the
  // ownership desk takes, so an operator racing the pulse is a constraint, not a rule.
  ownObstacle: (id: string, ownerRef: string) =>
    post<{ ok: true }>(`/api/obstacles/${encodeURIComponent(id)}/own`, { ownerRef }),
  // This is over and no reading is going to say so. **Not** rejecting: the row
  // keeps what it said, and a matching report reopens it.
  retireObstacle: (id: string) => post<{ ok: true }>(`/api/obstacles/${encodeURIComponent(id)}/retire`, {}),
  // Write a note into the repository now rather than when the endings desk reaches
  // it — one at a time across the whole fleet, whichever door asks.
  writeDownObstacle: (id: string) => post<{ ok: true }>(`/api/obstacles/${encodeURIComponent(id)}/write-up`, {}),
  // This fleet's own side of the pool, plus the mirror. Fetched rather than polled: it is
  // ninety days of rows per fleet.
  getPool: () => authFetch('/api/pool').then((r) => json<PoolStatePayload>(r)),
  // The prompt book, fetched on open: it is read once at boot, so polling it would be
  // paying for a constant.
  /**
   * What exists, what it costs and how often it turns up — the same bytes on every request
   * of a build, so the Pets page fetches it once on open rather than off the snapshot.
   */
  getPetCatalogue: () => authFetch('/api/pets/catalogue').then((r) => json<PetCatalogue>(r)),

  getPrompts: () => authFetch('/api/prompts').then((r) => json<PromptsPayload>(r)),
  // What the harness can say about its own configuration without being asked. Fetched on
  // open and after a write, never polled: it shells out to git and the agent binary.
  getSetup: () => authFetch('/api/setup').then((r) => json<SetupPayload>(r)),
  // The two answers, read into everything they imply. A POST for a read because the
  // answers are a body; it writes nothing.
  resolveSetup: (answers: { email: string; repoRoot: string }) =>
    post<SetupResolvePayload>('/api/setup/resolve', answers),
  // The running config, fetched on open: `loadConfig` runs once at boot, so this cannot
  // change while the tab is up.
  getConfig: () => authFetch('/api/config').then((r) => json<RunningConfigPayload>(r)),
  // Save it. `baseline` is the revision the form was built from, so a file that moved
  // underneath refuses the save rather than being clobbered.
  saveConfig: (edits: { set?: Record<string, unknown>; clear?: string[]; baseline: string }) =>
    post<ConfigSavePayload>('/api/config', edits),
  // Pause dispatch and hand this process off to the supervisor, so a restart-only change
  // takes effect. Refused where there is no supervisor, or agents are still running.
  restartHarness: (interrupt: boolean) => post<{ ok: true }>('/api/config/restart', { interrupt }),
  // The same ladder a save walks, stopping short of the write. The review step draws its
  // diff from this rather than splicing the file itself, which would be free to disagree
  // with the splice that writes.
  previewConfig: (edits: { set?: Record<string, unknown>; clear?: string[]; text?: string; baseline: string }) =>
    post<ConfigPreviewPayload>('/api/config/preview', edits),
  // The whole file, written by hand. Refused by the loader exactly as a save is.
  saveRawConfig: (edits: { text: string; baseline: string }) => post<ConfigSavePayload>('/api/config/raw', edits),
  // The effective CI policy behind the settings modal's CI tab, derived on the server
  // from the same defaults `classifyCiFailures` reads.
  getCiPolicy: () => authFetch('/api/ci-policy').then((r) => json<CiPolicyPayload>(r)),
  // How to register this harness with the operator's own Claude Code, read off the running
  // desktop channel rather than written down in the tab that draws it.
  getMcp: () => authFetch('/api/mcp').then((r) => json<McpChannelPayload>(r)),
  // Ask an agent to create a tracker item for work nothing external accounts for. An
  // operator's click, never a rule — see src/graph/unrecorded.ts.
  fileWorkItem: (ref: string) => post(`/api/work/${encodeURIComponent(ref)}/file`),
  // The other verdict: no ticket is wanted. `ignored: false` is a DELETE, so "not
  // ignored" keeps one representation.
  setWorkItemIgnored: (ref: string, ignored: boolean) =>
    ignored
      ? post(`/api/work/${encodeURIComponent(ref)}/ignore`)
      : authFetch(`/api/work/${encodeURIComponent(ref)}/ignore`, { method: 'DELETE' }).then((r) =>
          json<{ ok: true }>(r),
        ),
  pulse: () => post('/api/pulse'),
  // Clears the fault log for every cockpit, not just this one: the rows go.
  clearErrors: () => post<{ ok: true; cleared: number }>('/api/errors/clear'),
  answerEscalation: (id: string, response: string) => post(`/api/escalations/${id}/answer`, { response }),
  // A questionnaire's answers go up as a list and are folded into the agent's one reply by
  // the server: the wording an agent is answered in is a domain rule.
  answerQuestions: (id: string, answers: (string | null)[]) => post(`/api/escalations/${id}/answer`, { answers }),
  // Clear an item without answering it, for when the thing was handled outside the
  // harness. The server picks the right "no" per kind so nothing is left blocked.
  dismissEscalation: (id: string, note?: string) =>
    post<{ ok: true; dismissedAs: string }>(`/api/escalations/${id}/dismiss`, { note }),
  // Allow or deny a permission request an agent is blocked on. The same live agent then
  // continues or gets the denial — no config-and-restart.
  decidePermission: (id: string, allow: boolean, note?: string) =>
    post<{ ok: true; allowed: boolean }>(`/api/escalations/${id}/permission`, { allow, note }),
  // Accepting is what performs the act, through the same seam auto-send would have used;
  // rejecting sends nothing and is durable. `acknowledged` is the caveat ids the operator
  // ticked — the route refuses the accept while a plan's caveats are unticked, so the list
  // travels with the verdict rather than being asserted by the glass.
  acceptProposal: (id: string, note?: string, acknowledged?: string[]) =>
    post<{ ok: boolean; detail: string }>(`/api/proposals/${id}/accept`, { note, acknowledged }),
  rejectProposal: (id: string, note?: string) =>
    post<{ ok: boolean; detail: string }>(`/api/proposals/${id}/reject`, { note }),
  // Backing out of a plan verdict: the ticket is closed with the operator's comment, or
  // un-watched. Not a rejection, which would ask for a different plan for an unwanted goal.
  backOutProposal: (id: string, verdict: 'close' | 'hold', note?: string) =>
    post<{ ok: boolean; detail: string }>(`/api/proposals/${id}/back-out`, { verdict, note }),
  respondAgent: (id: string, text: string) => post(`/api/agents/${id}/respond`, { text }),
  setControl: (patch: { cap?: number; paused?: boolean }) =>
    post<{ ok: true; cap: number; paused: boolean }>('/api/control', patch),
  setPrWatched: (prNumber: number, watched: boolean) =>
    post<{ ok: true; watched: boolean }>(`/api/prs/${prNumber}/watch`, { watched }),
  // Land a whole chain: one standing authorization that keeps accepting each rung's merge
  // as the harness proposes it. A DELETE calls it off — the store's undo is a settlement,
  // not a second flag.
  setStackLanding: (ref: string, landing: boolean) =>
    landing
      ? post<{ ok: true; landing: StackLanding }>(`/api/stacks/${encodeURIComponent(ref)}/land`)
      : authFetch(`/api/stacks/${encodeURIComponent(ref)}/land`, { method: 'DELETE' }).then((r) =>
          json<{ ok: true; landing: StackLanding }>(r),
        ),
  setIssueWatched: (issueNumber: number, watched: boolean) =>
    post<{ ok: true; watched: boolean }>(`/api/issues/${issueNumber}/watch`, { watched }),
  // Move a work item to one of the tracker's own states — the board's drag. The route
  // validates no state word: the provider owns its process template.
  setIssueState: (issueNumber: number, state: string) =>
    post<{ ok: true; state: string }>(`/api/issues/${issueNumber}/state`, { state }),
  // Put this goal at the front of the queue, or take it back out. It re-orders and never
  // un-holds.
  setGoalPriority: (issueNumber: number, priority: boolean) =>
    post<{ ok: true; priority: boolean }>(`/api/issues/${issueNumber}/priority`, { priority }),
  // Pin this goal's work to a model profile, or clear the pin. The same call answers a
  // standing proposal from the appraiser either way: the route settles the question on any
  // write, which makes "keep mine" a decision rather than a refusal to answer.
  setIssueProfile: (issueNumber: number, profile: string | null) =>
    post<{ ok: true }>(`/api/issues/${issueNumber}/profile`, { profile: profile ?? '' }),
  // Settle where this goal belongs on the backlog — the container it hangs off, and the
  // area node that puts it on a board. `null` is the third answer, "this goal wants no
  // such thing"; the route does not distinguish the appraisal's proposal from the
  // operator's own value.
  setIssueParent: (issueNumber: number, parent: number | null) =>
    post<{ ok: true }>(`/api/issues/${issueNumber}/parent`, parent === null ? {} : { parent }),
  setIssueAreaPath: (issueNumber: number, areaPath: string | null) =>
    post<{ ok: true }>(`/api/issues/${issueNumber}/area-path`, { areaPath: areaPath ?? '' }),
  // Override which profile one plan part runs on. Clearing it makes the part inherit the
  // goal's pin again, which is not the same as naming the goal's current profile.
  setPartProfile: (planId: string, slug: string, profile: string | null) =>
    post<{ ok: true }>(`/api/plans/${planId}/part-profile`, { slug, profile: profile ?? '' }),
  // Restart one plan part: close the superseded pull request, drop its branch, and put
  // the part back to `ready`. Every refusal is a 400 with the reason in it.
  restartPart: (planId: string, slug: string) =>
    post<{ ok: true; detail: string }>(`/api/plans/${planId}/restart-part`, { slug }),
  // The operator's override of whether an issue is finished. `null` clears it,
  // returning the issue to whatever its agent or its plan says.
  setIssueConclusion: (issueNumber: number, verdict: 'done' | 'more_work' | null) =>
    post<{ ok: true }>(`/api/issues/${issueNumber}/conclusion`, { verdict }),
  // Tell the fleet what to do on this goal, in the operator's own words. It writes the
  // instruction *and* restarts the goal — one act, because the words without a next
  // dispatch reach nobody.
  addInstruction: (issueNumber: number, text: string) =>
    post<{ ok: true }>(`/api/issues/${issueNumber}/instruction`, { text }),
  // Overrule a standing shortfall: the assessment is wrong, and this is why. It records
  // the delivery — clearing the shortfall, parking the assessor, releasing the
  // retrospective — and files the same words as an instruction. 409 when none stands.
  overruleShortfall: (issueNumber: number, text: string) =>
    post<{ ok: true }>(`/api/issues/${issueNumber}/shortfall/overrule`, { text }),
  // Stop waiting on an environment for this goal, or put it back to waiting. The note is
  // required on the release: it is the only account of why a goal closed out unconfirmed.
  releaseEnvironmentGate: (issueNumber: number, released: boolean, note?: string) =>
    post<{ ok: true }>(`/api/issues/${issueNumber}/environment-gate`, { released, note }),
  // Take one back. Withdrawing the last one clears the `more_work` it wrote with it, so
  // the goal is not bounced back to pickup for words nobody will read.
  /**
   * Put a review thread back in front of the fleet, or take the ask back. A store mark and
   * never a write to the provider — the reviewer's thread is left as they left it.
   */
  reopenPrThread: (prNumber: number, threadId: string, reopened: boolean) =>
    post<{ ok: true }>(`/api/prs/${prNumber}/threads/${encodeURIComponent(threadId)}/reopen`, { reopened }),
  withdrawInstruction: (issueNumber: number, id: string) =>
    authFetch(`/api/issues/${issueNumber}/instruction/${id}`, { method: 'DELETE' }).then((r) =>
      json<{ ok: true; standing: number }>(r),
    ),
  // The operator's override of the intake verdict. `unclear` is the one reading that
  // blocks dispatch, so this is that gate's escape hatch; `null` clears it, which is a
  // delete and not a synonym for `workable`.
  setIssueAppraisal: (issueNumber: number, verdict: 'workable' | 'unclear' | null) =>
    post<{ ok: true }>(`/api/issues/${issueNumber}/appraisal`, { verdict }),
  // Raise a bug against a story. Unlike its neighbours this files into the *tracker*
  // rather than the harness's own record, and leaves the story's verdict alone — the bug
  // is its own work item and carries the work.
  raiseBug: (issueNumber: number, summary: string, title?: string) =>
    post<{ ok: true; filing: BugFiling }>(`/api/issues/${issueNumber}/bug`, { summary, title }),
  // Where an issue raised from the cockpit would land, and as whom — asked of the `gh` CLI
  // on the modal opening, deliberately not on `/api/state`. A logged-out CLI is a 200
  // carrying `available: false`, so this rejects only when the probe route is unreachable.
  probeFilingTarget: () => authFetch('/api/issues/filing-target').then((r) => json<FilingTargetProbe>(r)),
  // The operator's own report about LubbDubb, filed onto its own tracker and never the
  // one the fleet is pointed at. No desk agent between the click and the create — the
  // operator already wrote it up. `watch` decides whether the fleet picks it up, honoured
  // only on the deployment that works this repo itself.
  raiseIssue: (title: string, body: string, watch: boolean) => post<IssueFiled>('/api/issues', { title, body, watch }),
  // End the harness's run at a goal. A run is retained so its report stays reachable;
  // this is the one thing that ends it, it survives a restart, and it stops the dispatcher
  // acting on the goal. The note is refused as absent while the goal's validation plan is
  // flagged, and is kept on the run.
  dismissRun: (issueNumber: number, note?: string) =>
    post<{ ok: true; cleared: RunClearOut }>(
      `/api/issues/${issueNumber}/dismiss-run`,
      note === undefined ? undefined : { note },
    ),
  replan: (planId: string) => post<{ ok: true }>(`/api/plans/${planId}/replan`),
  // The operator's ruling on a check an agent declared. Accepting is also what first puts
  // the query to an environment, with their own credential.
  ruleWatchProposal: (issueNumber: number, checkId: string, accept: boolean) =>
    post<{ ok: true }>(`/api/issues/${issueNumber}/watch-proposals/${encodeURIComponent(checkId)}`, { accept }),
  // The operator's own check, written or re-written. One verb for both, and it runs the
  // dry run in the same call, so `dryRun` is what the environment refused.
  saveWatchCheck: (issueNumber: number, check: GoalWatchDeclaration) =>
    put<{ ok: true; dryRun: string[] }>(
      `/api/issues/${issueNumber}/watch/checks/${encodeURIComponent(check.id)}`,
      check,
    ),
  deleteWatchCheck: (issueNumber: number, checkId: string) =>
    del<{ ok: true }>(`/api/issues/${issueNumber}/watch/checks/${encodeURIComponent(checkId)}`),
  // Give a window more time. It re-opens the window it names rather than opening a second
  // one, so readings already taken stay in front of the ones to come.
  extendWatch: (issueNumber: number, environment: string) =>
    post<{ ok: true }>(`/api/issues/${issueNumber}/watch/${encodeURIComponent(environment)}/extend`),
  // A plan's revisions and the last amendment as a diff, fetched when the sheet is opened
  // and never polled: every revision carries a write-up.
  getPlanHistory: (planId: string) => authFetch(`/api/plans/${planId}/history`).then((r) => json<PlanHistory>(r)),
  // A reviewer's confirmation that one acceptance criterion holds. Keyed on the
  // criterion's text: an index would move under a re-worded list and carry the tick onto
  // something nobody looked at.
  setAcceptance: (planId: string, slug: string, criterion: string, met: boolean) =>
    post<{ ok: true }>(`/api/plans/${planId}/acceptance`, { slug, criterion, met }),
  // What an operator concluded about one validation check — a result, a deferral, a
  // waiver, or the reset that withdraws any of them. One call, because there is one thing
  // being said, and the server clears whatever the last one left behind.
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
  // Re-order the "Up next" queue: the operator's desired priority order of candidate
  // origins, which the dispatcher reads back into its ranking.
  reorderUpNext: (origins: string[]) => post<{ ok: true }>('/api/upnext/order', { origins }),
  // Price one queued row: which profile the next dispatch on this origin runs on. `null`
  // clears the override and the row goes back to its goal's pin, or its rule's entry.
  setUpNextProfile: (origin: string, profile: string | null) =>
    post<{ ok: true }>('/api/upnext/profile', { origin, profile: profile ?? '' }),
  // `attachments` carry base64 image bytes, which is why this one route may send
  // megabytes. The size/format bounds are the server's alone — the composer refuses early
  // to save a round trip, never instead of the server.
  launchJob: (job: {
    prompt: string;
    title?: string;
    kind?: string;
    branch?: string | null;
    attachments?: JobAttachmentInput[];
  }) => post<{ ok: true }>('/api/jobs', job),
  cancelJob: (id: string) => post<{ ok: true }>(`/api/jobs/${id}/cancel`),
  // Recurrences. A schedule queues the same job the composer above does, so everything
  // these four calls can cause is a job in the queue.
  createSchedule: (schedule: { cron: string; prompt: string; title?: string; kind?: string }) =>
    post<{ ok: true }>('/api/schedules', schedule),
  updateSchedule: (
    id: string,
    patch: { cron?: string; prompt?: string; title?: string; kind?: string; enabled?: boolean },
  ) => post<{ ok: true }>(`/api/schedules/${id}`, patch),
  // Fire one now, without waiting for its slot and without moving it.
  runSchedule: (id: string) => post<{ ok: true }>(`/api/schedules/${id}/run`),
  deleteSchedule: (id: string) =>
    authFetch(`/api/schedules/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: true }>(r)),
  // A finding becomes work only here: the operator's click is the gate, because an agent
  // that could queue jobs could put agents on the fleet.
  promoteFinding: (id: string) => post<{ ok: true }>(`/api/findings/${id}/promote`),
  // The defer arm: a desk agent files it in the tracker, so the work waits its turn there
  // rather than on the fleet.
  fileFinding: (id: string) => post<{ ok: true }>(`/api/findings/${id}/file`),
  dismissFinding: (id: string) => post<{ ok: true }>(`/api/findings/${id}/dismiss`),

  // The vivarium. No read arm: `PetState` rides on `/api/state`.
  openPet: (id: string) => post<{ ok: true }>(`/api/pets/${id}/open`, {}),
  feedPet: (id: string, beats: number) => post<{ ok: true }>(`/api/pets/${id}/feed`, { beats }),
  renamePet: (id: string, name: string) => post<{ ok: true }>(`/api/pets/${id}/name`, { name }),
  placePet: (id: string, placed: boolean) => post<{ ok: true }>(`/api/pets/${id}/place`, { placed }),
  blendPet: (id: string) => post<{ ok: true }>(`/api/pets/${id}/blend`, {}),

  // Work only a person can do. `done` settles it and concludes any plan step it backs,
  // releasing whatever was waiting; `decline` deliberately does not, so nothing downstream
  // starts. `note` is omitted rather than sent empty — the route reads absence.
  completeHumanTask: (id: string, note?: string) =>
    post<{ ok: true }>(`/api/human-tasks/${id}/done`, note === undefined ? undefined : { note }),
  declineHumanTask: (id: string, note: string) => post<{ ok: true }>(`/api/human-tasks/${id}/decline`, { note }),
  // Close the tracker item the close-out row names, and settle the row with it. The
  // obligation is the close, so this is the act rather than a third verdict.
  closeHumanTaskTicket: (id: string, note?: string) =>
    post<{ ok: true }>(`/api/human-tasks/${id}/close-ticket`, note === undefined ? undefined : { note }),
  // Off the bench. Settled rows only — it says nothing about the work.
  dismissHumanTask: (id: string) => post<{ ok: true }>(`/api/human-tasks/${id}/dismiss`),
  // Decide what happens to work the last run left orphaned. Until every one is answered
  // the harness runs no cycles, so this is the one call that can un-stick a frozen-looking
  // fleet. Keyed on the **task**: an orphan may never have had an agent at all.
  decideRecovery: (taskId: string, verdict: RecoveryVerdict) =>
    post<{ ok: true; remaining: number }>(`/api/recovery/${taskId}`, { verdict }),
  // The harness's own build. `upgrade('apply')` ends the process it is talking to, so a
  // dropped connection after it is the expected outcome; the reconnect reports the new
  // build.
  checkBuild: () => post<{ ok: true; build: BuildReading }>('/api/upgrade/check'),
  // The one call here that *writes* to a repository — a fast-forward of the worked
  // checkout, which is how the project layer of the config arrives.
  pullProject: () => post<{ ok: true; build: BuildReading }>('/api/project/pull'),
  upgrade: (action: UpgradeAction, opts?: { interrupt?: boolean }) =>
    post<{ ok: true; build: BuildReading }>('/api/upgrade', { action, ...opts }),
  // Hide one of the two update asks on the rail for a while. Its own route rather than a
  // fourth `action`: that one drives the upgrade state machine, a snooze changes nothing.
  snoozeUpdate: (target: SnoozeTarget) => post<{ ok: true; build: BuildReading }>('/api/upgrade/snooze', { target }),
  // The machine's one dev environment. `startLocalRun` is also the swap: there is one
  // environment, and the transition lives on the server, not in two calls from here.
  startLocalRun: (issue: number, ref?: string) =>
    post<{ ok: true; run: LocalRunView }>('/api/local-run', { issue, ...(ref === undefined ? {} : { ref }) }),
  stopLocalRun: () => post('/api/local-run/stop'),
  // Type into the session holding the environment, and move its checkout to the tip of
  // its branch. Neither takes an id: there is one run.
  messageLocalRun: (text: string) => post<{ ok: true }>('/api/local-run/message', { text }),
  refreshLocalRun: () => post<{ ok: true; run: LocalRunView }>('/api/local-run/refresh'),
  // Its own fetch rather than a field on the snapshot: two hundred lines on every
  // heartbeat is a log nobody has open, paid for forever.
  //
  // Validating a goal against that environment: bring its code up and put one agent on
  // driving it. `swap` is the operator's consent to taking the environment from another
  // goal — without it the server answers 409 with what is running. `refresh` moves the
  // checkout to the tip first, which is never automatic.
  validateLocally: (issue: number, opts: { swap?: boolean; refresh?: boolean } = {}) =>
    post<{ ok: true; validation: LocalValidationView }>(`/api/issues/${String(issue)}/validate-locally`, opts),
  cancelLocalValidation: (issue: number) =>
    post<{ ok: true; validation: LocalValidationView }>(`/api/issues/${String(issue)}/validate-locally/cancel`),
  localRunOutput: () => authFetch('/api/local-run/output').then((r) => json<{ lines: string[] }>(r)),
  killAgent: (id: string) => post(`/api/agents/${id}/kill`),
  completeAgent: (id: string) => post(`/api/agents/${id}/complete`),
  interruptAgent: (id: string) => post(`/api/agents/${id}/interrupt`),
  // End a usage-limit park: re-opens the agent's own conversation in its own worktree and
  // tells it to carry on. 409s for an agent parked on anything else.
  resumeAgent: (id: string) => post(`/api/agents/${id}/resume`),
  // Push a stall park's countdown out by `agentStallExtendMs`. 409s for an agent with no
  // countdown running.
  extendStall: (id: string) => post<{ ok: true; expiresAt: string }>(`/api/agents/${id}/extend-stall`),
};

/**
 * Reconnecting live-event socket. Opens `ws(s)://host/ws`, auto-reconnects with
 * exponential backoff on unexpected close/error, and re-asserts the desired set
 * of agent subscriptions on every (re)connect so a drawer keeps streaming across
 * a dropped connection. Call `.close()` to tear it down permanently.
 */
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
    // The token goes in the query string, not a header: the browser WebSocket API exposes
    // no way to set one on the upgrade request. Weaker in general, but this connection is
    // to loopback and traverses no proxy.
    const query = token ? `?t=${encodeURIComponent(token)}` : '';
    const ws = new WebSocket(`${proto}://${location.host}/ws${query}`);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = ReconnectingWs.BASE; // reset backoff on a good connection
      this.onStatus?.(true);
      // Re-send every desired subscription so they survive reconnects.
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
      // Let onclose drive the reconnect; force the socket shut if it lingers.
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

  /** Send a frame only if the socket is currently OPEN; otherwise no-op. */
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

  /** Tear down permanently — stops reconnection. */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null; // don't schedule a reconnect for our own close
      try {
        this.ws.close();
      } catch {
        /* noop */
      }
      this.ws = null;
    }
  }
}

/** The narrow socket surface the cockpit uses — satisfied by both the real
 * reconnecting socket and the demo's in-browser fake. */
export interface WsClient {
  subscribe(agentId: string): void;
  unsubscribe(agentId: string): void;
  close(): void;
}

/** Open the reconnecting live event socket. */
function connectRealWs(onEvent: (ev: unknown) => void, onStatus?: (connected: boolean) => void): WsClient {
  return new ReconnectingWs(onEvent, onStatus);
}

// The Pages demo runs the SPA against an in-browser fake backend. `VITE_DEMO=1`
// (web/.env.demo) is baked in at build time and dead-code-eliminates the demo path out of
// the production bundle. The `typeof` guard is for node, where there is no
// `import.meta.env` at all and a bare access throws at import.
//
// If you change the shape of this expression, check both build directions by grepping for
// a *string literal* from the fixtures (`buildDemoState` is minified to one letter):
//   npm run web:build       → must NOT contain "Reworking the policy-evaluation"
//   npm run web:build:demo  → must contain it
const DEMO = typeof import.meta.env !== 'undefined' && import.meta.env.VITE_DEMO === '1';

/** True when running against the fake backend (the GitHub Pages demo build). */
export const isDemo = DEMO;
export const api = DEMO ? demoApi : realApi;
export const connectWs: typeof connectRealWs = DEMO ? connectDemoWs : connectRealWs;

/**
 * Faking a world change is a **demo** control, off the `api` seam rather than on it: the
 * server has no route behind it, and a button that told the harness something had happened
 * would be a way to lie to yourself. The rejecting arm is unreachable rather than
 * defensive, but a silent no-op would leave the panel reporting success.
 */
export const injectDemoEvent: (event: unknown) => Promise<{ ok: true }> = DEMO
  ? demoApi.inject
  : () => Promise.reject(new Error('event injection is a demo-only control'));
