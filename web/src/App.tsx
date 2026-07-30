import { UnauthorizedError } from './api.js';
import { useCockpit } from './cockpit/useCockpit.js';
import { readStoredSkinId, resolveSkin } from './skins/registry.js';
import { PlanModal } from './components/PlanModal.js';
import { WorkTreePanel } from './components/WorkTreePanel.js';
import { PromptsPanel } from './components/PromptsPanel.js';
import { SettingsModal } from './components/SettingsModal.js';

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
 * The cockpit shell, and deliberately nothing more: acquire state, pick a skin,
 * hand the skin a finished view-model. Everything that decides what the operator
 * sees lives in `skins/`; everything that decides what is true lives in
 * `cockpit/` and `view/`.
 *
 * The two screens below stay here rather than moving into a skin because neither
 * has a view-model to draw — a skin cannot render a cockpit whose state never
 * arrived, and a locked-out cockpit must look the same however it was themed.
 *
 * The work graph hangs off the shell for the same class of reason. It is not in
 * the view-model at all — it has its own routes, fetched on open rather than on
 * every poll — so a skin drawing it would have to reach `api.js` directly, which
 * is exactly what the skin seam forbids (and `test/cockpitSkins.test.ts` asserts).
 * Below the skin, so it is the same record whichever theme is on.
 *
 * The prompt book sits beside it on the same argument, reached from the other
 * direction: it is fetched rather than polled because it is read once at boot and
 * cannot change while the harness is up, so it has its own route and no place in
 * the view-model either.
 */
export function App() {
  const status = useCockpit();

  if (status.kind === 'denied') return <LockedOut error={status.error} />;
  if (status.kind === 'loading') return <div className="loading">Connecting to the cockpit…</div>;

  const { Root } = resolveSkin(readStoredSkinId());

  // The modal hangs off the shell for the same reason `WorkTreePanel` does — it is
  // shared, and the skin seam forbids a skin reaching `api.js` to open it another way.
  const state = status.view.state;
  const viewedPlan = (state.plans ?? []).find((p) => p.id === status.view.viewingPlan) ?? null;
  const planModal = viewedPlan ? (
    <PlanModal
      key={viewedPlan.id}
      plan={viewedPlan}
      parts={(state.planParts ?? []).filter((p) => p.planId === viewedPlan.id).sort((a, b) => a.seq - b.seq)}
      upcoming={state.upcoming?.items ?? []}
      proposal={(state.proposals ?? []).find((p) => p.kind === 'plan' && p.ref === `${viewedPlan.originRef}:plan`)}
      agent={state.agents.find(
        (a) =>
          status.view.taskFor(a)?.originRef === `${viewedPlan.originRef}:plan` &&
          (a.status === 'running' || a.status === 'waiting'),
      )}
      now={status.view.now}
      refUrls={state.refUrls}
      onClose={() => status.actions.viewPlan(null)}
      onReplan={(id) => status.actions.replan(id)}
      onDiscuss={(id) => status.actions.discussPlan(id)}
      onEndDiscussion={(id) => status.actions.endPlanDiscussion(id)}
      onDecide={(id, verdict, note) => status.actions.decideProposal(id, verdict, note)}
      onOpenAgent={(id) => status.actions.select(id)}
      onRespond={(id, text) => status.actions.respondAgent(id, text)}
    />
  ) : null;

  return (
    <>
      <Root view={status.view} actions={status.actions} />
      {planModal}
      {status.view.settingsOpen && (
        <SettingsModal control={state.control} onClose={() => status.actions.openSettings(false)} />
      )}
      <section className="work-panel">
        <h2>Work</h2>
        <WorkTreePanel now={status.view.now} canFileTickets={status.view.state.config.canFileTickets} />
        <PromptsPanel />
      </section>
    </>
  );
}
