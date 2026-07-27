import type { SkinProps } from '../types.js';
import { AgentDrawer } from '../../components/AgentDrawer.js';
import { EscalationCard } from '../../components/EscalationCard.js';
import { FindingsPanel } from '../../components/FindingsPanel.js';
import { InjectPanel } from '../../components/InjectPanel.js';
import { LaunchPanel } from '../../components/LaunchPanel.js';
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
import { Production } from './components/Production.js';
import { Signals } from './components/Signals.js';
import { Silos } from './components/Silos.js';
import { TechTree } from './components/TechTree.js';
import { powerReading } from './power.js';
import { productionReading } from './production.js';
import { clip } from './vocabulary.js';

/**
 * The cockpit as a production line.
 *
 * The layout is the argument: the queue, the fleet and the cap are one picture
 * at the top rather than three panels you join by eye, because they are one
 * decision — the dispatcher's — and Classic's three columns make you rebuild it
 * every time you look. Production sits directly under it because the floor plan
 * answers *what is happening* and only a rate answers *whether it is working*.
 * Everything below the two is the detail neither picture can hold.
 *
 * Every panel is bound to a `const` below and then *placed*, so what a panel
 * contains and where it sits stop being the same edit. There is one DOM for
 * every width: the three rails are always here, and below 1900px `.fx-rail`
 * goes `display: contents` so its panels fall through into the page grid. The
 * breakpoint is therefore stated once, in CSS — matching it in React as well
 * would be a second definition to keep in step, bought with a resize listener.
 * See `docs/spec/17-cockpit.md`.
 *
 * Where a panel carries a refusal rule or an async flow it is the *shared*
 * component, unchanged and tinted through the tokens: the escalation card,
 * findings, recovery, the drawer, the world. This skin owns what it draws and
 * decides nothing.
 */
export function FactoryRoot({ view, actions }: SkinProps) {
  const { state, now } = view;
  const stopped = view.pulseHeld || state.control.paused;
  const overlaps = state.overlaps ?? [];
  const power = powerReading(state.usage);
  const production = productionReading({
    decisions: state.decisions,
    worldEvents: state.worldEvents,
    fiveHourCostUsd: state.usage.windows.fiveHourCostUsd,
    now,
  });

  // Every panel is named once here so an arrangement below is only a question of
  // where it goes, never of what it contains.
  const recovery = view.crashed.length > 0 && (
    <RecoveryPanel
      crashed={view.crashed}
      now={now}
      refUrls={state.refUrls}
      onDecide={(agentId, verdict) => actions.decideRecovery(agentId, verdict)}
    />
  );

  const alerts = (
    <AlertBay
      escalations={view.openEscalations}
      proposalFor={view.proposalFor}
      errorCount={state.errors.length}
      now={now}
      onOpenAgent={(id) => actions.select(id)}
    />
  );

  const line = (
    <TheLine
      live={view.live}
      taskFor={view.taskFor}
      cap={state.control.cap}
      items={state.upcoming?.items ?? []}
      now={now}
      intervalMs={state.config.heartbeatIntervalMs}
      stopped={stopped}
      onOpen={(id) => actions.select(id)}
    />
  );

  const productionPanel = (
    <section className="fx-card fx-bev" data-fx="production">
      <div className="fx-head">
        <div>
          <Icon name="lamp" />
          <h2>Production</h2>
        </div>
        <p className="fx-note">dispatches are effort · merges are output</p>
      </div>
      <Production reading={production} />
    </section>
  );

  const bots = (
    <section className="fx-card fx-bev" data-fx="bots">
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
  );

  const offBlueprint =
    (state.findings?.length ?? 0) > 0 || overlaps.length > 0 ? (
      <section className="fx-card fx-bev" data-fx="off-blueprint">
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
    ) : null;

  const stamp = (
    <section className="fx-card fx-bev" data-fx="stamp">
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
    </section>
  );

  const launches = (
    <section className="fx-card fx-bev" data-fx="launches">
      <div className="fx-head">
        <div>
          <Icon name="rocket" />
          <h2>Launches</h2>
        </div>
        <p className="fx-note">a launch is a merge</p>
      </div>
      <p className="fx-sub">On the pad</p>
      <Silos prs={state.world.pullRequests} refUrls={state.refUrls} />
      <p className="fx-sub">Left the pad</p>
      <Launches closed={state.world.closedPullRequests ?? []} now={now} refUrls={state.refUrls} />
    </section>
  );

  const workOrders = (
    <section className="fx-card fx-bev" data-fx="work-orders">
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
  );

  const research = (
    <section className="fx-card fx-bev" data-fx="research">
      <div className="fx-head">
        <div>
          <Icon name="blueprint" />
          <h2>Research</h2>
        </div>
        <p className="fx-note">depth is how many merges must land first</p>
      </div>
      <TechTree
        plans={state.plans ?? []}
        parts={state.planParts ?? []}
        upcoming={state.upcoming?.items ?? []}
        now={now}
        refUrls={state.refUrls}
        paused={stopped}
        onReplan={(planId) => actions.replan(planId)}
      />
    </section>
  );

  const yard = (
    <section className="fx-card fx-bev" data-fx="yard">
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
  );

  const shiftLog = (
    <section className="fx-card fx-bev" data-fx="shift-log">
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
  );

  const signals = (
    <section className="fx-card fx-bev" data-fx="signals">
      <div className="fx-head">
        <div>
          <Icon name="belt" />
          <h2>Signals</h2>
        </div>
        <p className="fx-note">what changed out there</p>
      </div>
      <Signals events={state.worldEvents} now={now} />
    </section>
  );

  const faults = (
    <section className="fx-card fx-bev" data-fx="faults">
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
  );

  return (
    // A brownout dims the machinery and nothing else — see the CSS. Reserve
    // running low is a real reading and worth showing on the floor itself, but
    // not at the cost of the text an operator needs in order to act on it.
    <div className={`fx ${power.brownout ? 'fx-brownout' : ''}`}>
      <SpriteSheet />
      <StatusBar view={view} actions={actions} />

      {/* Three rails split on *whose turn it is*: what you are the blocker for,
          what the harness is doing, what the world is doing back. Below 1900px
          they dissolve and `order` restores the reading order. Recovery leads
          the act rail because nothing below it runs while it is up: an
          outstanding recovery decision holds every pulse. */}
      <div className="fx-rails">
        <div className="fx-rail fx-rail-act">
          {recovery}
          {alerts}
          {stamp}
          {workOrders}
          {faults}
        </div>
        <div className="fx-rail fx-rail-floor">
          {line}
          {productionPanel}
          {bots}
          {research}
          {yard}
          {offBlueprint}
        </div>
        <div className="fx-rail fx-rail-world">
          {launches}
          {signals}
          {shiftLog}
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
