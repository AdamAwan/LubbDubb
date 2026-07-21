import { useCallback, useEffect, useRef, useState } from 'react';
import { api, connectWs } from './api.js';
import type { AppState, Agent, Escalation } from './types.js';
import { InjectPanel } from './components/InjectPanel.js';
import { AgentCard } from './components/AgentCard.js';
import { EscalationCard } from './components/EscalationCard.js';
import { AgentDrawer } from './components/AgentDrawer.js';
import { statusDot } from './components/util.js';

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
  // Live per-agent output accumulated from WS deltas.
  const liveOutput = useRef<Map<string, string>>(new Map());
  const [, forceRender] = useState(0);

  const refresh = useCallback(async () => {
    try {
      setState(await api.getState());
    } catch {
      /* transient */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const ws = connectWs((ev) => {
      const e = ev as { type: string; agentId?: string; delta?: string };
      if (e.type === 'dirty' || e.type === 'world:changed') void refresh();
      else if (e.type === 'agent:output' && e.agentId && e.delta) {
        const cur = liveOutput.current.get(e.agentId) ?? '';
        liveOutput.current.set(e.agentId, (cur + e.delta).slice(-20000));
        forceRender((n) => n + 1);
      } else if (e.type === 'cycle:end') {
        void refresh();
      }
    });
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    return () => ws.close();
  }, [refresh]);

  if (!state) return <div className="loading">Connecting to the cockpit…</div>;

  const liveAgents = state.agents.filter((a) => ['starting', 'running', 'waiting'].includes(a.status));
  const pastAgents = state.agents.filter((a) => !['starting', 'running', 'waiting'].includes(a.status));
  const openEscalations = state.escalations.filter((e) => e.status === 'open');
  const selectedAgent = state.agents.find((a) => a.id === selected) ?? null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="pulse-mark">♥</span> LubbDubb
          <span className="tagline">autonomous engineering cockpit</span>
        </div>
        <div className="topbar-meta">
          <span className={`chip ${connected ? 'ok' : 'bad'}`}>{connected ? 'live' : 'disconnected'}</span>
          <span className="chip">dispatcher: {state.config.dispatcher}</span>
          <span className="chip">heartbeat: {Math.round(state.config.heartbeatIntervalMs / 1000)}s</span>
          <span className="chip">cap: {liveAgents.length}/{state.config.maxConcurrentAgents}</span>
          <button className="btn primary" onClick={() => api.pulse().then(refresh)}>Pulse now</button>
        </div>
      </header>

      <InjectPanel onInjected={refresh} world={state.world} />

      <main className="grid">
        <section className="col">
          <h2>Fleet <span className="count">{liveAgents.length}</span></h2>
          {liveAgents.length === 0 && <p className="empty">No agents running. The harness is idle.</p>}
          {liveAgents.map((a) => (
            <AgentCard key={a.id} agent={a} task={taskFor(state, a)} onOpen={() => setSelected(a.id)} onKill={() => api.killAgent(a.id).then(refresh)} />
          ))}

          {pastAgents.length > 0 && <h3 className="muted">History</h3>}
          {pastAgents.slice(0, 8).map((a) => (
            <AgentCard key={a.id} agent={a} task={taskFor(state, a)} onOpen={() => setSelected(a.id)} past />
          ))}
        </section>

        <section className="col">
          <h2>Needs you <span className="count urgent">{openEscalations.length}</span></h2>
          {openEscalations.length === 0 && <p className="empty">Inbox zero. Nothing needs your judgment.</p>}
          {openEscalations.map((e) => (
            <EscalationCard key={e.id} escalation={e} onAnswer={(text) => api.answerEscalation(e.id, text).then(refresh)} />
          ))}

          <h3 className="muted">World</h3>
          <WorldSummary state={state} />
        </section>

        <section className="col">
          <h2>Decision log</h2>
          <div className="auditlog">
            {state.decisions.map((d) => (
              <div key={d.id} className={`audit ${d.outcome}`}>
                <span className={`badge ${d.outcome}`}>{d.outcome}</span>
                <span className="audit-type">{d.action.type}</span>
                <div className="audit-detail">{d.detail}</div>
              </div>
            ))}
          </div>
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
        />
      )}
    </div>
  );
}

function taskFor(state: AppState, agent: Agent) {
  return state.tasks.find((t) => t.id === agent.taskId) ?? null;
}

function WorldSummary({ state }: { state: AppState }) {
  const { pullRequests, stories, calendar } = state.world;
  return (
    <div className="world">
      <div className="world-row"><span>PRs</span><b>{pullRequests.length}</b></div>
      {pullRequests.map((pr) => (
        <div key={pr.id} className="world-item">
          {statusDot(pr.ciStatus)} #{pr.number} {pr.title}
          {pr.unresolvedComments.filter((c) => !c.handled).length > 0 && (
            <span className="chip small">{pr.unresolvedComments.filter((c) => !c.handled).length} comments</span>
          )}
        </div>
      ))}
      <div className="world-row"><span>Stories</span><b>{stories.length}</b></div>
      {stories.map((s) => (
        <div key={s.id} className="world-item">
          {s.title} <span className="chip small">{s.state}</span>
          {(!s.description || !s.acceptanceCriteria) && <span className="chip small warn">needs grooming</span>}
          {s.wafPillars.length === 0 && <span className="chip small warn">no WAF</span>}
        </div>
      ))}
      <div className="world-row"><span>Meetings</span><b>{calendar.length}</b></div>
      {calendar.map((c) => (
        <div key={c.id} className="world-item">
          {c.title} {!c.prepDone && c.prepDocs.length > 0 && <span className="chip small warn">prep pending</span>}
        </div>
      ))}
    </div>
  );
}
