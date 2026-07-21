import { useCallback, useEffect, useRef, useState } from 'react';
import { api, connectWs } from './api.js';
import type { WsClient } from './api.js';
import type { AppState, Agent } from './types.js';
import { InjectPanel } from './components/InjectPanel.js';
import { AgentCard } from './components/AgentCard.js';
import { EscalationCard } from './components/EscalationCard.js';
import { AgentDrawer } from './components/AgentDrawer.js';
import { Vitals } from './components/Vitals.js';
import { DecisionLog } from './components/DecisionLog.js';
import { ActivityFeed } from './components/ActivityFeed.js';
import { statusDot } from './components/util.js';
import { useNow } from './hooks.js';

/**
 * The cockpit. One page: fleet + tasks on the left, the escalation inbox in the
 * middle, the audit log on the right, and a live agent drawer over the top when
 * you drill in. It refetches state on any `dirty` signal from the server and
 * streams agent output live over the same socket.
 */
export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [connected, setConnected] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  // Live per-agent output accumulated from WS deltas (only for subscribed agents).
  const liveOutput = useRef<Map<string, string>>(new Map());
  // Last output line per agent, fed by compact `agent:tail` frames — used for
  // fleet-card previews since full output no longer reaches every client.
  const tails = useRef<Map<string, string>>(new Map());
  // Stable reconnecting WS client so subscribe/unsubscribe survives effect churn.
  const wsRef = useRef<WsClient | null>(null);
  const [, forceRender] = useState(0);
  // Anchor for the heartbeat countdown: when the last pulse landed.
  const lastPulse = useRef<number>(Date.now());
  const now = useNow(1000);

  const refresh = useCallback(async () => {
    try {
      setState(await api.getState());
    } catch {
      /* transient */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const ws = connectWs(
      (ev) => {
        const e = ev as { type: string; agentId?: string; delta?: string; line?: string };
        if (e.type === 'dirty' || e.type === 'world:changed' || e.type === 'world:events') void refresh();
        else if (e.type === 'agent:output' && e.agentId && e.delta) {
          const cur = liveOutput.current.get(e.agentId) ?? '';
          // Full output now only arrives for the subscribed (open) agent, so we
          // keep a large scrollback (~1M chars) instead of the old 20k window —
          // the watched session no longer loses history. Capped to bound memory.
          liveOutput.current.set(e.agentId, (cur + e.delta).slice(-1_000_000));
          forceRender((n) => n + 1);
        } else if (e.type === 'agent:tail' && e.agentId && e.line) {
          tails.current.set(e.agentId, e.line);
          forceRender((n) => n + 1);
        } else if (e.type === 'cycle:end') {
          lastPulse.current = Date.now();
          void refresh();
        }
      },
      (isConnected) => setConnected(isConnected),
    );
    wsRef.current = ws;
    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [refresh]);

  // Subscribe to full output only while a drawer is open; unsubscribe on close/switch.
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || !selected) return;
    ws.subscribe(selected);
    return () => ws.unsubscribe(selected);
  }, [selected]);

  if (!state) return <div className="loading">Connecting to the cockpit…</div>;

  const liveAgents = state.agents.filter((a) => ['starting', 'running', 'waiting'].includes(a.status));
  const pastAgents = state.agents.filter((a) => !['starting', 'running', 'waiting'].includes(a.status));
  const openEscalations = state.escalations.filter((e) => e.status === 'open');
  const selectedAgent = state.agents.find((a) => a.id === selected) ?? null;

  // Heartbeat countdown: fraction of the interval elapsed since the last pulse.
  const interval = state.config.heartbeatIntervalMs;
  const sincePulse = now - lastPulse.current;
  const nextIn = Math.max(0, Math.ceil((interval - (sincePulse % interval)) / 1000));
  const beatPct = Math.min(100, ((sincePulse % interval) / interval) * 100);

  // Previews read the compact per-agent tail (last non-empty line) — full output
  // is no longer streamed to non-subscribed fleet cards.
  const lastLineFor = (id: string): string | undefined => tails.current.get(id);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="pulse-mark">♥</span> LubbDubb
          <span className="tagline">autonomous engineering cockpit</span>
        </div>
        <div className="topbar-meta">
          <div className="heartbeat" title={`Next heartbeat in ~${nextIn}s`}>
            <div className="heartbeat-track">
              <div className="heartbeat-fill" style={{ width: `${beatPct}%` }} />
            </div>
            <span className="heartbeat-label">next pulse ~{nextIn}s</span>
          </div>
          <span className={`chip ${connected ? 'ok' : 'bad'}`}>
            <span className={`dot ${connected ? 'green' : 'red'}`} /> {connected ? 'live' : 'offline'}
          </span>
          <span className="chip">dispatcher: {state.config.dispatcher}</span>
          <span className="chip">
            cap: {liveAgents.length}/{state.config.maxConcurrentAgents}
          </span>
          <button className="btn primary" onClick={() => api.pulse().then(refresh)}>
            Pulse now
          </button>
        </div>
      </header>

      <InjectPanel onInjected={refresh} world={state.world} />
      <Vitals state={state} liveAgents={liveAgents.length} cap={state.config.maxConcurrentAgents} />

      <main className="grid">
        <section className="col">
          <h2>
            Fleet <span className="count">{liveAgents.length}</span>
          </h2>
          {liveAgents.length === 0 && (
            <div className="empty-panel">
              <span className="empty-mark">♥</span>
              <p>No agents running. The harness is idle — inject an event to wake it.</p>
            </div>
          )}
          {liveAgents.map((a) => (
            <AgentCard
              key={a.id}
              agent={a}
              task={taskFor(state, a)}
              now={now}
              lastLine={lastLineFor(a.id)}
              onOpen={() => setSelected(a.id)}
              onKill={() => api.killAgent(a.id).then(refresh)}
            />
          ))}

          {pastAgents.length > 0 && <h3 className="muted">History</h3>}
          {pastAgents.slice(0, 8).map((a) => (
            <AgentCard key={a.id} agent={a} task={taskFor(state, a)} now={now} onOpen={() => setSelected(a.id)} past />
          ))}
        </section>

        <section className="col">
          <h2>
            Needs you <span className="count urgent">{openEscalations.length}</span>
          </h2>
          {openEscalations.length === 0 && (
            <div className="empty-panel calm">
              <span className="empty-mark">✓</span>
              <p>Inbox zero. Nothing needs your judgment.</p>
            </div>
          )}
          {openEscalations.map((e) => (
            <EscalationCard
              key={e.id}
              escalation={e}
              now={now}
              onAnswer={(text) => api.answerEscalation(e.id, text).then(refresh)}
            />
          ))}

          <h3 className="muted">World</h3>
          <WorldSummary state={state} />
        </section>

        <section className="col">
          <h2>Decision log</h2>
          <DecisionLog decisions={state.decisions} now={now} />
          <h2 className="feed-heading">Activity</h2>
          <ActivityFeed events={state.worldEvents} now={now} />
        </section>
      </main>

      {selectedAgent && (
        <AgentDrawer
          agent={selectedAgent}
          task={taskFor(state, selectedAgent)}
          live={liveOutput.current.get(selectedAgent.id)}
          onClose={() => setSelected(null)}
          onRespond={(text) => api.respondAgent(selectedAgent.id, text)}
          onKill={() => api.killAgent(selectedAgent.id).then(refresh)}
          onInterrupt={() => void api.interruptAgent(selectedAgent.id)}
        />
      )}
    </div>
  );
}

