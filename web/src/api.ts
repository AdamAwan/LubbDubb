import type { AppState, RecoveryVerdict, WorkNodeView } from './types.js';
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
    // the cockpit is imported under node, which is how the skin tests render a
    // skin to static markup. There is no token to find there and nothing will be
    // fetched, so an empty one is the right answer rather than a crash at import.
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
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
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
  getWorkRoots: () => authFetch('/api/work').then((r) => json<{ roots: WorkNodeView[] }>(r)),
  getWorkSubtree: (ref: string) =>
    authFetch(`/api/work/${encodeURIComponent(ref)}`).then((r) =>
      json<{ nodes: WorkNodeView[]; refUrls: Record<string, string> }>(r),
    ),
  pulse: () => post('/api/pulse'),
  inject: (event: unknown) => post('/api/inject', event),
  answerEscalation: (id: string, response: string) => post(`/api/escalations/${id}/answer`, { response }),
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
  setIssueWatched: (issueNumber: number, watched: boolean) =>
    post<{ ok: true; watched: boolean }>(`/api/issues/${issueNumber}/watch`, { watched }),
  // The operator's override of whether an issue is finished. `null` clears it,
  // returning the issue to whatever its agent or its plan says.
  setIssueConclusion: (issueNumber: number, verdict: 'done' | 'more_work' | null) =>
    post<{ ok: true }>(`/api/issues/${issueNumber}/conclusion`, { verdict }),
  setStoryWatched: (storyId: string, watched: boolean) =>
    post<{ ok: true; watched: boolean }>(`/api/stories/${storyId}/watch`, { watched }),
  replan: (planId: string) => post<{ ok: true }>(`/api/plans/${planId}/replan`),
  // Re-order the "Up next" queue (issue #128): the operator's desired priority
  // order of candidate origins, which the dispatcher reads back into its ranking.
  reorderUpNext: (origins: string[]) => post<{ ok: true }>('/api/upnext/order', { origins }),
  launchJob: (job: { prompt: string; title?: string; kind?: string; branch?: string | null }) =>
    post<{ ok: true }>('/api/jobs', job),
  cancelJob: (id: string) => post<{ ok: true }>(`/api/jobs/${id}/cancel`),
  // A finding becomes work only here: the operator's click is the gate, because
  // an agent that could queue jobs could put agents on the fleet.
  promoteFinding: (id: string) => post<{ ok: true }>(`/api/findings/${id}/promote`),
  // The defer arm: a desk agent files it in the tracker and reports the ticket
  // back, so the work waits its turn there rather than on the fleet.
  fileFinding: (id: string) => post<{ ok: true }>(`/api/findings/${id}/file`),
  dismissFinding: (id: string) => post<{ ok: true }>(`/api/findings/${id}/dismiss`),
  // Decide what happens to an agent the last run left orphaned. Until every one of
  // these is answered the harness runs no cycles, so this is the one call that can
  // un-stick a cockpit whose fleet looks frozen.
  decideRecovery: (agentId: string, verdict: RecoveryVerdict) =>
    post<{ ok: true; remaining: number }>(`/api/recovery/${agentId}`, { verdict }),
  killAgent: (id: string) => post(`/api/agents/${id}/kill`),
  completeAgent: (id: string) => post(`/api/agents/${id}/complete`),
  interruptAgent: (id: string) => post(`/api/agents/${id}/interrupt`),
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
// whole cockpit out of reach of a test, and so out of reach of the skin tests
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
