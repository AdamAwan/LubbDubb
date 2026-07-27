import { useCallback, useEffect, useRef, useState } from 'react';
import { api, connectWs, isDemo, UnauthorizedError } from './api.js';
import type { WsClient } from './api.js';
import type { AppState, Agent, Issue, PullRequest } from './types.js';
import { InjectPanel } from './components/InjectPanel.js';
import { AgentCard } from './components/AgentCard.js';
import { EscalationCard } from './components/EscalationCard.js';
import { AgentDrawer } from './components/AgentDrawer.js';
import { Vitals } from './components/Vitals.js';
import { FleetControl } from './components/FleetControl.js';
import { LaunchPanel } from './components/LaunchPanel.js';
import { UsageChip } from './components/UsageChip.js';
import { DecisionLog } from './components/DecisionLog.js';
import { UpNext } from './components/UpNext.js';
import { PlanPanel } from './components/PlanPanel.js';
import { FindingsPanel } from './components/FindingsPanel.js';
import { OverlapPanel } from './components/OverlapPanel.js';
import { RecoveryPanel } from './components/RecoveryPanel.js';
import { ActivityFeed } from './components/ActivityFeed.js';
import { ErrorsPanel } from './components/ErrorsPanel.js';
import { AsyncButton } from './components/AsyncButton.js';
import { statusDot, refLink, relTime } from './components/util.js';
import { watchBucket, type WatchBucket } from './worldBuckets.js';
import { useNow } from './hooks.js';

/**
 * How long a refetch waits so a burst of live signals collapses into one request.
 * Short enough to read as immediate, long enough to swallow the four signals one
 * pulse emits and the per-file ones an agent's writes emit.
 */
const REFRESH_COALESCE_MS = 200;

/**
 * What the cockpit shows when the harness refuses its credential. Worth a screen
 * rather than a silent retry: the fix is a URL only the operator's terminal has,
 * so an unexplained "Connecting…" would leave them looking at the browser for a
 * problem whose answer is in the server log.
 */
function LockedOut({ error }: { error: UnauthorizedError }) {
  return (
    <div className="loading locked-out">
      <h1>{error.message}</h1>
      {error.status === 403 ? (
        <p>
          The harness refused this request&apos;s origin. Open the cockpit on <code>localhost</code> or{' '}
          <code>127.0.0.1</code> — a different hostname pointing at this machine is refused on purpose.
        </p>
      ) : (
        <p>
          Open the tokenised link the harness printed at startup — the <code>[lubbdubb] open the cockpit: …</code> line
          in its terminal. The token is stored per browser, so this is a one-off per machine.
        </p>
      )}
      <p className="muted">
        Running <code>npm start</code> again prints the same link; the token is reused across restarts.
      </p>
    </div>
  );
}

/**
 * The cockpit. One page: fleet + tasks on the left, the escalation inbox in the
 * middle, the audit log on the right, and a live agent drawer over the top when
 * you drill in. It refetches state on any `dirty` signal from the server and
 * streams agent output live over the same socket.
 */
