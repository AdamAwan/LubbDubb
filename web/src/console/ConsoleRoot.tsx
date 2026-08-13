import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import { TopBar } from './TopBar.js';
import { QueueRail } from './QueueRail.js';
import { GoalPage } from './GoalPage.js';
import { Overview } from './Overview.js';
import { RecoveryPanel } from '../components/RecoveryPanel.js';

/**
 * The console's placement, and deliberately nothing else: what a panel contains
 * and where it sits are separate edits, so every one below is bound to a const
 * and then placed.
 *
 * A dropped socket empties the whole surface. Every reading here is one the
 * harness confirms, and a stale one is drawn in exactly the chrome of a live
 * one — so rather than ask an operator to remember to check a chip, nothing is
 * drawn at all.
 */
export function ConsoleRoot({ view, actions }: { view: CockpitView; actions: CockpitActions }) {
  if (!view.connected) {
    return (
      <div className="cn">
        <TopBar view={view} actions={actions} />
        <div className="cn-offline">
          <h1>Off the air</h1>
          <p>
            The link to the harness dropped. The harness is unaffected; the console returns by itself when it
            reconnects.
          </p>
        </div>
      </div>
    );
  }

  // Outside and above `.cn-body`, not inside it: while a crashed run stands, the
  // heartbeat is held and every goal the rail or situation area would draw is
  // stale for the same reason — this banner is the one thing still true.
  const recovery =
    view.crashed.length > 0 ? (
      <div className="cn-recovery">
        <RecoveryPanel
          crashed={view.crashed}
          now={view.now}
          refUrls={view.state.refUrls}
          onDecide={(id, verdict) => actions.decideRecovery(id, verdict)}
        />
      </div>
    ) : null;

  return (
    <div className="cn">
      <TopBar view={view} actions={actions} />
      {recovery}
      <div className="cn-body">
        {/* The situation area has exactly two occupants today: a goal's page, or
            the overview when none is selected. The backlog joins this choice in
            Task 8 — until it does, `backlogOpen` is not consulted here, because a
            surface drawn blank while a flag is set is worse than one not yet
            reachable. */}
        <aside className="cn-rail">
          <QueueRail view={view} actions={actions} />
        </aside>
        <main className="cn-sit">
          {view.goalPage !== null ? (
            <GoalPage page={view.goalPage} view={view} actions={actions} />
          ) : (
            <Overview view={view} actions={actions} />
          )}
        </main>
      </div>
    </div>
  );
}
