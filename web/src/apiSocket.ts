import { token } from './apiTransport.js';

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

export function connectRealWs(onEvent: (ev: unknown) => void, onStatus?: (connected: boolean) => void): WsClient {
  return new ReconnectingWs(onEvent, onStatus);
}
