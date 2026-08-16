import type { AppState, BugFiling, JobAttachmentInput, RecoveryVerdict, StackLanding } from './types.js';
// The fetched-on-open routes, as whole payloads rather than shapes re-typed at
// each call site: the server declares each one as its return type, so a renamed
// or re-nested key is a compile error here instead of an empty panel.
import type {
  CiPolicyPayload,
  PlanHistory,
  PromptsPayload,
  RetrospectivePayload,
  RunningConfigPayload,
  ScratchpadPayload,
  ReliabilityPayload,
  SpendPayload,
  SpendTrendPayload,
  WorkRootsPayload,
  TicketsPayload,
  WorkSubtreePayload,
} from '../../src/wire.js';
import { demoApi, connectDemoWs } from './demo/demoBackend.js';

/**
 * Thrown when the server refuses the cockpit's credential, so `App` can render
 * the one screen that tells the operator what to do instead of retrying forever.
 * A distinct type rather than a status check at each call site: every request
 * goes through {@link authFetch}, so there is exactly one place it can arise.
 */
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

const realApi = {
  getState: () => authFetch('/api/state').then((r) => json<AppState>(r)),
  getTranscript: (agentId: string) =>
    authFetch(`/api/agents/${agentId}/transcript`).then((r) => json<{ transcript: string }>(r)),
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
  // The breakdown behind the cost indicators, fetched when the Spend panel opens.
  // The snapshot already carries what the *indicators* need — the rolling windows
  // and each goal's own total — and this is the reading behind them: every agent
  // the harness has run, split by phase, by goal and over a fortnight.
  getSpend: () => authFetch('/api/spend').then((r) => json<SpendPayload>(r)),
  // The trend behind the breakdown, fetched when its tab is first opened rather
  // than with the panel: it reads two months of world events on top of the same
  // agent walk, and the tab an operator never opens should cost nothing.
  getSpendTrend: () => authFetch('/api/spend/trend').then((r) => json<SpendTrendPayload>(r)),
  // What the spending bought, fetched when the Yield panel opens. Same stance as
  // the spend breakdown and for the same reason: the *gauge* is derived from the
  // agent rows already on the snapshot, and this is every run the harness has
  // settled plus a fortnight of CI transitions behind it.
  getReliability: () => authFetch('/api/reliability').then((r) => json<ReliabilityPayload>(r)),
  // The prompt book, fetched on open for the opposite reason to the work graph:
  // it is read once at boot, so polling it would be paying for a constant.
  getPrompts: () => authFetch('/api/prompts').then((r) => json<PromptsPayload>(r)),
  // The running config, fetched on open for the same reason as the prompt book:
  // `loadConfig` runs once at boot, so this can never change while the tab is up.
  getConfig: () => authFetch('/api/config').then((r) => json<RunningConfigPayload>(r)),
  // The effective CI policy behind the settings modal's CI tab. Derived on the
  // server from the same defaults `classifyCiFailures` reads, so the tab cannot
  // claim a routing the dispatcher would not take.
  getCiPolicy: () => authFetch('/api/ci-policy').then((r) => json<CiPolicyPayload>(r)),
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
  acceptProposal: (id: string, note?: string) =>
    post<{ ok: boolean; detail: string }>(`/api/proposals/${id}/accept`, { note }),
  rejectProposal: (id: string, note?: string) =>
    post<{ ok: boolean; detail: string }>(`/api/proposals/${id}/reject`, { note }),
  respondAgent: (id: string, text: string) => post(`/api/agents/${id}/respond`, { text }),
  setControl: (patch: { cap?: number; paused?: boolean }) =>
    post<{ ok: true; cap: number; paused: boolean }>('/api/control', patch),
  setPrExcluded: (prNumber: number, excluded: boolean) =>
    post<{ ok: true; excluded: boolean }>(`/api/prs/${prNumber}/exclude`, { excluded }),
  // Land a whole chain: one standing authorization that keeps accepting each
  // rung's merge as the harness proposes it, cycle after cycle. A DELETE calls it
  // off, for the reason the ignore toggle uses one — the store's undo is a
  // settlement, not a second flag.
  setStackLanding: (ref: string, landing: boolean) =>
    landing
      ? post<{ ok: true; landing: StackLanding }>(`/api/stacks/${encodeURIComponent(ref)}/land`)
      : authFetch(`/api/stacks/${encodeURIComponent(ref)}/land`, { method: 'DELETE' }).then((r) =>
          json<{ ok: true; landing: StackLanding }>(r),
        ),
  setIssueWatched: (issueNumber: number, watched: boolean) =>
    post<{ ok: true; watched: boolean }>(`/api/issues/${issueNumber}/watch`, { watched }),
  // Pin this goal's work to a model profile, or clear the pin (#342). The same
  // call answers a standing proposal from the assayer, whichever way it went —
  // the route settles the question on any write, which is what makes "keep mine"
  // a decision rather than a refusal to answer.
  setIssueProfile: (issueNumber: number, profile: string | null) =>
    post<{ ok: true }>(`/api/issues/${issueNumber}/profile`, { profile: profile ?? '' }),
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
  // the instruction *and* the `more_work` that makes there be a next dispatch to
  // read it — one act on this side, because half of it does nothing.
  addInstruction: (issueNumber: number, text: string) =>
    post<{ ok: true }>(`/api/issues/${issueNumber}/instruction`, { text }),
  // Take one back. Withdrawing the last one clears the `more_work` it wrote with
  // it, so the goal is not bounced back to pickup for words nobody will read.
  withdrawInstruction: (issueNumber: number, id: string) =>
    authFetch(`/api/issues/${issueNumber}/instruction/${id}`, { method: 'DELETE' }).then((r) =>
      json<{ ok: true; standing: number }>(r),
    ),
  // The operator's override of the intake verdict (#158). `unclear` is the one
  // reading that blocks dispatch, so this is the escape hatch that gate has to
  // have; `null` clears it, which is a delete and not a synonym for `workable`.
  setIssueAssay: (issueNumber: number, verdict: 'workable' | 'unclear' | null) =>
    post<{ ok: true }>(`/api/issues/${issueNumber}/assay`, { verdict }),
  // Raise a bug against a story: the operator ran it and it does not do what they
  // expect. Unlike its neighbours this files into the *tracker* rather than writing
  // the harness's own record, and it leaves the story's verdict where it found it —
  // the bug is its own work item and carries the work.
  raiseBug: (issueNumber: number, summary: string, title?: string) =>
    post<{ ok: true; filing: BugFiling }>(`/api/issues/${issueNumber}/bug`, { summary, title }),
  // End the harness's run at a goal (issues #203, #234). A run is retained so its
  // report stays reachable; this is the one thing that ends it, it
  // persists across a restart, and it stops the dispatcher acting on the goal.
  dismissRun: (issueNumber: number) => post<{ ok: true }>(`/api/issues/${issueNumber}/dismiss-run`),
  replan: (planId: string) => post<{ ok: true }>(`/api/plans/${planId}/replan`),
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
  discussPlan: (planId: string) => post<{ ok: true }>(`/api/plans/${planId}/discuss`),
  endPlanDiscussion: (planId: string) => post<{ ok: true }>(`/api/plans/${planId}/discuss/end`),
  // Re-order the "Up next" queue (issue #128): the operator's desired priority
  // order of candidate origins, which the dispatcher reads back into its ranking.
  reorderUpNext: (origins: string[]) => post<{ ok: true }>('/api/upnext/order', { origins }),
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
  // Work only a person can do. `done` settles it and concludes any plan step it
  // backs, which releases whatever was waiting; `decline` settles it the other way
  // and deliberately does not conclude the step, so nothing downstream starts.
  completeHumanTask: (id: string) => post<{ ok: true }>(`/api/human-tasks/${id}/done`),
  declineHumanTask: (id: string, note: string) => post<{ ok: true }>(`/api/human-tasks/${id}/decline`, { note }),
  // Off the bench. Settled rows only — it says nothing about the work, so it is
  // not a third verdict and settles nothing.
  dismissHumanTask: (id: string) => post<{ ok: true }>(`/api/human-tasks/${id}/dismiss`),
  // Decide what happens to work the last run left orphaned. Until every one of
  // these is answered the harness runs no cycles, so this is the one call that can
  // un-stick a cockpit whose fleet looks frozen. Keyed on the **task**: an orphan
  // may never have had an agent at all.
  decideRecovery: (taskId: string, verdict: RecoveryVerdict) =>
    post<{ ok: true; remaining: number }>(`/api/recovery/${taskId}`, { verdict }),
  killAgent: (id: string) => post(`/api/agents/${id}/kill`),
  completeAgent: (id: string) => post(`/api/agents/${id}/complete`),
  interruptAgent: (id: string) => post(`/api/agents/${id}/interrupt`),
  // End a usage-limit park: re-opens the agent's own conversation in its own
  // worktree and tells it to carry on. 409s for an agent parked on anything else.
  resumeAgent: (id: string) => post(`/api/agents/${id}/resume`),
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
