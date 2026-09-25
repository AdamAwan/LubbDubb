import { UnauthorizedError } from './api.js';
import { useCockpit } from './cockpit/useCockpit.js';
import { ConsoleRoot } from './console/ConsoleRoot.js';
import { AgentDrawer } from './components/AgentDrawer.js';
import { HatchModal } from './components/HatchModal.js';
import { RetroModal } from './components/RetroModal.js';
import { ScratchpadModal } from './components/ScratchpadModal.js';
import { PlanModal } from './components/PlanModal.js';
import { RefLinks } from './components/refs.js';
import { hasPrPage } from './view/prPage.js';
import { goalIssue, standsFor } from './view/goalRefs.js';
import type { CockpitView } from './view/viewModel.js';
import type { CockpitActions } from './cockpit/actions.js';

// → docs/spec/17-cockpit.md

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

export function App() {
  const status = useCockpit();

  if (status.kind === 'denied') return <LockedOut error={status.error} />;
  if (status.kind === 'loading') return <div className="loading">Connecting to the cockpit…</div>;

  const state = status.view.state;
  const openAgent = status.view.selectedAgent;

  return (
    <RefLinks
      refUrls={state.refUrls}
      openGoal={(ref) => status.actions.selectGoal(ref)}
      hasGoal={(ref) => goalIssue(state, ref) !== undefined}
      openPr={(prNumber) => status.actions.selectPr(prNumber)}
      hasPr={(prNumber) => hasPrPage(state, prNumber)}
    >
      <ConsoleRoot view={status.view} actions={status.actions} />
      <ViewedPlan view={status.view} actions={status.actions} />
      {openAgent && <OpenAgent agent={openAgent} view={status.view} actions={status.actions} />}
      {status.view.viewingRetro && (
        <RetroModal issueRef={status.view.viewingRetro} onClose={() => status.actions.viewRetro(null)} />
      )}
      {/* The collection goes in whole and the modal finds its own pet in it. A
          conditional here would unmount the ceremony the first time a snapshot
          arrived without that row, and a remount starts the wobble again. */}
      {status.view.hatching !== null && (
        <HatchModal
          petId={status.view.hatching}
          pets={state.pets?.pets ?? []}
          onOpen={(id) => status.actions.openPet(id)}
          onClose={() => status.actions.hatchEgg(null)}
        />
      )}
      {status.view.viewingScratchpad && (
        <ScratchpadModal issueRef={status.view.viewingScratchpad} onClose={() => status.actions.viewScratchpad(null)} />
      )}
    </RefLinks>
  );
}

function ViewedPlan({ view, actions }: { view: CockpitView; actions: CockpitActions }) {
  const state = view.state;
  const viewedPlan = (state.plans ?? []).find((p) => p.id === view.viewingPlan) ?? null;
  if (!viewedPlan) return null;
  return <PlanView plan={viewedPlan} view={view} actions={actions} />;
}

function PlanView({
  plan: viewedPlan,
  view,
  actions,
}: {
  plan: NonNullable<CockpitView['state']['plans']>[number];
  view: CockpitView;
  actions: CockpitActions;
}) {
  const state = view.state;
  return (
    <PlanModal
      key={viewedPlan.id}
      plan={viewedPlan}
      parts={(state.planParts ?? []).filter((p) => p.planId === viewedPlan.id).sort((a, b) => a.seq - b.seq)}
      atoms={(state.planAtoms ?? []).filter((a) => a.planId === viewedPlan.id)}
      checks={(state.validationChecks ?? []).filter((c) => c.originRef === viewedPlan.originRef)}
      validationPlan={(state.validationPlans ?? []).find((r) => r.originRef === viewedPlan.originRef) ?? null}
      caveatAnswers={(state.planCaveatAnswers ?? []).filter((a) => a.planId === viewedPlan.id)}
      watches={(state.goalWatches ?? []).filter((w) => w.originRef === viewedPlan.originRef)}
      queries={(state.stateQueries ?? []).filter((q) => q.originRef === viewedPlan.originRef)}
      upcoming={state.upcoming?.items ?? []}
      proposal={(state.proposals ?? []).find((p) => p.kind === 'plan' && p.ref === `${viewedPlan.originRef}:plan`)}
      spend={state.world.issues.find((i) => `issue:${i.number}` === viewedPlan.originRef)?.spend ?? null}
      planning={state.planning}
      now={view.now}
      refUrls={state.refUrls}
      onClose={() => actions.viewPlan(null)}
      onReplan={(id) => actions.replan(id)}
      onWatchProposal={(issueNumber, checkId, accept) => actions.ruleWatchProposal(issueNumber, checkId, accept)}
      onDecide={(id, verdict, note, acknowledged, answers) =>
        actions.decideProposal(id, verdict, note, acknowledged, answers)
      }
      onBackOut={(id, verdict, note) => actions.backOutProposal(id, verdict, note)}
      onOpenGoal={(ref) => actions.selectGoal(ref)}
      onPartProfile={(id, slug, profile) => actions.setPartProfile(id, slug, profile)}
      onRestartPart={(id, slug) => actions.restartPart(id, slug)}
      regrouping={view.regroupingPlan}
      onRegroupView={(on) => actions.regroupPlanView(on)}
      onRegroup={(id, groups) => actions.regroupPlan(id, groups)}
      canClosePr={state.config.canClosePr}
      profiles={state.config.profiles}
      defaultProfile={state.config.defaultProfile}
      desktopFolder={state.config.desktopFolder}
    />
  );
}

function OpenAgent({
  agent,
  view,
  actions,
}: {
  agent: NonNullable<CockpitView['selectedAgent']>;
  view: CockpitView;
  actions: CockpitActions;
}) {
  const state = view.state;
  return (
    <AgentDrawer
      agent={agent}
      task={view.taskFor(agent)}
      originStandsFor={standsFor(state, view.taskFor(agent)?.originRef ?? null)}
      refUrls={state.refUrls}
      live={view.selectedOutput}
      flags={view.flagsByAgent.get(agent.id)}
      artifactUrls={state.artifactUrls ?? {}}
      limitParked={view.limitParked.has(agent.id)}
      onClose={() => actions.select(null)}
      onRespond={(text) => actions.respondAgent(agent.id, text)}
      onKill={() => actions.killAgent(agent.id)}
      onEject={state.config.ejectionEnabled === false ? undefined : (reason) => actions.ejectAgent(agent.id, reason)}
      onComplete={() => actions.completeAgent(agent.id)}
      onInterrupt={() => actions.interruptAgent(agent.id)}
      onResume={() => actions.resumeAgent(agent.id)}
      profiles={state.config.profiles}
      onLift={(profile) => actions.liftAgentProfile(agent.id, profile)}
    />
  );
}