function taskFor(state: AppState, agent: Agent) {
  return state.tasks.find((t) => t.id === agent.taskId) ?? null;
}

function WorldSummary({ state }: { state: AppState }) {
  const { pullRequests, issues, stories, calendar } = state.world;
  return (
    <div className="world">
      <div className="world-row">
        <span>PRs</span>
        <b>{pullRequests.length}</b>
      </div>
      {pullRequests.map((pr) => (
        <div key={pr.id} className="world-item">
          {statusDot(pr.ciStatus)} #{pr.number} {pr.title}
          {pr.unresolvedComments.filter((c) => !c.handled).length > 0 && (
            <span className="chip small">{pr.unresolvedComments.filter((c) => !c.handled).length} comments</span>
          )}
          {pr.merged ? (
            <span className="chip small">merged</span>
          ) : (
            pr.ciStatus === 'passing' &&
            pr.approved &&
            pr.mergeable && <span className="chip small warn">merge-ready</span>
          )}
        </div>
      ))}
      <div className="world-row">
        <span>Issues</span>
        <b>{issues.length}</b>
      </div>
      {issues.map((i) => (
        <div key={i.id} className="world-item">
          #{i.number} {i.title} <span className="chip small">{i.state}</span>
          {i.state === 'open' && i.linkedPrNumber === null && <span className="chip small warn">needs PR</span>}
          {i.linkedPrNumber !== null && <span className="chip small">→ PR #{i.linkedPrNumber}</span>}
        </div>
      ))}
      <div className="world-row">
        <span>Stories</span>
        <b>{stories.length}</b>
      </div>
      {stories.map((s) => (
        <div key={s.id} className="world-item">
          {s.title} <span className="chip small">{s.state}</span>
          {(!s.description || !s.acceptanceCriteria) && <span className="chip small warn">needs grooming</span>}
          {s.wafPillars.length === 0 && <span className="chip small warn">no WAF</span>}
        </div>
      ))}
      <div className="world-row">
        <span>Meetings</span>
        <b>{calendar.length}</b>
      </div>
      {calendar.map((c) => (
        <div key={c.id} className="world-item">
          {c.title} {!c.prepDone && c.prepDocs.length > 0 && <span className="chip small warn">prep pending</span>}
        </div>
      ))}
    </div>
  );
}
