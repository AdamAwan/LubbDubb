import type { SkinProps } from '../types.js';
import { InjectPanel } from '../../components/InjectPanel.js';
import { EscalationCard } from '../../components/EscalationCard.js';
import { AgentDrawer } from '../../components/AgentDrawer.js';
import { FleetControl } from '../../components/FleetControl.js';
import { LaunchPanel } from '../../components/LaunchPanel.js';
import { UsageChip } from '../../components/UsageChip.js';
import { PlanPanel } from '../../components/PlanPanel.js';
import { StackPanel } from '../../components/StackPanel.js';
import { FindingsPanel } from '../../components/FindingsPanel.js';
import { RecoveryPanel } from '../../components/RecoveryPanel.js';
import { WorldSummary } from '../../components/WorldSummary.js';
import { AsyncButton } from '../../components/AsyncButton.js';
import { relTime } from '../../components/util.js';
import { SettingsButton } from '../SettingsButton.js';
import { AgentCard } from './components/AgentCard.js';
import { Vitals } from './components/Vitals.js';
import { DecisionLog } from './components/DecisionLog.js';
import { UpNext } from './components/UpNext.js';
import { OverlapPanel } from './components/OverlapPanel.js';
import { ActivityFeed } from './components/ActivityFeed.js';
import { ErrorsPanel } from './components/ErrorsPanel.js';

/**
 * The cockpit as it has always looked: three columns, fleet on the left, your
 * inbox in the middle, the queue and the feeds on the right.
 *
 * Its markup is asserted byte-for-byte by `test/cockpitSkins.test.ts` against a
 * committed golden, so a change here is a deliberate one rather than a drift.
 */
