import { UnauthorizedError } from './api.js';
import { useCockpit } from './cockpit/useCockpit.js';
import { ConsoleRoot } from './console/ConsoleRoot.js';
import { AgentDrawer } from './components/AgentDrawer.js';
import { RetroModal } from './components/RetroModal.js';
import { ScratchpadModal } from './components/ScratchpadModal.js';
import { PlanModal } from './components/PlanModal.js';
import { SettingsModal } from './components/SettingsModal.js';
import { ReliabilityModal } from './components/ReliabilityModal.js';
import { SpendModal } from './components/SpendModal.js';

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
 * The cockpit shell, and deliberately nothing more: acquire state, hand the
 * console a finished view-model. Everything that decides what the operator sees
 * lives in `console/`; everything that decides what is true lives in `cockpit/`
 * and `view/`.
 *
 * The two screens below stay here rather than moving into the console because
 * neither has a view-model to draw — the console cannot render a cockpit whose
 * state never arrived.
 *
 * The work graph is **not** here: it is a destination in the console's nav, drawn
 * by `ConsoleRoot` the way the launch desk is. It still rides its own routes
 * rather than the view-model — fetched on open rather than on every poll — but
 * that never made it the shell's, since embedding a component that reaches
 * `api.js` is not `console/` importing it, and the import ban is the whole rule.
 *
 * The prompt book is fetched rather than polled for the same reason the graph is:
 * it is read once at boot and cannot change while the harness is up, so it has
 * its own route and no place in the view-model. It rides in the settings modal,
 * which *is* the shell's, for the reason below.
 *
 * `AgentDrawer` and the modals are here because each is *overlaid* rather than
 * placed: which one is open is cockpit state — the drawer's subscription is tied
 * to it — and every surface that opens one is somewhere else on the page. The
 * console asks the way it asks for a plan (`actions.select(id)`, a flag on the
 * seam) and the shell answers.
 */
export function App() {
  const status = useCockpit();

  if (status.kind === 'denied') return <LockedOut error={status.error} />;
  if (status.kind === 'loading') return <div className="loading">Connecting to the cockpit…</div>;

  // The modal hangs off the shell for the same reason the drawer does — it is
  // shared, and the seam forbids the presentation layer reaching `api.js` to open
  // it another way.
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
      onAbandon={(id) => status.actions.abandonPlan(id)}
      onDiscuss={(id) => status.actions.discussPlan(id)}
      onEndDiscussion={(id) => status.actions.endPlanDiscussion(id)}
      onDecide={(id, verdict, note) => status.actions.decideProposal(id, verdict, note)}
      onOpenAgent={(id) => status.actions.select(id)}
      onRespond={(id, text) => status.actions.respondAgent(id, text)}
    />
  ) : null;

  const openAgent = status.view.selectedAgent;

  return (
    <>
      <ConsoleRoot view={status.view} actions={status.actions} />
      {planModal}
      {openAgent && (
        <AgentDrawer
          agent={openAgent}
          task={status.view.taskFor(openAgent)}
          refUrls={state.refUrls}
          live={status.view.selectedOutput}
          flags={status.view.flagsByAgent.get(openAgent.id)}
          artifactUrls={state.artifactUrls ?? {}}
          files={status.view.filesByAgent.get(openAgent.id)}
          onClose={() => status.actions.select(null)}
          onRespond={(text) => status.actions.respondAgent(openAgent.id, text)}
          onKill={() => status.actions.killAgent(openAgent.id)}
          onComplete={() => status.actions.completeAgent(openAgent.id)}
          onInterrupt={() => status.actions.interruptAgent(openAgent.id)}
        />
      )}
      {status.view.viewingRetro && (
        <RetroModal issueRef={status.view.viewingRetro} onClose={() => status.actions.viewRetro(null)} />
      )}
      {status.view.viewingScratchpad && (
        <ScratchpadModal issueRef={status.view.viewingScratchpad} onClose={() => status.actions.viewScratchpad(null)} />
      )}
      {status.view.settingsOpen && (
        <SettingsModal control={state.control} onClose={() => status.actions.openSettings(false)} />
      )}
      {status.view.spendOpen && <SpendModal onClose={() => status.actions.openSpend(false)} />}
      {status.view.reliabilityOpen && <ReliabilityModal onClose={() => status.actions.openReliability(false)} />}
    </>
  );
}