export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [denied, setDenied] = useState<UnauthorizedError | null>(null);
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

  // Coalescing state for `scheduleRefresh`: the pending trailing timer, whether a
  // fetch is in flight, and whether a signal arrived while one was.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshing = useRef(false);
  const refreshQueued = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setState(await api.getState());
      setDenied(null);
    } catch (err) {
      // A refused credential is the one fetch failure that never resolves itself
      // by retrying, so it gets a screen. Everything else is a transient the next
      // poll fixes, and must not replace a working cockpit with an error page.
      if (err instanceof UnauthorizedError) setDenied(err);
    }
  }, []);

  /**
   * Refetch the whole snapshot, coalescing bursts into one request. Every live
   * signal lands here, and the server pairs a coarse `dirty` with almost every
   * specific frame — so one pulse alone is four signals, and `agents.on('files')`
   * fires once *per file an agent writes*. Fetching per signal made the request
   * rate a function of agent tool-call volume.
   *
   * At most one request in flight and at most one queued behind it, plus a short
   * trailing window so a burst collapses. The queued one always runs: coalescing
   * may merge the signals in between but must never drop the last, or the cockpit
   * settles on a state older than what it was told about.
   */
  const scheduleRefresh = useCallback(() => {
    if (refreshing.current) {
      refreshQueued.current = true;
      return;
    }
    if (refreshTimer.current) return; // a trailing fetch is already pending
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      refreshing.current = true;
      void refresh().finally(() => {
        refreshing.current = false;
        if (refreshQueued.current) {
          refreshQueued.current = false;
          scheduleRefresh();
        }
      });
    }, REFRESH_COALESCE_MS);
  }, [refresh]);

  useEffect(() => {
    void refresh();
    const ws = connectWs(
      (ev) => {
        const e = ev as { type: string; agentId?: string; delta?: string; line?: string; text?: string };
        if (
          e.type === 'dirty' ||
          e.type === 'world:changed' ||
          e.type === 'control:changed' ||
          e.type === 'world:events'
        )
          scheduleRefresh();
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
          scheduleRefresh();
        }
      },
      (isConnected) => setConnected(isConnected),
    );
    wsRef.current = ws;
    return () => {
      ws.close();
      wsRef.current = null;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [refresh, scheduleRefresh]);

  // Subscribe to full output only while a drawer is open; unsubscribe on close/switch.
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || !selected) return;
    ws.subscribe(selected);
    return () => ws.unsubscribe(selected);
  }, [selected]);

  if (denied) return <LockedOut error={denied} />;
  if (!state) return <div className="loading">Connecting to the cockpit…</div>;

  // Agents the previous run orphaned. Non-empty ⇒ the harness is holding every
  // pulse, which is why this drives a banner and the heartbeat chip below.
  const crashedAgents = state.recovery ?? [];
  const liveAgents = state.agents.filter((a) => ['starting', 'running', 'waiting'].includes(a.status));
  const pastAgents = state.agents.filter((a) => !['starting', 'running', 'waiting'].includes(a.status));
  const openEscalations = state.escalations.filter((e) => e.status === 'open');
  // The act an inbox item asks you to authorize, if it is one. Keyed by escalation
  // so a decision-bearing card offers accept/reject instead of a text box — free
  // text is exactly what the harness could never act on (issue #109).
  const proposalFor = new Map((state.proposals ?? []).map((p) => [p.escalationId ?? '', p]));
  // An inbox item's staleness is derived here rather than shipped: `resumedAt` is
  // already on the agent row, and the join is the escalation's own `agentId`.
  const agentById = new Map(state.agents.map((a) => [a.id, a]));
  // Findings awaiting an operator's call — the count on the panel heading. A
  // finding never expires into work on its own, so this is the only nudge there is.
  const openFindings = (state.findings ?? []).filter((f) => f.status === 'open').length;
  // Overlaps still in flight — the only ones an operator can still do anything
  // about. A settled one stays in the panel as the record of what collided.
  const liveOverlaps = (state.overlaps ?? []).filter((o) => o.live).length;
  const selectedAgent = state.agents.find((a) => a.id === selected) ?? null;

  // Heartbeat countdown: fraction of the interval elapsed since the last pulse.
  const interval = state.config.heartbeatIntervalMs;
  const sincePulse = now - lastPulse.current;
  const nextIn = Math.max(0, Math.ceil((interval - (sincePulse % interval)) / 1000));
  const beatPct = Math.min(100, ((sincePulse % interval) / interval) * 100);

  // Previews read the compact per-agent tail (last non-empty line) — full output
  // is no longer streamed to non-subscribed fleet cards.
  const lastLineFor = (id: string): string | undefined => tails.current.get(id);

  // Artifacts agents flagged mid-run, grouped by agent for the card/drawer. The
  // `dirty` that rides with each `agent:flag` refetches state, so this stays live.
  const flagsByAgent = new Map<string, typeof state.flags>();
  for (const f of state.flags ?? []) {
    const list = flagsByAgent.get(f.agentId) ?? [];
    list.push(f);
    flagsByAgent.set(f.agentId, list);
  }

  // Every file agents wrote (file-events hook), grouped by agent for the drawer's
  // "files changed" list. Kept live by the `dirty` that rides each files update.
  const filesByAgent = new Map<string, typeof state.files>();
  for (const f of state.files ?? []) {
    const list = filesByAgent.get(f.agentId) ?? [];
    list.push(f);
    filesByAgent.set(f.agentId, list);
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="pulse-mark">♥</span> LubbDubb
          <span className="tagline">autonomous engineering cockpit</span>
          {isDemo && (
            <span className="chip warn" title="Simulated data — no server or real integrations">
              demo
            </span>
          )}
        </div>
        <div className="topbar-meta">
          {/* A countdown to a pulse that will not run is worse than no countdown:
              it reads as a healthy harness that simply never does anything. */}
          <div
            className={`heartbeat ${crashedAgents.length > 0 ? 'held' : ''}`}
            title={
              crashedAgents.length > 0
                ? 'Held: agents from the previous run need a recovery decision'
                : `Next heartbeat in ~${nextIn}s`
            }
          >
            <div className="heartbeat-track">
              <div className="heartbeat-fill" style={{ width: crashedAgents.length > 0 ? '100%' : `${beatPct}%` }} />
            </div>
            <span className="heartbeat-label">
              {crashedAgents.length > 0 ? 'pulse held' : `next pulse ~${nextIn}s`}
            </span>
          </div>
          {/* The world here is the baseline the last pulse persisted, not a live
              provider read — so its age is stated rather than implied. A reading
              that keeps ageing past an interval is the visible symptom of pulses
              failing, which no countdown can show. */}
          <span
            className="chip"
            title="The world as the last pulse observed it — the cockpit itself never polls the provider"
          >
            world {state.worldObservedAt ? relTime(state.worldObservedAt, now) : 'not yet observed'}
          </span>
          <span className={`chip ${connected ? 'ok' : 'bad'}`}>
            <span className={`dot ${connected ? 'green' : 'red'}`} /> {connected ? 'live' : 'offline'}
          </span>
          <UsageChip usage={state.usage} now={now} />
          <span className="chip">dispatcher: {state.config.dispatcher}</span>
          {state.control.paused && <span className="chip warn">paused</span>}
          <FleetControl live={liveAgents.length} cap={state.control.cap} paused={state.control.paused} />
          <AsyncButton className="primary" onClick={() => api.pulse().then(refresh)}>
            Pulse now
          </AsyncButton>
        </div>
      </header>

      {/* First thing under the topbar, above even the inject panel: while this is
          up the harness runs no cycles, so anything an operator did on the panels
          below would sit unread until these are answered. */}
      {crashedAgents.length > 0 && (
        <RecoveryPanel
          crashed={crashedAgents}
          now={now}
          refUrls={state.refUrls}
          onDecide={(agentId, verdict) => api.decideRecovery(agentId, verdict).then(refresh)}
        />
      )}

      {state.config.injectable && <InjectPanel onInjected={refresh} world={state.world} />}
      <LaunchPanel jobs={state.jobs} onChanged={refresh} />
      <Vitals state={state} liveAgents={liveAgents.length} cap={state.control.cap} />

      <main className="grid">
        <section className="col">
          <h2>
            Fleet <span className="count">{liveAgents.length}</span>
          </h2>
          {liveAgents.length === 0 && (
            <div className="empty-panel">
              <span className="empty-mark">♥</span>
              <p>
                No agents running. The harness is idle
                {state.config.injectable ? ' — inject an event to wake it' : ' — waiting for the world to change'}.
              </p>
            </div>
          )}
          {liveAgents.map((a) => (
            <AgentCard
              key={a.id}
              agent={a}
              task={taskFor(state, a)}
              now={now}
              refUrls={state.refUrls}
              lastLine={lastLineFor(a.id)}
              flags={flagsByAgent.get(a.id)}
              artifactUrls={state.artifactUrls ?? {}}
              onOpen={() => setSelected(a.id)}
              onKill={() => api.killAgent(a.id).then(refresh)}
              onComplete={() => api.completeAgent(a.id).then(refresh)}
            />
          ))}

          {pastAgents.length > 0 && <h3 className="muted">History</h3>}
          {pastAgents.slice(0, 8).map((a) => (
            <AgentCard
              key={a.id}
              agent={a}
              task={taskFor(state, a)}
              now={now}
              refUrls={state.refUrls}
              flags={flagsByAgent.get(a.id)}
              artifactUrls={state.artifactUrls ?? {}}
              onOpen={() => setSelected(a.id)}
              past
            />
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
              proposal={proposalFor.get(e.id)}
              resumedAt={e.agentId ? (agentById.get(e.agentId)?.resumedAt ?? null) : null}
              now={now}
              refUrls={state.refUrls}
              onAnswer={(text) => api.answerEscalation(e.id, text).then(refresh)}
              onDecide={(id, verdict, note) =>
                (verdict === 'accept' ? api.acceptProposal(id, note) : api.rejectProposal(id, note)).then(refresh)
              }
              onPermission={(id, allow, note) => api.decidePermission(id, allow, note).then(refresh)}
              onDismiss={(id, note) => api.dismissEscalation(id, note).then(refresh)}
              onOpenAgent={(id) => setSelected(id)}
              onComplete={(id) => api.completeAgent(id).then(refresh)}
            />
          ))}

          {(state.plans?.length ?? 0) > 0 && (
            <>
              <h3 className="muted">Plans</h3>
              <PlanPanel
                plans={state.plans ?? []}
                parts={state.planParts ?? []}
                upcoming={state.upcoming?.items ?? []}
                now={now}
                refUrls={state.refUrls}
                onReplan={(planId) => api.replan(planId).then(refresh)}
              />
            </>
          )}

          {(state.findings?.length ?? 0) > 0 && (
            <>
              <h3 className="muted">
                Findings
                {openFindings > 0 && <span className="count">{openFindings}</span>}
              </h3>
              <FindingsPanel
                findings={state.findings ?? []}
                now={now}
                refUrls={state.refUrls}
                onPromote={(id) => api.promoteFinding(id).then(refresh)}
                onDismiss={(id) => api.dismissFinding(id).then(refresh)}
              />
            </>
          )}

          {(state.overlaps?.length ?? 0) > 0 && (
            <>
              <h3 className="muted">
                File overlaps
                {liveOverlaps > 0 && <span className="count">{liveOverlaps}</span>}
              </h3>
              <OverlapPanel overlaps={state.overlaps ?? []} now={now} refUrls={state.refUrls} />
            </>
          )}

          <h3 className="muted">World</h3>
          <WorldSummary
            state={state}
            onToggleExclude={(prNumber, excluded) => api.setPrExcluded(prNumber, excluded).then(refresh)}
            onToggleIssueWatch={(issueNumber, watched) => api.setIssueWatched(issueNumber, watched).then(refresh)}
            onToggleStoryWatch={(storyId, watched) => api.setStoryWatched(storyId, watched).then(refresh)}
          />
        </section>

        <section className="col">
          <h2>
            Up next
            {(state.upcoming?.items.length ?? 0) > 0 && <span className="count">{state.upcoming!.items.length}</span>}
          </h2>
          <UpNext
            plan={state.upcoming ?? null}
            now={now}
            refUrls={state.refUrls}
            rules={state.dispatchRules}
            onReorder={(origins) => api.reorderUpNext(origins).then(refresh)}
          />
          <h2 className="feed-heading">Decision log</h2>
          <DecisionLog
            decisions={state.decisions}
            proposals={state.proposals}
            now={now}
            refUrls={state.refUrls}
            rules={state.dispatchRules}
          />
          <h2 className="feed-heading">Activity</h2>
          <ActivityFeed events={state.worldEvents} now={now} />
          <h2 className="feed-heading">
            Errors <span className={`count${state.errors.length > 0 ? ' urgent' : ''}`}>{state.errors.length}</span>
          </h2>
          <ErrorsPanel errors={state.errors} now={now} />
        </section>
      </main>

      {selectedAgent && (
        <AgentDrawer
          agent={selectedAgent}
          task={taskFor(state, selectedAgent)}
          refUrls={state.refUrls}
          live={liveOutput.current.get(selectedAgent.id)}
          flags={flagsByAgent.get(selectedAgent.id)}
          artifactUrls={state.artifactUrls ?? {}}
          files={filesByAgent.get(selectedAgent.id)}
          onClose={() => setSelected(null)}
          onRespond={(text) => api.respondAgent(selectedAgent.id, text)}
          onKill={() => api.killAgent(selectedAgent.id).then(refresh)}
          onComplete={() => api.completeAgent(selectedAgent.id).then(refresh)}
          onInterrupt={() => api.interruptAgent(selectedAgent.id)}
        />
      )}
    </div>
  );
}

