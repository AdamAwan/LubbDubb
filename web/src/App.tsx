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
import { goalIssue, standsFor } from './view/goalPage.js';

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
  const viewedPlan = (state.plans ?? []).find((p) => p.id === status.view.viewingPlan) ?? null;
  const planModal = viewedPlan ? (
    <PlanModal
      key={viewedPlan.id}
      plan={viewedPlan}
      parts={(state.planParts ?? []).filter((p) => p.planId === viewedPlan.id).sort((a, b) => a.seq - b.seq)}
      atoms={(state.planAtoms ?? []).filter((a) => a.planId === viewedPlan.id)}
      checks={(state.validationChecks ?? []).filter((c) => c.originRef === viewedPlan.originRef)}
      caveatAnswers={(state.planCaveatAnswers ?? []).filter((a) => a.planId === viewedPlan.id)}
      watches={(state.goalWatches ?? []).filter((w) => w.originRef === viewedPlan.originRef)}
      upcoming={state.upcoming?.items ?? []}
      proposal={(state.proposals ?? []).find((p) => p.kind === 'plan' && p.ref === `${viewedPlan.originRef}:plan`)}
      spend={state.world.issues.find((i) => `issue:${i.number}` === viewedPlan.originRef)?.spend ?? null}
      planning={state.planning}
      now={status.view.now}
      refUrls={state.refUrls}
      onClose={() => status.actions.viewPlan(null)}
      onReplan={(id) => status.actions.replan(id)}
      onWatchProposal={(issueNumber, checkId, accept) => status.actions.ruleWatchProposal(issueNumber, checkId, accept)}
      onDecide={(id, verdict, note, acknowledged, answers) =>
        status.actions.decideProposal(id, verdict, note, acknowledged, answers)
      }
      onBackOut={(id, verdict, note) => status.actions.backOutProposal(id, verdict, note)}
      onOpenGoal={(ref) => status.actions.selectGoal(ref)}
      onPartProfile={(id, slug, profile) => status.actions.setPartProfile(id, slug, profile)}
      onRestartPart={(id, slug) => status.actions.restartPart(id, slug)}
      regrouping={status.view.regroupingPlan}
      onRegroupView={(on) => status.actions.regroupPlanView(on)}
      onRegroup={(id, groups) => status.actions.regroupPlan(id, groups)}
      canClosePr={state.config.canClosePr}
      profiles={state.config.profiles}
      defaultProfile={state.config.defaultProfile}
      desktopFolder={state.config.desktopFolder}
    />
  ) : null;

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
      {planModal}
      {openAgent && (
        <AgentDrawer
          agent={openAgent}
          task={status.view.taskFor(openAgent)}
          originStandsFor={standsFor(state, status.view.taskFor(openAgent)?.originRef ?? null)}
          refUrls={state.refUrls}
          live={status.view.selectedOutput}
          flags={status.view.flagsByAgent.get(openAgent.id)}
          artifactUrls={state.artifactUrls ?? {}}
          limitParked={status.view.limitParked.has(openAgent.id)}
          onClose={() => status.actions.select(null)}
          onRespond={(text) => status.actions.respondAgent(openAgent.id, text)}
          onKill={() => status.actions.killAgent(openAgent.id)}
          onEject={
            state.config.ejectionEnabled === false
              ? undefined
              : (reason) => status.actions.ejectAgent(openAgent.id, reason)
          }
          onComplete={() => status.actions.completeAgent(openAgent.id)}
          onInterrupt={() => status.actions.interruptAgent(openAgent.id)}
          onResume={() => status.actions.resumeAgent(openAgent.id)}
        />
      )}
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
