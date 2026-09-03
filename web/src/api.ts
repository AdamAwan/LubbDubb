import type {
  AppState,
  BugFiling,
  GoalWatchDeclaration,
  BuildReading,
  InsightsWindow,
  JobAttachmentInput,
  LocalRunView,
  RecoveryVerdict,
  StackLanding,
  StateSection,
  UpgradeAction,
} from './types.js';
// The fetched-on-open routes, as whole payloads rather than shapes re-typed at
// each call site: the server declares each one as its return type, so a renamed
// or re-nested key is a compile error here instead of an empty panel.
import type {
  AgentFilesPayload,
  AllowancePayload,
  GoalAgentsPayload,
  AgentTranscript,
  CiPolicyPayload,
  FilingTargetProbe,
  IssueFiled,
  ContradictionRuling,
  FactExit,
  FactRuling,
  GraduationOutcome,
  KnowledgeFactPayload,
  PetCatalogue,
  PlanHistory,
  McpChannelPayload,
  McpUsagePayload,
  ObstacleBoardPayload,
  PoolInsightsPayload,
  PoolStatePayload,
  PromptsPayload,
  ProposalCommentDraft,
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
  WorkSubtreePayload,
} from '../../src/wire.js';
import { demoApi, connectDemoWs } from './demo/demoBackend.js';

/**
 * Thrown when the server refuses the cockpit's credential, so `App` can render
 * the one screen that tells the operator what to do instead of retrying forever.
 * A distinct type rather than a status check at each call site: every request
 * goes through {@link authFetch}, so there is exactly one place it can arise.
 */
/**
 * What `getReviewPack` answers: the pack, or its absence with whether an author
 * is on its way. A union rather than a thrown 404 because the absence is a state
 * the pull request's row draws, not an error it reports.
 */
export type ReviewPackReading = { kind: 'pack'; payload: ReviewPackPayload } | { kind: 'none'; writing: boolean };

export class UnauthorizedError extends Error {
  constructor(readonly status: number) {
    super(status === 403 ? 'Request refused by the cockpit' : 'Cockpit token missing or invalid');
    this.name = 'UnauthorizedError';
  }
}

const TOKEN_KEY = 'lubbdubb.cockpitToken';