function taskFor(state: AppState, agent: Agent) {
  return state.tasks.find((t) => t.id === agent.taskId) ?? null;
}

/**
 * The per-issue pickup chip (mirrors the PR health chip): what the harness is
 * doing with the item, or the first reason it's leaving it alone — full reasons
 * in the title. `done`/`has_pr` stay silent: the state chip and the "→ PR" chip
 * already say it. No verdict (older server) renders nothing.
 */
function pickupChip(pickup: Issue['pickup']) {
  if (!pickup || pickup.status === 'done' || pickup.status === 'has_pr') return null;
  if (pickup.status === 'eligible') {
    return (
      <span className="chip small" title="Would be picked up next cycle">
        eligible
      </span>
    );
  }
  const calm = pickup.status === 'active'; // an agent on it is progress, not a warning
  return (
    <span className={`chip small${calm ? '' : ' warn'}`} title={pickup.reasons.join(', ')}>
      {pickup.reasons[0] ?? pickup.status}
      {pickup.reasons.length > 1 ? ` +${pickup.reasons.length - 1}` : ''}
    </span>
  );
}

/** How each attention arm reads on the chip. `done`/`ignored` are omitted — see below. */
const COURT_LABEL: Record<string, string> = {
  you: 'your turn',
  harness: 'harness on it',
  elsewhere: 'waiting on others',
  settled: 'settled',
  stalled: 'stalled',
};

