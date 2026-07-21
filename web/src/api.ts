import type { AppState } from './types.js';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export const api = {
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
  killAgent: (id: string) => fetch(`/api/agents/${id}/kill`, { method: 'POST' }).then((r) => json(r)),
};

/** Open the live event socket, calling `onEvent` for every message. */
export function connectWs(onEvent: (ev: unknown) => void): WebSocket {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data as string));
    } catch {
      /* ignore malformed frames */
    }
  };
  return ws;
}
