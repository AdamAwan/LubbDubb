import { useState } from 'react';
import type { SkinProps } from '../types.js';
import { AgentDrawer } from '../../components/AgentDrawer.js';
import { RecoveryPanel } from '../../components/RecoveryPanel.js';
import { WorldSummary } from '../../components/WorldSummary.js';
import { relTime } from '../../components/util.js';
import { SpriteSheet, Icon } from './components/Sprite.js';
import { StatusBar } from './components/StatusBar.js';
import { BlueprintDesk, FaultLog, FindingsDesk, StampDesk } from './components/Desks.js';
import { TheLine } from './components/TheLine.js';
import { BotCard } from './components/BotCard.js';
import { EventLog } from './components/EventLog.js';
import { Inspection } from './components/Inspection.js';
import { Modal, type FactoryModal } from './components/Modal.js';
import { Production } from './components/Production.js';
import { Signals } from './components/Signals.js';
import { GoalFloor } from './components/GoalFloor.js';
import { rack } from './inspection.js';
import { powerReading } from './power.js';
import { productionReading } from './production.js';

/**
 * The cockpit as a production line.
 *
 * The layout is the argument: the queue, the fleet and the cap are one picture
 * at the top rather than three panels you join by eye, because they are one
 * decision — the dispatcher's — and Classic's three columns make you rebuild it
 * every time you look. Everything else is the detail that picture cannot hold.
 *
 * The stamp desk, the fault log, the blueprint desk and the findings desk are all
 * the same shape of thing, and the first three used to be panels in a
 * permanent left-hand rail. All four are read as a *count* far more often than as
 * contents, so the count is a gauge in the status bar and the panel opens from
 * it — which is what deleted the rail, and then the last panel on the floor that
 * was read the same way. See
 * `docs/spec/2026-07-29-factory-two-rail-layout-design.md` and
 * `docs/spec/2026-07-30-factory-findings-gauge-design.md`.
 *
 * Production is the fifth and last, and the one that was not a count. It reads
 * against time rather than reporting the moment, which makes it the panel an
 * operator most clearly *consults* rather than watches — and it had already been
 * reduced to a rail panel whose entire content was a tile you clicked to open the
 * graph. So the tile is a gauge in the bar now (`ProdRead`, the spark carrying
 * the shape a count cannot) and the graph is the modal it opens: the axes, the
 * rates, the spend and the truncation caveat, at the size they were drawn for.
 *
 * Every panel is bound to a `const` below and then *placed*, so what a panel
 * contains and where it sits stop being the same edit. Placement is **one CSS
 * grid**: every panel is a direct child of `.fx-grid`, in the order it reads, and
 * an arrangement is only how many tracks there are and what each panel spans.
 * There is one DOM for every width and the breakpoints live in CSS alone —
 * matching them in React would be a second definition to keep in step, bought
 * with a resize listener.
 *
 * The two rails that used to hold these panels above 1900px are gone, and with
 * them the three scrollbars: a rail scrolling on its own means the page has no
 * single reading position, and the panel beside the one you are reading does not
 * travel with it. Document order is reading order now, so no panel carries an
 * `order` either. See `docs/spec/17-cockpit.md`.
 *
 * Where a panel carries a refusal rule or an async flow it is the *shared*
 * component, unchanged and tinted through the tokens: the escalation card,
 * findings, recovery, the drawer, the world. This skin owns what it draws and
 * decides nothing.
 */
