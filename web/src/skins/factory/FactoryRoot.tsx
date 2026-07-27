import type { SkinProps } from '../types.js';
import { AgentDrawer } from '../../components/AgentDrawer.js';
import { EscalationCard } from '../../components/EscalationCard.js';
import { FindingsPanel } from '../../components/FindingsPanel.js';
import { InjectPanel } from '../../components/InjectPanel.js';
import { LaunchPanel } from '../../components/LaunchPanel.js';
import { PlanPanel } from '../../components/PlanPanel.js';
import { RecoveryPanel } from '../../components/RecoveryPanel.js';
import { WorldSummary } from '../../components/WorldSummary.js';
import { relTime } from '../../components/util.js';
import { SpriteSheet, Icon } from './components/Sprite.js';
import { StatusBar } from './components/StatusBar.js';
import { AlertBay } from './components/AlertBay.js';
import { TheLine } from './components/TheLine.js';
import { BotCard } from './components/BotCard.js';
import { EventLog } from './components/EventLog.js';
import { Launches } from './components/Launches.js';
import { clip } from './vocabulary.js';

/**
 * The cockpit as a production line.
 *
 * The layout is the argument: the queue, the fleet and the cap are one picture
 * at the top rather than three panels you join by eye, because they are one
 * decision — the dispatcher's — and Classic's three columns make you rebuild it
 * every time you look. Everything below the line is the detail that picture
 * cannot hold.
 *
 * Where a panel carries a refusal rule or an async flow it is the *shared*
 * component, unchanged and tinted through the tokens: the escalation card, the
 * plan panel, findings, recovery, the drawer, the world. This skin owns what it
 * draws and decides nothing.
 */
