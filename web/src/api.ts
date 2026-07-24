import type { AppState } from './types.js';
import { demoApi, connectDemoWs } from './demo/demoBackend.js';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

const realApi = {
  getState: () => fetch('/api/state').then((r) => json<AppState>(r)),
  getTranscript: (agentId: string) =>
    fetch(`/api/agents/${agentId}/transcript`).then((r) => json<{ transcript: string }>(r)),
  pulse: () => fetch('/api/pulse', { method: 'POST' }).then((r) => json(r)),
  inject: (event: unknown) =>
    fetch('/api/inject', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
    }).then((r) => json(r)),
  answerEscalation: (id: string, response: string) =>
    fetch(`/api/escalations/${id}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ response }),
    }).then((r) => json(r)),
  respondAgent: (id: string, text: string) =>
    fetch(`/api/agents/${id}/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    }).then((r) => json(r)),
  setControl: (patch: { cap?: number; paused?: boolean }) =>
    fetch('/api/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).then((r) => json<{ ok: true; cap: number; paused: boolean }>(r)),
  setPrExcluded: (prNumber: number, excluded: boolean) =>
    fetch(`/api/prs/${prNumber}/exclude`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ excluded }),
    }).then((r) => json<{ ok: true; excluded: boolean }>(r)),
  setIssueWatched: (issueNumber: number, watched: boolean) =>
    fetch(`/api/issues/${issueNumber}/watch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ watched }),
    }).then((r) => json<{ ok: true; watched: boolean }>(r)),
  launchJob: (job: { prompt: string; title?: string; kind?: string; branch?: string | null }) =>
    fetch('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(job),
    }).then((r) => json<{ ok: true }>(r)),
  cancelJob: (id: string) => fetch(`/api/jobs/${id}/cancel`, { method: 'POST' }).then((r) => json<{ ok: true }>(r)),
  killAgent: (id: string) => fetch(`/api/agents/${id}/kill`, { method: 'POST' }).then((r) => json(r)),
  interruptAgent: (id: string) => fetch(`/api/agents/${id}/interrupt`, { method: 'POST' }).then((r) => json(r)),
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
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
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
const DEMO = import.meta.env.VITE_DEMO === '1';

/** True when running against the fake backend (the GitHub Pages demo build). */
export const isDemo = DEMO;
export const api = DEMO ? demoApi : realApi;
export const connectWs: typeof connectRealWs = DEMO ? connectDemoWs : connectRealWs;