/**
 * The per-PR attention chip: *whose turn* the PR is on, with the reasons in the
 * title. It names the court and nothing else, because scanning a list for "what
 * is mine" is the thing it exists for — the health chip beside it carries the
 * visible detail of *why*.
 *
 * `done` and `ignored` render nothing: the row already draws a "merged" and an
 * "ignored" chip, and one home per fact. Only the two arms that are genuinely
 * asking for a person — your court, and the PR nothing is happening on — warn.
 */
function attentionChip(attention: PullRequest['attention']) {
  const label = attention ? COURT_LABEL[attention.status] : undefined;
  if (!attention || !label) return null;
  const warn = attention.status === 'you' || attention.status === 'stalled';
  return (
    <span className={`chip small${warn ? ' warn' : ''}`} title={attention.reasons.join(', ')}>
      {label}
    </span>
  );
}

const TABS: WatchBucket[] = ['watched', 'unwatched', 'ignored'];
const TAB_LABEL: Record<WatchBucket, string> = {
  watched: 'Watched',
  unwatched: 'Unwatched',
  ignored: 'Ignored',
};
/** Why each tab exists, on the tab itself — the labels alone don't say what the harness does. */
const TAB_TITLE: Record<WatchBucket, string> = {
  watched: 'The harness works these',
  unwatched: 'Not opted in — nothing will happen until you watch one',
  ignored: 'You tagged these leave-alone',
};