/**
 * The cockpit's bearer token, taken from the `#t=` fragment the server prints at
 * startup and remembered thereafter.
 *
 * **The fragment is the transport because a browser never sends it to a server** —
 * it stays client-side, so it cannot land in an access log, a `Referer` header or
 * a proxy trace the way a query parameter would. It is stripped from the address
 * bar immediately so a copied URL is not a copied credential.
 *
 * **`localStorage`, not a cookie, and that is the security property, not a
 * convenience.** A cookie is attached by the browser to any request that reaches
 * this origin — including one a hostile page makes — which is exactly what forces
 * cookie-based auth to invent CSRF tokens. A value the page must read and attach
 * itself cannot be used by a page that cannot read it, and origin-scoped storage
 * is unreadable both to another site and to the CSP-sandboxed artifact frames
 * (which have an opaque origin). `localStorage` over `sessionStorage` so a second
 * tab and a browser restart keep working; the difference only matters given an
 * XSS in the cockpit itself, and an attacker with script execution here can call
 * the API directly regardless of where the token sits.
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
    // Storage can throw when cookies/site data are blocked. The in-memory token
    // from this page load still works; only persistence is lost.
    //
    // This also catches the no-browser case: `location` is simply undefined when
    // the cockpit is imported under node, which is how `test/console.test.ts`
    // renders the console to static markup. There is no token to find there, nothing will
    // be fetched, so an empty one is the right answer rather than a crash at import.
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
  // A refusal carries the server's own words in `{error}` (every route refuses
  // that way — see `src/server/validation.ts`), and a caller that shows the
  // operator "400 Bad Request" instead is throwing away the only half that says
  // what to do about it. The status line stays as the fallback for a body that
  // isn't ours — a proxy's 502, fastify's own 413.
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
 * PUT a JSON body, and DELETE.
 *
 * Beside {@link post} rather than spelled out at the call sites for its reason —
 * and because a route whose verb *is* its meaning should read that way here: a
 * check is written at its own address and dropped from it, which is what makes one
 * verb enough for both a new one and an edit.
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
   * The snapshot, whole or in named parts.
   *
   * `sections` is what a `dirty` frame said it touched; `null` asks for the lot,
   * which is the first load and any signal that could not say. A partial answer is
   * merged over the state the cockpit holds — see `useCockpit`.
   * → `docs/spec/16-http-api.md#sections`
   */
  getState: (sections?: ReadonlySet<StateSection> | null) =>
    authFetch(
      sections === undefined || sections === null ? '/api/state' : `/api/state?sections=${[...sections].join(',')}`,
    ).then((r) => json<Partial<AppState>>(r)),
  // Ranged: `from` is what the caller already holds, so the drawer's five-second
  // poll ships the tail rather than the whole record each time (issue #639).
  getTranscript: (agentId: string, from = 0) =>
    authFetch(`/api/agents/${agentId}/transcript${from > 0 ? `?from=${from}` : ''}`).then((r) =>
      json<AgentTranscript>(r),
    ),
  // The files one agent wrote. Fetched when a drawer opens, and again on its poll
  // while the agent is live — never shipped on `/api/state`, where the whole-fleet
  // list it replaces was 87% of the payload.
  getAgentFiles: (agentId: string) => authFetch(`/api/agents/${agentId}/files`).then((r) => json<AgentFilesPayload>(r)),
  // Every agent that has worked one goal, fetched when its page opens. The
  // snapshot carries the fleet's live agents and a bounded tail of ended ones, so
  // this is where a goal's older runs come from — `prs` names the pull requests
  // the page has already resolved as this goal's, which is the match the server
  // deliberately does not make a second copy of.
  getGoalAgents: (ref: string, prs: readonly number[]) =>
    authFetch(
      `/api/issues/${/^issue:(\d+)$/.exec(ref)?.[1] ?? ''}/agents${prs.length > 0 ? `?prs=${prs.join(',')}` : ''}`,
    ).then((r) => json<GoalAgentsPayload>(r)),
  // The work graph is fetched, never polled: `/api/state` comes round every couple
  // of seconds and the graph only ever grows, so the roots are read once on mount
  // and a subtree when one is opened.
  getWorkRoots: () => authFetch('/api/work').then((r) => json<WorkRootsPayload>(r)),
  getWorkSubtree: (ref: string) =>
    authFetch(`/api/work/${encodeURIComponent(ref)}`).then((r) => json<WorkSubtreePayload>(r)),
  // The Tickets tab's list: fetched when the tab opens and again per page as it is
  // scrolled, never polled — the mirror is all-time and only grows. Defaults are
  // omitted from the query string so a bare call and a bare `?tab=tickets` are the
  // same request.
  getTickets: (query: {
    watch: string;
    tracking: string;
    state: string;
    feature: string | null;
    order: string;
    cursor: string | null;
  }) => {
    // Defaults omitted, exactly as `placeQuery` omits them, so the URL an operator
    // is looking at and the request behind it are the same question.
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
  // The feature board, fetched when the tab opens and never polled — it reads the
  // whole mirror, exactly as `/api/tickets` does. No query: the board is the whole
  // of what the tracker's hierarchy holds, and the narrowing an operator wants is
  // the Tickets tab one click down.
  getFeatures: () => authFetch('/api/features').then((r) => json<FeatureBoardPayload>(r)),
  // A goal's retrospective, fetched when the Manifest station is opened. The
  // snapshot carries only the summary, for the reason the work graph is not
  // polled: a document per issue on every poll pays for the feature in bandwidth.
  getRetrospective: (ref: string) =>
    authFetch(`/api/retrospectives/${encodeURIComponent(ref)}`).then((r) => json<RetrospectivePayload>(r)),
  // The shared pad the agents on a goal wrote each other, fetched when a reader
  // opens it — the snapshot carries only how much is there. `padOriginFor` on the
  // server resolves a subtree ref to its issue, so any origin on the goal works.
  getScratchpad: (ref: string) =>
    authFetch(`/api/scratchpads/${encodeURIComponent(ref)}`).then((r) => json<ScratchpadPayload>(r)),
  /**
   * A pull request's review pack with the reviewer's marks, or the fact that
   * there is none — and whether one is on its way. The 404 is an answer here, not
   * a failure: "not asked for" and "being written" are two states the row draws
   * differently, so it is read off the body rather than thrown.
   * → `docs/spec/31-review-packs.md#when-a-pack-is-made`
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
   * Share the pack into the pool — the second, deliberate act, never part of
   * asking for one. `202`: the document goes out on the pool's own clock, and the
   * page watches the share's state through the read above. A refusal is a 409
   * whose message names the line the secret backstop stopped on.
   * → docs/spec/31-review-packs.md#sharing-a-pack
   */
  shareReviewPack: (prNumber: number) => post<ReviewPackSharing>(`/api/prs/${prNumber}/review-pack/share`),
  unshareReviewPack: (prNumber: number) => post<ReviewPackSharing>(`/api/prs/${prNumber}/review-pack/unshare`),
  markReviewIdeaRead: (prNumber: number, ideaId: string, read: boolean) =>
    post<ReviewMarksPayload>(`/api/prs/${prNumber}/review-pack/ideas/${encodeURIComponent(ideaId)}/read`, { read }),
  /**
   * The operator's reading over every pack — the overrides, the plumbing ratio
   * and whether false claims get read. Obeys the Insights page's window.
   */
  getReviewCalibration: (window: InsightsWindow) =>
    authFetch(`/api/review-calibration?window=${window}`).then((r) => json<ReviewCalibrationPayload>(r)),
  markReviewFindingSeen: (prNumber: number, ideaId: string, seen: boolean) =>
    post<ReviewMarksPayload>(`/api/prs/${prNumber}/review-pack/ideas/${encodeURIComponent(ideaId)}/seen`, { seen }),
  overrideReviewAttention: (prNumber: number, ideaId: string, attention: ReviewAttention | null) =>
    post<ReviewMarksPayload>(`/api/prs/${prNumber}/review-pack/ideas/${encodeURIComponent(ideaId)}/attention`, {
      attention,
    }),
  // The breakdown behind the cost indicators, fetched when the Spend panel opens.
  // The snapshot already carries what the *indicators* need — the rolling windows
  // and each goal's own total — and this is the reading behind them: every agent
  // the harness has run, split by phase, by goal and over a fortnight.
  // The three Insights fetches, each carrying the page's window. It is a
  // parameter rather than a constant on the server for the reason the page has
  // one control: a route that picked its own span would put two tabs of one page
  // over two different stretches, which is the arrangement this replaced.
  getSpend: (window: InsightsWindow) => authFetch(`/api/spend?window=${window}`).then((r) => json<SpendPayload>(r)),
  // The trend, fetched when its tab is first opened rather than with the rest:
  // it reads *eight* windows of world events on top of the same agent walk, and
  // the tab an operator never opens should cost nothing.
  getSpendTrend: (window: InsightsWindow) =>
    authFetch(`/api/spend/trend?window=${window}`).then((r) => json<SpendTrendPayload>(r)),
  // The allowance as a series, fetched on the Allowance tab's first visit for
  // `getSpendTrend`'s reason: it walks the readings history on top of the same
  // agent walk. Same window as everything else on the page — the apportionment is
  // a percentage laid over the money the Economics tab prices, and the two are
  // only comparable over one stretch.
  getAllowance: (window: InsightsWindow) =>
    authFetch(`/api/allowance?window=${window}`).then((r) => json<AllowancePayload>(r)),
  // What the spending bought. Same stance and the same window as the breakdown:
  // the two are read a tab apart and must describe one stretch of the fleet's
  // life, which they did not when one fold was all-time and the other a fortnight.
  getReliability: (window: InsightsWindow) =>
    authFetch(`/api/reliability?window=${window}`).then((r) => json<ReliabilityPayload>(r)),
  // The tool channel, fetched on the MCP tab's first visit for the trend's reason:
  // the naming evidence is a scan of every dispatch prompt inside the window, and
  // that is the one read in the harness that touches `tasks.prompt` in bulk.
  getMcpUsage: (window: InsightsWindow) =>
    authFetch(`/api/mcp/usage?window=${window}`).then((r) => json<McpUsagePayload>(r)),
  // The cross-fleet pool. It takes **no window**: the digest's bucket is a UTC day
  // and its retention is ninety of them, so the question a reader asks of it is a
  // number of days rather than one of the page's five spans — and it takes a
  // project, because `byCheck` is only comparable inside one pipeline.
  getPoolInsights: (project: string | null) =>
    authFetch(`/api/pool/insights${project === null ? '' : `?project=${encodeURIComponent(project)}`}`).then((r) =>
      json<PoolInsightsPayload>(r),
    ),
  // The obstacle board (#32 phase 7). Fetched on its own tab rather than riding
  // the snapshot, for `getMcpUsage`'s reason: it is every sighting's prose for
  // every row, and the snapshot comes round every couple of seconds for every open
  // cockpit. The four writes below are the operator's whole arm on this store —
  // none of them is a step on any path the harness waits on, because *every state
  // has an exit that is not you* is the invariant the subsystem is arranged around.
  getObstacles: () => authFetch('/api/obstacles').then((r) => json<ObstacleBoardPayload>(r)),
  // Never tell the fleet this, or tell them again. The one state whose exit is a
  // person, and a person put it there.
  muteObstacle: (id: string, muted: boolean) =>
    post<{ ok: true }>(`/api/obstacles/${encodeURIComponent(id)}/mute`, { muted }),
  // A ticket you are already using. It takes the same `UPDATE … WHERE owner_ref IS
  // NULL` the ownership desk takes, so an operator and the pulse racing for one row
  // is a uniqueness constraint rather than a rule either remembers.
  ownObstacle: (id: string, ownerRef: string) =>
    post<{ ok: true }>(`/api/obstacles/${encodeURIComponent(id)}/own`, { ownerRef }),
  // This is over and no reading is going to say so. **Not** rejecting: the row
  // keeps what it said, and a matching report reopens it.
  retireObstacle: (id: string) => post<{ ok: true }>(`/api/obstacles/${encodeURIComponent(id)}/retire`, {}),
  // Write a note into the repository now rather than when the endings desk reaches
  // it — one at a time across the whole fleet, whichever door asks.
  writeDownObstacle: (id: string) => post<{ ok: true }>(`/api/obstacles/${encodeURIComponent(id)}/write-up`, {}),
  // This fleet's own side of the pool, plus the mirror. Fetched on the Knowledge
  // page rather than riding the snapshot, for `getMcpUsage`'s reason: it is other
  // teams' prose, and the snapshot comes round every couple of seconds.
  getPool: () => authFetch('/api/pool').then((r) => json<PoolStatePayload>(r)),
  /** Withhold one claim from the pool, or put it back. Never publishes — the desk does. */
  setFactKeepLocal: (id: string, keepLocal: boolean) =>
    post<{ ok: true }>(`/api/knowledge/facts/${encodeURIComponent(id)}/keep-local`, { keepLocal }),
  // The prompt book, fetched on open for the opposite reason to the work graph:
  // it is read once at boot, so polling it would be paying for a constant.
  /**
   * What exists, what it costs and how often it turns up — the same bytes on every
   * request of a build, which is why the Pets page fetches it once on open rather
   * than reading it off a snapshot that ships every heartbeat.
   */
  getPetCatalogue: () => authFetch('/api/pets/catalogue').then((r) => json<PetCatalogue>(r)),

  getPrompts: () => authFetch('/api/prompts').then((r) => json<PromptsPayload>(r)),
  // What the harness can say about its own configuration without being asked.
  // Fetched on open and after a write rather than polled: it shells out to git and
  // to the agent binary, which is not a thing to do on a heartbeat.
  getSetup: () => authFetch('/api/setup').then((r) => json<SetupPayload>(r)),
  // The two answers, read into everything they imply. A POST for a read because
  // the answers are a body; it writes nothing — what it derives is handed to
  // `previewConfig`/`saveConfig` like any other edit.
  resolveSetup: (answers: { email: string; repoRoot: string }) =>
    post<SetupResolvePayload>('/api/setup/resolve', answers),
  // The running config, fetched on open for the same reason as the prompt book:
  // `loadConfig` runs once at boot, so this can never change while the tab is up.
  getConfig: () => authFetch('/api/config').then((r) => json<RunningConfigPayload>(r)),
  // Save it. `baseline` is the revision the form was built from, so a file that
  // moved underneath — an editor, or Claude — refuses the save rather than being
  // clobbered by it.
  saveConfig: (edits: { set?: Record<string, unknown>; clear?: string[]; baseline: string }) =>
    post<ConfigSavePayload>('/api/config', edits),
  // Pause dispatch and hand this process off to the supervisor, so a restart-only
  // change takes effect. Refused with the reason where there is no supervisor, or
  // where agents are still running and `interrupt` was not asked for.
  restartHarness: (interrupt: boolean) => post<{ ok: true }>('/api/config/restart', { interrupt }),
  // The same ladder a save walks, stopping short of the write: the bytes that
  // would be written, and what applying them would do. The review step draws its
  // diff from this rather than splicing the file itself — that splice is server
  // code, and a second one here would be free to disagree with the one that writes.
  previewConfig: (edits: { set?: Record<string, unknown>; clear?: string[]; text?: string; baseline: string }) =>
    post<ConfigPreviewPayload>('/api/config/preview', edits),
  // The whole file, written by hand. Refused by the loader exactly as a save is.
  saveRawConfig: (edits: { text: string; baseline: string }) => post<ConfigSavePayload>('/api/config/raw', edits),
  // The effective CI policy behind the settings modal's CI tab. Derived on the
  // server from the same defaults `classifyCiFailures` reads, so the tab cannot
  // claim a routing the dispatcher would not take.
  getCiPolicy: () => authFetch('/api/ci-policy').then((r) => json<CiPolicyPayload>(r)),
  // How to register this harness with the operator's own Claude Code, read off
  // the running desktop channel rather than written down in the tab that draws it.
  getMcp: () => authFetch('/api/mcp').then((r) => json<McpChannelPayload>(r)),
  // Ask an agent to create a tracker item for work nothing external accounts for.
  // An operator's click, never a rule: see src/graph/unrecorded.ts.
  fileWorkItem: (ref: string) => post(`/api/work/${encodeURIComponent(ref)}/file`),
  // The other verdict: no ticket is wanted. `ignored: false` is a DELETE because
  // the store's undo is a delete — one representation of "not ignored".
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
  // A questionnaire's answers go up as a list and are folded into the one reply
  // the agent reads by the server, not here: the wording an agent is answered in
  // is a domain rule, and a second client must not be able to phrase it its own way.
  answerQuestions: (id: string, answers: (string | null)[]) => post(`/api/escalations/${id}/answer`, { answers }),
  // Clear an item without answering it, for when the thing was handled outside the
  // harness. The server picks the right "no" per kind (a permission request is
  // denied, a proposal rejected) so nothing is left blocked — see the route.
  dismissEscalation: (id: string, note?: string) =>
    post<{ ok: true; dismissedAs: string }>(`/api/escalations/${id}/dismiss`, { note }),
  // Allow or deny a permission request an agent is blocked on (issue #130). The
  // same live agent then continues or gets the denial — no config-and-restart.
  decidePermission: (id: string, allow: boolean, note?: string) =>
    post<{ ok: true; allowed: boolean }>(`/api/escalations/${id}/permission`, { allow, note }),
  // Accepting is what performs the act — the harness merges / sends it through the
  // same seam auto-send would have used. Rejecting sends nothing and is durable.
  // `acknowledged` is the caveat ids the operator ticked. The route refuses the
  // accept — 400, nothing decided — while a plan's caveats are unticked, so the
  // list travels with the verdict rather than being asserted by the glass alone.
  acceptProposal: (id: string, note?: string, acknowledged?: string[]) =>
    post<{ ok: boolean; detail: string }>(`/api/proposals/${id}/accept`, { note, acknowledged }),
  rejectProposal: (id: string, note?: string) =>
    post<{ ok: boolean; detail: string }>(`/api/proposals/${id}/reject`, { note }),
  // Backing out of a plan verdict: the ticket is closed with the operator's comment,
  // or un-watched until somebody has thought about it. Not a rejection — that asks a
  // planner for a different plan for a goal nobody wants.
  backOutProposal: (id: string, verdict: 'close' | 'hold', note?: string) =>
    post<{ ok: boolean; detail: string }>(`/api/proposals/${id}/back-out`, { verdict, note }),
  // The placeholder comment for a close. Served, never posted — what lands on the
  // ticket is whatever the operator sends back with the verdict.
  proposalCommentDraft: (id: string) =>
    authFetch(`/api/proposals/${id}/comment-draft`).then((r) => json<ProposalCommentDraft>(r)),
  respondAgent: (id: string, text: string) => post(`/api/agents/${id}/respond`, { text }),
  setControl: (patch: { cap?: number; paused?: boolean }) =>
    post<{ ok: true; cap: number; paused: boolean }>('/api/control', patch),
  setPrWatched: (prNumber: number, watched: boolean) =>
    post<{ ok: true; watched: boolean }>(`/api/prs/${prNumber}/watch`, { watched }),
  // Land a whole chain: one standing authorization that keeps accepting each
  // rung's merge as the harness proposes it, cycle after cycle. A DELETE calls it
  // off, for the reason the watch toggle uses one — the store's undo is a
  // settlement, not a second flag.
  setStackLanding: (ref: string, landing: boolean) =>
    landing
      ? post<{ ok: true; landing: StackLanding }>(`/api/stacks/${encodeURIComponent(ref)}/land`)
      : authFetch(`/api/stacks/${encodeURIComponent(ref)}/land`, { method: 'DELETE' }).then((r) =>
          json<{ ok: true; landing: StackLanding }>(r),
        ),
  setIssueWatched: (issueNumber: number, watched: boolean) =>
    post<{ ok: true; watched: boolean }>(`/api/issues/${issueNumber}/watch`, { watched }),
  // Move a work item to one of the tracker's own states — the board's drag. The route
  // validates no state word: the provider owns its process template, and its refusal
  // is what reaches the card.
  setIssueState: (issueNumber: number, state: string) =>
    post<{ ok: true; state: string }>(`/api/issues/${issueNumber}/state`, { state }),
  // Put this goal at the front of the queue, or take it back out. It re-orders and
  // never un-holds, so the answer is the next pulse's queue and nothing else.
  setGoalPriority: (issueNumber: number, priority: boolean) =>
    post<{ ok: true; priority: boolean }>(`/api/issues/${issueNumber}/priority`, { priority }),
  // Pin this goal's work to a model profile, or clear the pin (#342). The same
  // call answers a standing proposal from the appraiser, whichever way it went —
  // the route settles the question on any write, which is what makes "keep mine"
  // a decision rather than a refusal to answer.
  setIssueProfile: (issueNumber: number, profile: string | null) =>
    post<{ ok: true }>(`/api/issues/${issueNumber}/profile`, { profile: profile ?? '' }),
  // Settle where this goal belongs on the backlog — the container it hangs off,
  // and the area node that puts it on a board. `null` is the third answer, "this
  // goal wants no such thing"; the other two are the appraisal's proposal and a value
  // the operator picked instead, and the route cannot tell them apart because it
  // does not need to. The write is the harness's either way.
  setIssueParent: (issueNumber: number, parent: number | null) =>
    post<{ ok: true }>(`/api/issues/${issueNumber}/parent`, parent === null ? {} : { parent }),
  setIssueAreaPath: (issueNumber: number, areaPath: string | null) =>
    post<{ ok: true }>(`/api/issues/${issueNumber}/area-path`, { areaPath: areaPath ?? '' }),
  // Override which profile one plan part runs on. Clearing it makes the part
  // inherit the goal's pin again, which is not the same as naming the goal's
  // current profile.
  setPartProfile: (planId: string, slug: string, profile: string | null) =>
    post<{ ok: true }>(`/api/plans/${planId}/part-profile`, { slug, profile: profile ?? '' }),
  // The operator's override of whether an issue is finished. `null` clears it,
  // returning the issue to whatever its agent or its plan says.
  setIssueConclusion: (issueNumber: number, verdict: 'done' | 'more_work' | null) =>
    post<{ ok: true }>(`/api/issues/${issueNumber}/conclusion`, { verdict }),
  // Tell the fleet what to do on this goal, in the operator's own words. It writes
  // the instruction *and* restarts the goal — the `more_work` verdict, which retracts
  // a standing delivery, and a settled plan sent back to a planner. One act on this
  // side, because the words without a next dispatch reach nobody.
  addInstruction: (issueNumber: number, text: string) =>
    post<{ ok: true }>(`/api/issues/${issueNumber}/instruction`, { text }),
  // Overrule a standing shortfall: the assessment is wrong, and this is why. It
  // records the delivery — which clears the shortfall, parks the assessor that
  // would re-derive it, and releases the retrospective and any handed-over
  // validation check — and files the same words as an instruction, which is what
  // gets them onto the ticket. 409 when nothing is standing to overrule.
  overruleShortfall: (issueNumber: number, text: string) =>
    post<{ ok: true }>(`/api/issues/${issueNumber}/shortfall/overrule`, { text }),
  // Stop waiting on an environment for this goal, or put it back to waiting. The
  // note is required on the release and refused without one: it is the only
  // account of why a goal was closed out with no environment ever confirming it.
  releaseEnvironmentGate: (issueNumber: number, released: boolean, note?: string) =>
    post<{ ok: true }>(`/api/issues/${issueNumber}/environment-gate`, { released, note }),
  // Take one back. Withdrawing the last one clears the `more_work` it wrote with
  // it, so the goal is not bounced back to pickup for words nobody will read.
  /**
   * Put a review thread back in front of the fleet, or take the ask back. A store
   * mark and never a write to the provider — the reviewer's thread on GitHub is
   * left exactly as they left it.
   */
  reopenPrThread: (prNumber: number, threadId: string, reopened: boolean) =>
    post<{ ok: true }>(`/api/prs/${prNumber}/threads/${encodeURIComponent(threadId)}/reopen`, { reopened }),
  withdrawInstruction: (issueNumber: number, id: string) =>
    authFetch(`/api/issues/${issueNumber}/instruction/${id}`, { method: 'DELETE' }).then((r) =>
      json<{ ok: true; standing: number }>(r),
    ),
  // The operator's override of the intake verdict (#158). `unclear` is the one
  // reading that blocks dispatch, so this is the escape hatch that gate has to
  // have; `null` clears it, which is a delete and not a synonym for `workable`.
  setIssueAppraisal: (issueNumber: number, verdict: 'workable' | 'unclear' | null) =>
    post<{ ok: true }>(`/api/issues/${issueNumber}/appraisal`, { verdict }),
  // Raise a bug against a story: the operator ran it and it does not do what they
  // expect. Unlike its neighbours this files into the *tracker* rather than writing
  // the harness's own record, and it leaves the story's verdict where it found it —
  // the bug is its own work item and carries the work.
  raiseBug: (issueNumber: number, summary: string, title?: string) =>
    post<{ ok: true; filing: BugFiling }>(`/api/issues/${issueNumber}/bug`, { summary, title }),
  // Where an issue raised from the cockpit would land, and as whom — asked of the
  // `gh` CLI itself, on the modal opening. Deliberately not on `/api/state`: it
  // costs a round trip and the only reader opens rarely.
  //
  // A logged-out CLI comes back as a 200 carrying `available: false`, so this
  // rejects only when the *probe route* is unreachable — which the modal treats the
  // same way, since either means it must offer the way out to LubbDubb's own form.
  probeFilingTarget: () => authFetch('/api/issues/filing-target').then((r) => json<FilingTargetProbe>(r)),
  // The operator's own report about LubbDubb, filed straight onto its own tracker
  // and never the one the fleet is pointed at (issue #449). Unlike `raiseBug` above
  // there is no desk agent between the click and the create: the operator has
  // already written the thing up, so there is no judgement left to delegate. `watch`
  // is what decides whether the fleet picks it up, and it is honoured only on the
  // deployment that works this repo itself.
  raiseIssue: (title: string, body: string, watch: boolean) => post<IssueFiled>('/api/issues', { title, body, watch }),
  // End the harness's run at a goal (issues #203, #234). A run is retained so its
  // report stays reachable; this is the one thing that ends it, it
  // persists across a restart, and it stops the dispatcher acting on the goal.
  // The note rides along for the same reason it does on a close-out: this refuses
  // without one while the goal's validation plan is flagged, and it is kept on the
  // run, so what the goal owed and what was said about it survive together.
  dismissRun: (issueNumber: number, note?: string) =>
    post<{ ok: true; cleared: RunClearOut }>(
      `/api/issues/${issueNumber}/dismiss-run`,
      note === undefined ? undefined : { note },
    ),
  replan: (planId: string) => post<{ ok: true }>(`/api/plans/${planId}/replan`),
  // The operator's ruling on a check an agent declared. Accepting is also what puts
  // the query to an environment for the first time — with their own credential,
  // which is the whole reason it is asked.
  ruleWatchProposal: (issueNumber: number, checkId: string, accept: boolean) =>
    post<{ ok: true }>(`/api/issues/${issueNumber}/watch-proposals/${encodeURIComponent(checkId)}`, { accept }),
  // The operator's own check, written or re-written. One verb for both, on the slug
  // every other writer here folds on — and it runs the dry run in the same call, so
  // `dryRun` is what the environment refused rather than a promise to look later.
  saveWatchCheck: (issueNumber: number, check: GoalWatchDeclaration) =>
    put<{ ok: true; dryRun: string[] }>(
      `/api/issues/${issueNumber}/watch/checks/${encodeURIComponent(check.id)}`,
      check,
    ),
  deleteWatchCheck: (issueNumber: number, checkId: string) =>
    del<{ ok: true }>(`/api/issues/${issueNumber}/watch/checks/${encodeURIComponent(checkId)}`),
  // Give a window more time — the answer for one that closed before the weekly job
  // ran. It re-opens the window it names rather than opening a second one, so the
  // readings already taken stay in front of the ones it is about to take.
  extendWatch: (issueNumber: number, environment: string) =>
    post<{ ok: true }>(`/api/issues/${issueNumber}/watch/${encodeURIComponent(environment)}/extend`),
  // A plan's revisions and the last amendment as a diff, fetched when the sheet is
  // opened. Not polled, for the retrospective's reason: every revision carries a
  // write-up, so a replanned plan would put several of them into each poll.
  getPlanHistory: (planId: string) => authFetch(`/api/plans/${planId}/history`).then((r) => json<PlanHistory>(r)),
  // A reviewer's confirmation that one acceptance criterion holds. Keyed on the
  // criterion's text, which is what the server stores — an index would move under a
  // re-worded list and carry the tick onto something nobody looked at.
  setAcceptance: (planId: string, slug: string, criterion: string, met: boolean) =>
    post<{ ok: true }>(`/api/plans/${planId}/acceptance`, { slug, criterion, met }),
  // What an operator concluded about one validation check — a result, a deferral,
  // a waiver, or the reset that withdraws any of them. One call rather than four
  // methods because there is one thing being said: this is the check's current
  // reading, and the server clears whatever the last one left behind.
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
  // Talk it through with an agent instead of accepting or rejecting. Server-side
  // this is a replan whose planner converses first — see the route.
  // Re-order the "Up next" queue (issue #128): the operator's desired priority
  // order of candidate origins, which the dispatcher reads back into its ranking.
  reorderUpNext: (origins: string[]) => post<{ ok: true }>('/api/upnext/order', { origins }),
  // Price one queued row: which profile the next dispatch on this
  // origin runs on. `null` clears the override and the row goes back to its
  // goal's pin, or its rule's own entry.
  setUpNextProfile: (origin: string, profile: string | null) =>
    post<{ ok: true }>('/api/upnext/profile', { origin, profile: profile ?? '' }),
  // `attachments` carry base64 image bytes (issue #249), which is why this one
  // route may send megabytes: the server's per-route bodyLimit is what bounds it,
  // and the size/format bounds are the server's alone — the composer refuses early
  // to save a round trip, never instead of the server.
  launchJob: (job: {
    prompt: string;
    title?: string;
    kind?: string;
    branch?: string | null;
    attachments?: JobAttachmentInput[];
  }) => post<{ ok: true }>('/api/jobs', job),
  cancelJob: (id: string) => post<{ ok: true }>(`/api/jobs/${id}/cancel`),
  // Recurrences. A schedule queues the same job the composer above does, so
  // everything these four calls can cause is a job in the queue — which is why
  // they carry no dispatch controls of their own.
  createSchedule: (schedule: { cron: string; prompt: string; title?: string; kind?: string }) =>
    post<{ ok: true }>('/api/schedules', schedule),
  updateSchedule: (
    id: string,
    patch: { cron?: string; prompt?: string; title?: string; kind?: string; enabled?: boolean },
  ) => post<{ ok: true }>(`/api/schedules/${id}`, patch),
  // Fire one now, without waiting for its slot and without moving it: an operator
  // testing what they just wrote should not have to wait until Monday to see it.
  runSchedule: (id: string) => post<{ ok: true }>(`/api/schedules/${id}/run`),
  deleteSchedule: (id: string) =>
    authFetch(`/api/schedules/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: true }>(r)),
  // A finding becomes work only here: the operator's click is the gate, because
  // an agent that could queue jobs could put agents on the fleet.
  promoteFinding: (id: string) => post<{ ok: true }>(`/api/findings/${id}/promote`),
  // The defer arm: a desk agent files it in the tracker and reports the ticket
  // back, so the work waits its turn there rather than on the fleet.
  fileFinding: (id: string) => post<{ ok: true }>(`/api/findings/${id}/file`),
  dismissFinding: (id: string) => post<{ ok: true }>(`/api/findings/${id}/dismiss`),

  // The vivarium. No read arm: `PetState` rides on `/api/state`, so the corner of
  // the rail updates on the same socket as the queue above it.
  openPet: (id: string) => post<{ ok: true }>(`/api/pets/${id}/open`, {}),
  feedPet: (id: string, beats: number) => post<{ ok: true }>(`/api/pets/${id}/feed`, { beats }),
  renamePet: (id: string, name: string) => post<{ ok: true }>(`/api/pets/${id}/name`, { name }),
  placePet: (id: string, placed: boolean) => post<{ ok: true }>(`/api/pets/${id}/place`, { placed }),
  blendPet: (id: string) => post<{ ok: true }>(`/api/pets/${id}/blend`, {}),

  // Knowledge (#27). The operator's whole arm of the one claim store: where a
  // claim stands, where it goes when it leaves, and — the one write that is not a
  // ruling — a claim they wrote down themselves, which lands a proposal like every
  // other. Nothing here files a claim on an agent's behalf: agents raise through
  // the tool channel, on a scoped credential rather than this bearer token. The
  // detail is fetched per row rather than polled, because the evidence behind one
  // claim is thousands of characters the snapshot has no business carrying for rows
  // nobody has opened.
  knowledgeFact: (id: string) =>
    authFetch(`/api/knowledge/facts/${encodeURIComponent(id)}`).then((r) => json<KnowledgeFactPayload>(r)),
  setFactReach: (id: string, reach: FactRuling) =>
    post<{ ok: true }>(`/api/knowledge/facts/${encodeURIComponent(id)}/reach`, { reach }),
  // Folding a suggested cluster into the claim the operator kept. **One call**, for
  // the reason answering a contradiction is one: moving the voices and superseding
  // the members are two halves of one decision, and a pair of calls can half-land —
  // a survivor carrying four voices beside four live phrasings of itself, or four
  // superseded rows whose voices went nowhere.
  mergeFacts: (id: string, members: string[]) =>
    post<{ ok: true }>(`/api/knowledge/facts/${encodeURIComponent(id)}/merge`, { members }),
  // Answering a contradiction (#27 phase 5). **One call**, because adopting an
  // amendment is one act: promoting it and superseding the claim it replaces are
  // two halves of one decision, and a pair of calls can half-land — the sharper
  // claim injected beside the blunter one, both in the same block, saying
  // different things to every agent.
  resolveContradiction: (id: string, body: ContradictionRuling) =>
    post<{ ok: true }>(`/api/knowledge/contradictions/${encodeURIComponent(id)}/resolve`, body),
  // Sending a claim on — a documentation pull request, a job, or a ticket. **One
  // call**, because opening the work and recording that it is on its way are two
  // halves of one act: a job nothing links to lands and takes the claim out of no
  // prompt. It does not move the reach — the claim goes on being delivered until
  // the exit is actually taken.
  exitFact: (id: string, body: FactExit) =>
    post<{ ok: true }>(`/api/knowledge/facts/${encodeURIComponent(id)}/exit`, body),
  // Writing one down yourself. It lands a proposal like everything else: the
  // surface is one gate, not one gate and a bypass for whoever is at the keyboard.
  raiseFact: (claim: string, originRef: string | null) =>
    post<{ ok: true }>('/api/knowledge/facts', { claim, originRef }),
  // What became of one the harness cannot read for itself — a pull request that
  // left the world without ever being seen closed. The sweep says `unknown` rather
  // than guessing merged, and this is the answer to it.
  settleGraduation: (id: string, outcome: GraduationOutcome) =>
    post<{ ok: true }>(`/api/knowledge/graduations/${encodeURIComponent(id)}/settle`, { outcome }),
  // Work only a person can do. `done` settles it and concludes any plan step it
  // backs, which releases whatever was waiting; `decline` settles it the other way
  // and deliberately does not conclude the step, so nothing downstream starts.
  // `note` where the route asks for one: a `close_out` on a goal whose validation
  // is flagged is refused without it. Omitted rather than sent empty — the route
  // reads absence, and `''` would be the same absence spelled a second way.
  completeHumanTask: (id: string, note?: string) =>
    post<{ ok: true }>(`/api/human-tasks/${id}/done`, note === undefined ? undefined : { note }),
  declineHumanTask: (id: string, note: string) => post<{ ok: true }>(`/api/human-tasks/${id}/decline`, { note }),
  // Close the tracker item the close-out row names, and settle the row with it.
  // The obligation is the close, so this is the act rather than a third verdict:
  // the same `note` the flagged-validation rule asks of `done`, and the same
  // absence-not-empty-string discipline.
  closeHumanTaskTicket: (id: string, note?: string) =>
    post<{ ok: true }>(`/api/human-tasks/${id}/close-ticket`, note === undefined ? undefined : { note }),
  // Off the bench. Settled rows only — it says nothing about the work, so it is
  // not a third verdict and settles nothing.
  dismissHumanTask: (id: string) => post<{ ok: true }>(`/api/human-tasks/${id}/dismiss`),
  // Decide what happens to work the last run left orphaned. Until every one of
  // these is answered the harness runs no cycles, so this is the one call that can
  // un-stick a cockpit whose fleet looks frozen. Keyed on the **task**: an orphan
  // may never have had an agent at all.
  decideRecovery: (taskId: string, verdict: RecoveryVerdict) =>
    post<{ ok: true; remaining: number }>(`/api/recovery/${taskId}`, { verdict }),
  // The harness's own build. `upgrade('apply')` is the one call on this surface
  // that ends the process it is talking to, so a dropped connection after it is
  // the expected outcome rather than a failure — the cockpit's reconnect is what
  // reports the new build.
  checkBuild: () => post<{ ok: true; build: BuildReading }>('/api/upgrade/check'),
  upgrade: (action: UpgradeAction, opts?: { interrupt?: boolean }) =>
    post<{ ok: true; build: BuildReading }>('/api/upgrade', { action, ...opts }),
  // The machine's one dev environment. `startLocalRun` is also the swap: there is
  // one environment, so starting another goal's is stopping this one — and the
  // server is where that transition lives, not in two calls from here.
  startLocalRun: (issue: number, ref?: string) =>
    post<{ ok: true; run: LocalRunView }>('/api/local-run', { issue, ...(ref === undefined ? {} : { ref }) }),
  stopLocalRun: () => post('/api/local-run/stop'),
  // Type into the session holding the environment, and move its checkout to the tip
  // of its branch. Neither takes an id, for `stopLocalRun`'s reason: there is one run.
  messageLocalRun: (text: string) => post<{ ok: true }>('/api/local-run/message', { text }),
  refreshLocalRun: () => post<{ ok: true; run: LocalRunView }>('/api/local-run/refresh'),
  // Its own fetch rather than a field on the snapshot: two hundred lines on every
  // heartbeat is a log nobody has open, paid for forever.
  localRunOutput: () => authFetch('/api/local-run/output').then((r) => json<{ lines: string[] }>(r)),
  killAgent: (id: string) => post(`/api/agents/${id}/kill`),
  completeAgent: (id: string) => post(`/api/agents/${id}/complete`),
  interruptAgent: (id: string) => post(`/api/agents/${id}/interrupt`),
  // End a usage-limit park: re-opens the agent's own conversation in its own
  // worktree and tells it to carry on. 409s for an agent parked on anything else.
  resumeAgent: (id: string) => post(`/api/agents/${id}/resume`),
  // Push a stall park's countdown out by `agentStallExtendMs`. 409s for an agent
  // that has no countdown running — it was answered, dismissed or has ended.
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
    // The token goes in the query string here, not a header: the browser
    // WebSocket API exposes no way to set one on the upgrade request. That is a
    // weaker channel in general — query strings reach access logs and `Referer`
    // — but this connection is to loopback and traverses no proxy, so there is no
    // log between here and the harness for it to leak into.
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

// The Pages demo runs the SPA against an in-browser fake backend so there's no
// server to talk to. `VITE_DEMO=1` (web/.env.demo) is baked in at build time and
// statically dead-code-eliminates the demo path out of the production bundle.
//
// The `typeof` guard is for node, not the browser: under `tsx` there is no
// `import.meta.env` at all, so the bare access threw at import — which put the
// whole cockpit out of reach of a test, and so out of reach of the console tests
// that render it to static markup.
//
// If you change the shape of this expression, check both build directions, and
// grep for a *string literal* from the fixtures — `buildDemoState` is minified to
// a single letter in both bundles, so its absence proves nothing:
//   npm run web:build       → must NOT contain "Reworking the policy-evaluation"
//   npm run web:build:demo  → must contain it
const DEMO = typeof import.meta.env !== 'undefined' && import.meta.env.VITE_DEMO === '1';

/** True when running against the fake backend (the GitHub Pages demo build). */
export const isDemo = DEMO;
export const api = DEMO ? demoApi : realApi;
export const connectWs: typeof connectRealWs = DEMO ? connectDemoWs : connectRealWs;

/**
 * Faking a world change is a **demo** control, and it lives off the `api` seam
 * rather than on it because the server has no route behind it: a real run reads
 * a real provider, and a button that told the harness something had happened
 * would be a way to lie to yourself about what it is reacting to.
 *
 * The rejecting arm is unreachable rather than defensive — `InjectPanel` renders
 * only under {@link isDemo}, the same constant this folds on — but a refusal is
 * the honest thing for a call that cannot be served, where a silent no-op would
 * leave the panel reporting success.
 */
export const injectDemoEvent: (event: unknown) => Promise<{ ok: true }> = DEMO
  ? demoApi.inject
  : () => Promise.reject(new Error('event injection is a demo-only control'));