export function ClassicRoot({ view, actions }: SkinProps) {
  const { state, now } = view;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="pulse-mark">♥</span> LubbDubb
          <span className="tagline">autonomous engineering cockpit</span>
          {view.demo && (
            <span className="chip warn" title="Simulated data — no server or real integrations">
              demo
            </span>
          )}
        </div>
        <div className="topbar-meta">
          {/* A countdown to a pulse that will not run is worse than no countdown:
              it reads as a healthy harness that simply never does anything. */}
          <div
            className={`heartbeat ${view.pulseHeld ? 'held' : ''}`}
            title={
              view.pulseHeld
                ? 'Held: agents from the previous run need a recovery decision'
                : `Next heartbeat in ~${view.nextPulseIn}s`
            }
          >
            <div className="heartbeat-track">
              <div className="heartbeat-fill" style={{ width: view.pulseHeld ? '100%' : `${view.pulseProgress}%` }} />
            </div>
            <span className="heartbeat-label">
              {view.pulseHeld ? 'pulse held' : `next pulse ~${view.nextPulseIn}s`}
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
          <span className={`chip ${view.connected ? 'ok' : 'bad'}`}>
            <span className={`dot ${view.connected ? 'green' : 'red'}`} /> {view.connected ? 'live' : 'offline'}
          </span>
          <UsageChip usage={state.usage} now={now} />
          {state.control.paused && <span className="chip warn">paused</span>}
          <FleetControl live={view.live.length} cap={state.control.cap} paused={state.control.paused} />
          <SettingsButton open={view.settingsOpen} onOpen={actions.openSettings} />
          <AsyncButton className="primary" onClick={() => actions.pulse()}>
            Pulse now
          </AsyncButton>
        </div>
      </header>

      {/* First thing under the topbar, above even the inject panel: while this is
          up the harness runs no cycles, so anything an operator did on the panels
          below would sit unread until these are answered. */}
      {view.crashed.length > 0 && (
        <RecoveryPanel
          crashed={view.crashed}
          now={now}
          refUrls={state.refUrls}
          onDecide={(taskId, verdict) => actions.decideRecovery(taskId, verdict)}
        />
      )}

      {view.demo && <InjectPanel onInjected={actions.refresh} world={state.world} />}
      <LaunchPanel
        jobs={state.jobs}
        attachments={state.attachments}
        attachmentUrls={state.attachmentUrls}
        onChanged={actions.refresh}
      />
      <Vitals state={state} liveAgents={view.live.length} cap={state.control.cap} />

      <main className="grid">
        <section className="col">
          <h2>
            Fleet <span className="count">{view.live.length}</span>
          </h2>
          {view.live.length === 0 && (
            <div className="empty-panel">
              <span className="empty-mark">♥</span>
              <p>
                No agents running. The harness is idle
                {view.demo ? ' — inject an event to wake it' : ' — waiting for the world to change'}.
              </p>
            </div>
          )}
          {view.live.map((a) => (
            <AgentCard
              key={a.id}
              agent={a}
              task={view.taskFor(a)}
              now={now}
              refUrls={state.refUrls}
              lastLine={view.tailByAgent.get(a.id)}
              flags={view.flagsByAgent.get(a.id)}
              artifactUrls={state.artifactUrls ?? {}}
              onOpen={() => actions.select(a.id)}
              onKill={() => actions.killAgent(a.id)}
              onComplete={() => actions.completeAgent(a.id)}
            />
          ))}

          {view.past.length > 0 && <h3 className="muted">History</h3>}
          {view.past.slice(0, 8).map((a) => (
            <AgentCard
              key={a.id}
              agent={a}
              task={view.taskFor(a)}
              now={now}
              refUrls={state.refUrls}
              flags={view.flagsByAgent.get(a.id)}
              artifactUrls={state.artifactUrls ?? {}}
              onOpen={() => actions.select(a.id)}
              past
            />
          ))}
        </section>

        <section className="col">
          <h2>
            Needs you <span className="count urgent">{view.openEscalations.length}</span>
          </h2>
          {view.openEscalations.length === 0 && (
            <div className="empty-panel calm">
              <span className="empty-mark">✓</span>
              <p>Inbox zero. Nothing needs your judgment.</p>
            </div>
          )}
          {view.openEscalations.map((e) => (
            <EscalationCard
              key={e.id}
              escalation={e}
              proposal={view.proposalFor.get(e.id)}
              resumedAt={e.agentId ? (view.agentById.get(e.agentId)?.resumedAt ?? null) : null}
              now={now}
              refUrls={state.refUrls}
              onAnswer={(text) => actions.answerEscalation(e.id, text)}
              onAnswerQuestions={(answers) => actions.answerQuestions(e.id, answers)}
              onDecide={(id, verdict, note) => actions.decideProposal(id, verdict, note)}
              onPermission={(id, allow, note) => actions.decidePermission(id, allow, note)}
              onDismiss={(id, note) => actions.dismissEscalation(id, note)}
              onOpenAgent={(id) => actions.select(id)}
              onComplete={(id) => actions.completeAgent(id)}
              onViewPlan={(id) => actions.viewPlan(id)}
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
                onReplan={(planId) => actions.replan(planId)}
                onViewPlan={(id) => actions.viewPlan(id)}
              />
            </>
          )}

          {(state.stacks?.length ?? 0) > 0 && (
            <>
              <h3 className="muted">Stacks</h3>
              <StackPanel stacks={state.stacks ?? []} prs={state.world.pullRequests} refUrls={state.refUrls} />
            </>
          )}

          {(state.findings?.length ?? 0) > 0 && (
            <>
              <h3 className="muted">
                Findings
                {view.openFindingCount > 0 && <span className="count">{view.openFindingCount}</span>}
              </h3>
              <FindingsPanel
                findings={state.findings ?? []}
                now={now}
                refUrls={state.refUrls}
                canFileTickets={state.config.canFileTickets}
                onPromote={(id) => actions.promoteFinding(id)}
                onFile={(id) => actions.fileFinding(id)}
                onDismiss={(id) => actions.dismissFinding(id)}
              />
            </>
          )}

          {(state.overlaps?.length ?? 0) > 0 && (
            <>
              <h3 className="muted">
                File overlaps
                {view.liveOverlapCount > 0 && <span className="count">{view.liveOverlapCount}</span>}
              </h3>
              <OverlapPanel overlaps={state.overlaps ?? []} now={now} refUrls={state.refUrls} />
            </>
          )}

          <h3 className="muted">World</h3>
          <WorldSummary
            state={state}
            onToggleExclude={(prNumber, excluded) => actions.setPrExcluded(prNumber, excluded)}
            onToggleIssueWatch={(issueNumber, watched) => actions.setIssueWatched(issueNumber, watched)}
            onSetConclusion={(issueNumber, verdict) => actions.setIssueConclusion(issueNumber, verdict)}
            onSetAssay={(issueNumber, verdict) => actions.setIssueAssay(issueNumber, verdict)}
            onViewPlan={(id) => actions.viewPlan(id)}
            onViewScratchpad={(issueRef) => actions.viewScratchpad(issueRef)}
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
            onReorder={(origins) => actions.reorderUpNext(origins)}
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
          <ActivityFeed events={state.worldEvents} now={now} refUrls={state.refUrls} />
          <h2 className="feed-heading">
            Errors <span className={`count${state.errors.length > 0 ? ' urgent' : ''}`}>{state.errors.length}</span>
          </h2>
          <ErrorsPanel errors={state.errors} now={now} />
        </section>
      </main>

      {view.selectedAgent && (
        <AgentDrawer
          agent={view.selectedAgent}
          task={view.taskFor(view.selectedAgent)}
          refUrls={state.refUrls}
          live={view.selectedOutput}
          flags={view.flagsByAgent.get(view.selectedAgent.id)}
          artifactUrls={state.artifactUrls ?? {}}
          files={view.filesByAgent.get(view.selectedAgent.id)}
          onClose={() => actions.select(null)}
          onRespond={(text) => actions.respondAgent(view.selectedAgent!.id, text)}
          onKill={() => actions.killAgent(view.selectedAgent!.id)}
          onComplete={() => actions.completeAgent(view.selectedAgent!.id)}
          onInterrupt={() => actions.interruptAgent(view.selectedAgent!.id)}
        />
      )}
    </div>
  );
}