function WorldSummary({
  state,
  onToggleExclude,
  onToggleIssueWatch,
  onToggleStoryWatch,
}: {
  state: AppState;
  onToggleExclude: (prNumber: number, excluded: boolean) => Promise<unknown> | unknown;
  onToggleIssueWatch: (issueNumber: number, watched: boolean) => Promise<unknown> | unknown;
  onToggleStoryWatch: (storyId: string, watched: boolean) => Promise<unknown> | unknown;
}) {
  const [tab, setTab] = useState<WatchBucket>('watched');
  const { pullRequests, issues, stories } = state.world;
  // Newest first: a PR you were watching disappears mid-session otherwise, with
  // nothing to say whether it landed or was abandoned.
  const recentlyClosed = [...(state.world.closedPullRequests ?? [])].sort((a, b) =>
    (b.closedAt ?? '').localeCompare(a.closedAt ?? ''),
  );
  const { refUrls } = state;
  const tag = state.config.ignoreLabel;
  const { watchLabel, ignoreLabel } = state.config;
  // Both labels empty means the operator turned the gates off (`labelPrefix: ''`):
  // every item then sits on its type default, so two of the three tabs could only
  // ever be empty *and* filtering to `watched` would hide every issue. So the tab
  // bar isn't just hidden — nothing is filtered at all, and the panel reads exactly
  // as it did before.
  const gated = Boolean(watchLabel || ignoreLabel);
  const prBucket = (labels: string[] | undefined) =>
    watchBucket(labels, { watchLabel, ignoreLabel, defaultWatched: true });
  const itemBucket = (labels: string[] | undefined) =>
    watchBucket(labels, { watchLabel, ignoreLabel, defaultWatched: false });
  const inTab = (bucket: WatchBucket) => !gated || bucket === tab;

  // The counts on the tabs are of live world items only — a recently-closed PR is
  // news about work that has already ended, so counting it would have the Watched
  // number climb as things finish.
  const counts: Record<WatchBucket, number> = { watched: 0, unwatched: 0, ignored: 0 };
  for (const pr of pullRequests) counts[prBucket(pr.labels)]++;
  for (const i of issues) counts[itemBucket(i.labels)]++;
  for (const s of stories) counts[itemBucket(s.labels)]++;

  const visiblePrs = pullRequests.filter((pr) => inTab(prBucket(pr.labels)));
  const visibleIssues = issues.filter((i) => inTab(itemBucket(i.labels)));
  const visibleStories = stories.filter((s) => inTab(itemBucket(s.labels)));
  // "Recently closed" lives in the Watched tab alone: it exists so a PR you were
  // following doesn't silently vanish mid-session, which is a statement to someone
  // monitoring. Bucketing those rows by their own labels would scatter them.
  const showClosed = (!gated || tab === 'watched') && recentlyClosed.length > 0;
  // Whatever tab a row is filed under already states its watch state, so the chips
  // that only repeat it are dropped. The pickup chip is safe to drop wholesale
  // here — its one arm carrying more than the tag (the Azure state gate, reported
  // as `unwatched`) fires on *labels* the bucket reads as watched, so it lands in
  // the Watched tab and renders in full.
  const showPickupChip = !gated || tab === 'watched';
  // A linked PR that isn't open is a closed one `linkedPrNumber` stayed pointing at
  // — read off the same list `openPrForIssue` is given, so the two can't disagree.
  const openPrNumbers = new Set(pullRequests.filter((pr) => !pr.merged).map((pr) => pr.number));

  return (
    <div className="world">
      {gated && (
        <div className="world-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={t === tab}
              className={`world-tab${t === tab ? ' on' : ''}`}
              onClick={() => setTab(t)}
              title={TAB_TITLE[t]}
            >
              {TAB_LABEL[t]} <span className="count">{counts[t]}</span>
            </button>
          ))}
        </div>
      )}
      {counts[tab] === 0 && gated && (
        <div className="world-empty">no {TAB_LABEL[tab].toLowerCase()} PRs, issues or stories</div>
      )}
      {visiblePrs.length > 0 && (
        <div className="world-row">
          <span>PRs</span>
          <b>{visiblePrs.length}</b>
        </div>
      )}
      {visiblePrs.map((pr) => {
        const isExcluded = (pr.labels ?? []).includes(tag);
        return (
          <div key={pr.id} className={`world-item${isExcluded ? ' excluded' : ''}`}>
            {statusDot(pr.ciStatus)} {refLink(`#${pr.number}`, refUrls)} {pr.title}
            {pr.unresolvedComments.filter((c) => !c.handled).length > 0 && (
              <span className="chip small">{pr.unresolvedComments.filter((c) => !c.handled).length} comments</span>
            )}
            {attentionChip(pr.attention)}
            {isExcluded ? (
              showPickupChip && (
                <span className="chip small" title={`Tagged "${tag}" — the harness is leaving this PR alone`}>
                  ignored
                </span>
              )
            ) : pr.merged ? (
              <span className="chip small">merged</span>
            ) : pr.health?.blocked ? (
              <span className="chip small warn" title={pr.health.reasons.join(', ')}>
                {pr.health.reasons[0]}
                {pr.health.reasons.length > 1 ? ` +${pr.health.reasons.length - 1}` : ''}
              </span>
            ) : (
              pr.ciStatus === 'passing' &&
              pr.approved &&
              pr.mergeable && <span className="chip small warn">merge-ready</span>
            )}
            {!pr.merged && (
              <AsyncButton
                className="ghost world-toggle"
                onClick={() => onToggleExclude(pr.number, !isExcluded)}
                title={
                  isExcluded
                    ? `Remove the "${tag}" tag and let the harness work this PR again`
                    : `Tag this PR "${tag}" so the harness leaves it alone (for a PR blocked on something it can't fix)`
                }
              >
                {isExcluded ? 'watch' : 'ignore'}
              </AsyncButton>
            )}
          </div>
        );
      })}
      {showClosed && (
        <>
          <div className="world-row">
            <span>Recently closed</span>
            <b>{recentlyClosed.length}</b>
          </div>
          {recentlyClosed.map((pr) => (
            <div key={pr.id} className="world-item excluded">
              {refLink(`#${pr.number}`, refUrls)} {pr.title}
              <span
                className={`chip small${pr.state === 'merged' ? '' : ' warn'}`}
                title={pr.closedAt ? `${pr.state === 'merged' ? 'Merged' : 'Closed'} ${pr.closedAt}` : undefined}
              >
                {pr.state === 'merged' ? 'merged' : 'closed unmerged'}
              </span>
            </div>
          ))}
        </>
      )}
      {visibleIssues.length > 0 && (
        <div className="world-row">
          <span>Issues</span>
          <b>{visibleIssues.length}</b>
        </div>
      )}
      {visibleIssues.map((i) => {
        const isIgnored = (i.labels ?? []).includes(ignoreLabel);
        const watched = itemBucket(i.labels) === 'watched';
        const resolved = i.state !== 'open' || i.linkedPrNumber !== null;
        const linkLive = i.linkedPrNumber !== null && openPrNumbers.has(i.linkedPrNumber);
        return (
          <div key={i.id} className={`world-item${isIgnored ? ' excluded' : ''}`}>
            {refLink(`#${i.number}`, refUrls)} {i.title} <span className="chip small">{i.state}</span>
            {isIgnored && showPickupChip && (
              <span className="chip small" title={`Tagged "${ignoreLabel}" — the harness is leaving this issue alone`}>
                ignored
              </span>
            )}
            {showPickupChip && pickupChip(i.pickup)}
            {i.linkedPrNumber !== null && (
              <span
                className={`chip small${linkLive ? '' : ' stale'}`}
                title={
                  linkLive
                    ? undefined
                    : // Never "merged" or "closed": the PR left the open list, and which
                      // of the two that was is not something the harness observed.
                      'That PR is no longer open — the link is the last one that ever referenced this issue'
                }
              >
                → PR {refLink(`#${i.linkedPrNumber}`, refUrls)}
                {!linkLive && ' (not open)'}
              </span>
            )}
            {!resolved && (
              <AsyncButton
                className="ghost world-toggle"
                onClick={() => onToggleIssueWatch(i.number, !watched)}
                title={
                  watched
                    ? `Remove "${watchLabel}" so the harness leaves this issue alone`
                    : `Tag this issue "${watchLabel}" so the harness picks it up`
                }
              >
                {watched ? 'ignore' : 'watch'}
              </AsyncButton>
            )}
          </div>
        );
      })}
      {visibleStories.length > 0 && (
        <div className="world-row">
          <span>Stories</span>
          <b>{visibleStories.length}</b>
        </div>
      )}
      {visibleStories.map((s) => {
        const isIgnored = (s.labels ?? []).includes(ignoreLabel);
        const watched = itemBucket(s.labels) === 'watched';
        return (
          <div key={s.id} className={`world-item${isIgnored ? ' excluded' : ''}`}>
            {s.title} <span className="chip small">{s.state}</span>
            {isIgnored && showPickupChip && (
              <span className="chip small" title={`Tagged "${ignoreLabel}" — the harness is leaving this story alone`}>
                ignored
              </span>
            )}
            {!isIgnored && !watched && showPickupChip && (
              <span className="chip small" title={`No "${watchLabel}" tag — the harness isn't picking this story up`}>
                unwatched
              </span>
            )}
            {(!s.description || !s.acceptanceCriteria) && <span className="chip small warn">needs grooming</span>}
            {s.wafPillars.length === 0 && <span className="chip small warn">no WAF</span>}
            <AsyncButton
              className="ghost world-toggle"
              onClick={() => onToggleStoryWatch(s.id, !watched)}
              title={
                watched
                  ? `Remove "${watchLabel}" so the harness leaves this story alone`
                  : `Tag this story "${watchLabel}" so the harness picks it up`
              }
            >
              {watched ? 'ignore' : 'watch'}
            </AsyncButton>
          </div>
        );
      })}
    </div>
  );
}