export function FactoryRoot({ view, actions }: SkinProps) {
  const { state, now } = view;
  const stopped = view.pulseHeld || state.control.paused;
  const overlaps = state.overlaps ?? [];

  return (
    <div className="fx">
      <SpriteSheet />
      <StatusBar view={view} actions={actions} />

      {/* Nothing below this runs while it is up: an outstanding recovery decision
          holds every pulse, so it goes above the floor, not on it. */}
      {view.crashed.length > 0 && (
        <RecoveryPanel
          crashed={view.crashed}
          now={now}
          refUrls={state.refUrls}
          onDecide={(agentId, verdict) => actions.decideRecovery(agentId, verdict)}
        />
      )}

      <AlertBay
        escalations={view.openEscalations}
        proposalFor={view.proposalFor}
        errorCount={state.errors.length}
        now={now}
        onOpenAgent={(id) => actions.select(id)}
      />

      <TheLine
        live={view.live}
        taskFor={view.taskFor}
        cap={state.control.cap}
        items={state.upcoming?.items ?? []}
        now={now}
        stopped={stopped}
        onOpen={(id) => actions.select(id)}
      />

      <div className="fx-cols">
        <div className="fx-stack">
          <section className="fx-card fx-bev">
            <div className="fx-head">
              <div>
                <Icon name="bot" />
                <h2>Bots in the Field</h2>
              </div>
              <p className="fx-note">
                {Math.max(0, state.control.cap - view.live.length)} pad
                {state.control.cap - view.live.length === 1 ? '' : 's'} free
              </p>
            </div>
            <div className="fx-body">
              {view.live.length === 0 && (
                <p className="fx-empty">
                  No bots out. The floor is idle
                  {state.config.injectable ? ' — inject an event to wake it.' : ' — waiting for the world to change.'}
                </p>
              )}
              {view.live.map((a) => (
                <BotCard
                  key={a.id}
                  agent={a}
                  task={view.taskFor(a)}
                  now={now}
                  lastLine={view.tailByAgent.get(a.id)}
                  flags={view.flagsByAgent.get(a.id)}
                  artifactUrls={state.artifactUrls ?? {}}
                  onOpen={() => actions.select(a.id)}
                  onKill={() => actions.killAgent(a.id)}
                  onComplete={() => actions.completeAgent(a.id)}
                />
              ))}

              {view.past.length > 0 && <p className="fx-sub">Shifts ended</p>}
              {view.past.slice(0, 6).map((a) => (
                <BotCard
                  key={a.id}
                  agent={a}
                  task={view.taskFor(a)}
                  now={now}
                  flags={view.flagsByAgent.get(a.id)}
                  artifactUrls={state.artifactUrls ?? {}}
                  onOpen={() => actions.select(a.id)}
                  past
                />
              ))}
            </div>
          </section>

          {(state.findings?.length ?? 0) > 0 || overlaps.length > 0 ? (
            <section className="fx-card fx-bev">
              <div className="fx-head">
                <div>
                  <Icon name="chest" />
                  <h2>Off-Blueprint</h2>
                </div>
                <p className="fx-note">nothing schedules these</p>
              </div>
              {(state.findings?.length ?? 0) > 0 && (
                <FindingsPanel
                  findings={state.findings ?? []}
                  now={now}
                  refUrls={state.refUrls}
                  canFileTickets={state.config.canFileTickets}
                  onPromote={(id) => actions.promoteFinding(id)}
                  onFile={(id) => actions.fileFinding(id)}
                  onDismiss={(id) => actions.dismissFinding(id)}
                />
              )}
              {overlaps.length > 0 && (
                <>
                  <p className="fx-sub">
                    Two bots, one part {view.liveOverlapCount > 0 && `· ${view.liveOverlapCount} live`}
                  </p>
                  <div className="fx-body">
                    {overlaps.map((o) => (
                      <article key={o.path} className={`fx-bot fx-sunk ${o.live ? 'idle' : 'spent'}`}>
                        <div className="fx-bot-top">
                          <Icon name="alert" />
                          <span className="fx-job" title={o.path}>
                            {clip(o.path.split(/[\\/]/).pop() ?? o.path, 28)}
                          </span>
                          <span className="fx-ref">{o.sameWorktree ? 'same worktree' : 'two branches'}</span>
                        </div>
                        <p>{o.path}</p>
                        <p className="fx-empty">{o.writers.map((w) => w.branch ?? w.agentId).join(' · ')}</p>
                      </article>
                    ))}
                  </div>
                </>
              )}
            </section>
          ) : null}
        </div>

        <div className="fx-stack">
          <section className="fx-card fx-bev">
            <div className="fx-head">
              <div>
                <Icon name="blueprint" />
                <h2>Awaiting Your Stamp</h2>
              </div>
              <p className="fx-note">{view.openEscalations.length} pending</p>
            </div>
            <div className="fx-body">
              {view.openEscalations.length === 0 && (
                <p className="fx-empty">Nothing needs your judgment. The line runs itself.</p>
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
                  onDecide={(id, verdict, note) => actions.decideProposal(id, verdict, note)}
                  onPermission={(id, allow, note) => actions.decidePermission(id, allow, note)}
                  onDismiss={(id, note) => actions.dismissEscalation(id, note)}
                  onOpenAgent={(id) => actions.select(id)}
                  onComplete={(id) => actions.completeAgent(id)}
                />
              ))}
            </div>

            {(state.plans?.length ?? 0) > 0 && (
              <>
                <p className="fx-sub">Blueprints</p>
                <PlanPanel
                  plans={state.plans ?? []}
                  parts={state.planParts ?? []}
                  upcoming={state.upcoming?.items ?? []}
                  now={now}
                  refUrls={state.refUrls}
                  onReplan={(planId) => actions.replan(planId)}
                />
              </>
            )}
          </section>

          <section className="fx-card fx-bev">
            <div className="fx-head">
              <div>
                <Icon name="rocket" />
                <h2>Launches</h2>
              </div>
              <p className="fx-note">a launch is a merge</p>
            </div>
            <Launches closed={state.world.closedPullRequests ?? []} now={now} refUrls={state.refUrls} />
          </section>

          <section className="fx-card fx-bev">
            <div className="fx-head">
              <div>
                <Icon name="inserter" />
                <h2>Work Orders</h2>
              </div>
              <p className="fx-note">queued ahead of every rule</p>
            </div>
            <LaunchPanel jobs={state.jobs} onChanged={actions.refresh} />
            {state.config.injectable && <InjectPanel onInjected={actions.refresh} world={state.world} />}
          </section>
        </div>
      </div>

      <section className="fx-card fx-bev" style={{ marginBottom: 12 }}>
        <div className="fx-head">
          <div>
            <Icon name="flask" />
            <h2>The Yard</h2>
          </div>
          <p className="fx-note">
            {state.worldObservedAt ? `observed ${relTime(state.worldObservedAt, now)}` : 'not yet observed'}
          </p>
        </div>
        <WorldSummary
          state={state}
          onToggleExclude={(prNumber, excluded) => actions.setPrExcluded(prNumber, excluded)}
          onToggleIssueWatch={(issueNumber, watched) => actions.setIssueWatched(issueNumber, watched)}
          onToggleStoryWatch={(storyId, watched) => actions.setStoryWatched(storyId, watched)}
          onSetConclusion={(issueNumber, verdict) => actions.setIssueConclusion(issueNumber, verdict)}
        />
      </section>

      <div className="fx-cols">
        <section className="fx-card fx-bev">
          <div className="fx-head">
            <div>
              <Icon name="lamp" />
              <h2>Shift Log</h2>
            </div>
            <p className="fx-note">
              last {Math.min(14, state.decisions.length)} of {state.decisions.length}
            </p>
          </div>
          <EventLog decisions={state.decisions} rules={state.dispatchRules} refUrls={state.refUrls} />
        </section>

        <div className="fx-stack">
          <section className="fx-card fx-bev">
            <div className="fx-head">
              <div>
                <Icon name="belt" />
                <h2>Signals</h2>
              </div>
              <p className="fx-note">what changed out there</p>
            </div>
            <div className="fx-body">
              {state.worldEvents.length === 0 && <p className="fx-empty">The world has not moved.</p>}
              {state.worldEvents.slice(0, 10).map((e) => (
                <div key={e.id} className="fx-launch">
                  <Icon name="lamp" className="sm" />
                  <span className="fx-ref">{e.ref ?? e.kind}</span>
                  <span className="t" title={e.summary}>
                    {e.summary}
                  </span>
                  <span className="fx-ref">{relTime(e.createdAt, now)}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="fx-card fx-bev">
            <div className="fx-head">
              <div>
                <Icon name="alert" />
                <h2>Faults</h2>
              </div>
              <p className="fx-note">{state.errors.length} recorded</p>
            </div>
            <div className="fx-body">
              {state.errors.length === 0 && <p className="fx-empty">No faults recorded.</p>}
              {state.errors.slice(0, 8).map((err) => (
                <article key={err.id} className="fx-bot fx-sunk idle">
                  <div className="fx-bot-top">
                    <Icon name="alert" />
                    <span className="fx-job">{err.source}</span>
                    <span className="fx-ref">{relTime(err.createdAt, now)}</span>
                  </div>
                  <p>{err.message}</p>
                  {err.detail && <p className="fx-empty">{err.detail}</p>}
                </article>
              ))}
            </div>
          </section>
        </div>
      </div>

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