export function FactoryRoot({ view, actions }: SkinProps) {
  const { state, now } = view;
  const [modal, setModal] = useState<FactoryModal | null>(null);
  const stopped = view.pulseHeld || state.control.paused;
  // Off the same pure `rack` the panel draws, so the header count and the group it
  // counts can never disagree.
  const yoursCount = rack(state.world.pullRequests).yours.length;
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
      onDecide={(taskId, verdict) => actions.decideRecovery(taskId, verdict)}
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

  // Bounded, and the count says by how much — the shift log's own convention. A
  // finished agent is kept in the store forever, so an unbounded list here is a
  // panel that grows without limit for a reading nobody scrolls to the end of.
  const shiftsShown = view.past.slice(0, 24);

  const bots = (
    <section className="fx-card fx-bev" data-fx="bots">
      <div className="fx-head">
        <div>
          <Icon name="bot" />
          <h2>Bots in the Field</h2>
        </div>
        {/* Ended shifts are history, and history in front of the bots that are out
            *now* is the panel reading as longer than the fleet is. So it is the
            gauge treatment the desks got, panel-local: the count stays in the head
            — a shift that ended is worth knowing about — and the cards it counts
            open in front. */}
        <div className="fx-head-act">
          <p className="fx-note">
            {Math.max(0, state.control.cap - view.live.length)} pad
            {state.control.cap - view.live.length === 1 ? '' : 's'} free
          </p>
          {view.past.length > 0 && (
            <button
              type="button"
              className="btn ghost small"
              onClick={() => setModal('shifts')}
              title="The bots whose shift has ended"
            >
              {view.past.length} shift{view.past.length === 1 ? '' : 's'} ended
            </button>
          )}
        </div>
      </div>
      <div className="fx-body">
        {view.live.length === 0 && (
          <p className="fx-empty">
            No bots out. The floor is idle
            {view.demo ? ' — inject an event to wake it.' : ' — waiting for the world to change.'}
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
      </div>
    </section>
  );

  const shifts = (
    <div className="fx-body">
      {shiftsShown.map((a) => (
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
  );

  // Beside Bots from 1500px up, half the width each: the parts on the rack and the
  // bots that will work them are one reading, and reading them as one is what the
  // rails' whose-turn split used to cost. It replaces two panels — the silo towers
  // and the Launches log — and the log's one fact with any tension left in it, the
  // merge count, rides in this header.
  const inspection = (
    <section className="fx-card fx-bev fx-insp" data-fx="inspection">
      <div className="fx-head">
        <div>
          <Icon name="pr" />
          <h2>Parts Inspection</h2>
        </div>
        <p className="fx-note">
          {yoursCount > 0 ? <b>{yoursCount} in your court</b> : 'nothing in your court'} ·{' '}
          {state.world.pullRequests.length - yoursCount} in hand
        </p>
      </div>
      <Inspection
        prs={state.world.pullRequests}
        closed={state.world.closedPullRequests ?? []}
        refUrls={state.refUrls}
      />
    </section>
  );

  // The floor takes the Research slot, and replaces what stood there. The tech
  // tree drew a plan's parts by depth and stopped at the part; the floor lays the
  // same parts out in the same dependency order and adds everything on either
  // side of them. Keeping both would have left two components deriving a part's
  // state from `PlanPart.status` independently.
  const goalFloor = (
    <section className="fx-card fx-bev" data-fx="goal-floor">
      <div className="fx-head">
        <div>
          <Icon name="patch" />
          <h2>Goal Floor</h2>
        </div>
        <p className="fx-note">one goal, patch to launch</p>
      </div>
      <GoalFloor
        issues={state.world.issues}
        plans={state.plans ?? []}
        parts={state.planParts ?? []}
        openPrs={state.world.pullRequests}
        closedPrs={state.world.closedPullRequests ?? []}
        tasks={state.tasks}
        upcoming={state.upcoming?.items ?? []}
        refUrls={state.refUrls}
        stopped={stopped}
        watchLabel={state.config.watchLabel}
        ignoreLabel={state.config.ignoreLabel}
        onViewPlan={(id) => actions.viewPlan(id)}
        onReplan={(planId) => actions.replan(planId)}
        onSetAssay={(issueNumber, verdict) => actions.setIssueAssay(issueNumber, verdict)}
        onFetchWork={(ref) => actions.fetchWorkSubtree(ref)}
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
      {/* Issues and stories only. Pull requests are drawn in full above the rails,
          and the argument is the one that dissolved the act rail into gauges: one
          subject, one place. Classic keeps its own PR list — it has no strip. */}
      <WorldSummary
        state={state}
        showPullRequests={false}
        onToggleExclude={(prNumber, excluded) => actions.setPrExcluded(prNumber, excluded)}
        onToggleIssueWatch={(issueNumber, watched) => actions.setIssueWatched(issueNumber, watched)}
        onToggleStoryWatch={(storyId, watched) => actions.setStoryWatched(storyId, watched)}
        onSetConclusion={(issueNumber, verdict) => actions.setIssueConclusion(issueNumber, verdict)}
        onSetAssay={(issueNumber, verdict) => actions.setIssueAssay(issueNumber, verdict)}
        onViewPlan={(id) => actions.viewPlan(id)}
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

  return (
    // A brownout dims the machinery and nothing else — see the CSS. Reserve
    // running low is a real reading and worth showing on the floor itself, but
    // not at the cost of the text an operator needs in order to act on it.
    <div className={`fx ${power.brownout ? 'fx-brownout' : ''}`}>
      <SpriteSheet />
      <StatusBar view={view} actions={actions} production={production} onOpen={setModal} />

      {/* The socket is how this page learns anything changed. Without it every
          panel below is a photograph of the moment the link dropped, drawn in
          the same chrome as a live one — and the numbers that matter here (bots
          out, alerts pending, what is on the belt) are the ones that go wrong
          quietly. A "live/offline" chip in the corner asked the operator to
          remember to check it, so the floor states it instead: nothing is shown
          except the fact that nothing is known. The poll keeps running
          underneath, so the floor returns by itself. */}
      {!view.connected && (
        <section className="fx-card fx-bev fx-offline">
          <Icon name="alert" className="lg" />
          <h2>Off the air</h2>
          <p>
            The cockpit has lost its link to the harness. Everything this floor draws is a reading the harness confirms,
            so while the link is down there is nothing here worth showing.
          </p>
          <p className="fx-empty">The harness itself is unaffected — bots keep working. Reconnecting…</p>
        </section>
      )}

      {/* Above the rails and outside the grid, because while it is up *no pulse
          runs*: every other surface on this page is stale for the same reason, so
          a card among the rails would leave an operator hunting for why their
          fleet is frozen. */}
      {view.connected && (
        <>
          {recovery}

          {/* One grid, in reading order: the line, then the two halves of the
          moment (the parts on the rack, the bots out working them), then the
          detail the line cannot hold, then the readings you consult rather than
          watch. What *you* are the blocker for is no longer a column here — it is
          a count in the status bar, because that is how it is read; Production
          left the same way and its graph opens from its gauge. */}
          <div className="fx-grid">
            {line}
            {inspection}
            {bots}
            {goalFloor}
            {yard}
            {shiftLog}
            {signals}
          </div>

          {modal === 'production' && (
            <Modal
              title="Production"
              icon="lamp"
              note="dispatches are effort · merges are output"
              onClose={() => setModal(null)}
            >
              <Production reading={production} />
            </Modal>
          )}

          {modal === 'shifts' && (
            <Modal
              title="Shifts Ended"
              icon="bot"
              note={
                view.past.length > shiftsShown.length
                  ? `last ${shiftsShown.length} of ${view.past.length}`
                  : `${view.past.length} bot${view.past.length === 1 ? '' : 's'} in`
              }
              onClose={() => setModal(null)}
            >
              {shifts}
            </Modal>
          )}

          {modal === 'alerts' && (
            <Modal
              title="Awaiting Your Stamp"
              icon="alert"
              note={`${view.openEscalations.length} pending`}
              onClose={() => setModal(null)}
            >
              <StampDesk view={view} actions={actions} />
            </Modal>
          )}

          {modal === 'faults' && (
            <Modal
              title="Faults"
              icon="gear"
              note={`${state.errors.length} recorded · nothing in the harness reads these back`}
              onClose={() => setModal(null)}
            >
              <FaultLog view={view} actions={actions} />
            </Modal>
          )}

          {modal === 'findings' && (
            <Modal title="Findings" icon="chest" note="nothing schedules these" onClose={() => setModal(null)}>
              <FindingsDesk view={view} actions={actions} />
            </Modal>
          )}

          {modal === 'blueprints' && (
            <Modal title="Blueprints" icon="blueprint" note="queued ahead of every rule" onClose={() => setModal(null)}>
              <BlueprintDesk view={view} actions={actions} />
            </Modal>
          )}

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
        </>
      )}
    </div>
  );
}
