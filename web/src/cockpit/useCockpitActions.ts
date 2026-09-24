import { useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import type { AppliedFix } from '../view/needsYou.js';
import { goalMove, homeTab, POOL_VIEWS } from './place.js';
import { logUsage } from './usage.js';
import type { CockpitActions } from './actions.js';
import type { useNavigation } from './useNavigation.js';
import { PREDICTION_PANE } from '../view/goalPage.js';

// → docs/spec/17-cockpit.md#the-address-bar

type Go = ReturnType<typeof useNavigation>['go'];
type Refresh = (sections: null) => Promise<void>;
type Then = <T>(p: Promise<T>) => Promise<void>;
type Undoable = Map<string, { set?: Record<string, unknown>; clear?: string[] }>;

export function useCockpitActions(refresh: Refresh, go: Go): { actions: CockpitActions; appliedFixes: AppliedFix[] } {
  const [appliedFixes, setAppliedFixes] = useState<AppliedFix[]>([]);
  const undoable = useRef<Undoable>(new Map());
  const actions = useMemo<CockpitActions>(() => {
    const then: Then = (p) => p.then(() => refresh(null));
    return {
      ...agentActions(then, refresh, go),
      ...decisionActions(then),
      ...workActions(then, refresh),
      ...placeActions(go),
      ...machineActions(then),
      ...recordActions(then, refresh),
      ...configFixActions(undoable.current, setAppliedFixes),
      fetchWorkSubtree: (ref) => api.getWorkSubtree(ref),
    };
  }, [refresh, go]);
  return { actions, appliedFixes };
}

function agentActions(then: Then, refresh: Refresh, go: Go) {
  return {
    refresh: () => refresh(null),
    pulse: () => then(api.pulse()),
    clearErrors: () => then(api.clearErrors()),
    select: (agentId) => go({ agent: agentId }),

    killAgent: (id) => then(api.killAgent(id)),
    completeAgent: (id) => then(api.completeAgent(id)),
    interruptAgent: (id) => api.interruptAgent(id).then(() => undefined),
    liftAgentProfile: (id, profile) => then(api.liftAgentProfile(id, profile)),
    respondAgent: (id, text) => api.respondAgent(id, text).then(() => undefined),
    resumeAgent: (id) => then(api.resumeAgent(id)),
    ejectAgent: (id, reason) => then(api.ejectAgent(id, reason)),
    settleEjection: (id, outcome, note) => then(api.settleEjection(id, outcome, note)),
    extendStall: (id) => then(api.extendStall(id)),
  } satisfies Partial<CockpitActions>;
}

function decisionActions(then: Then) {
  return {
    answerEscalation: (id, text) => then(api.answerEscalation(id, text)),
    answerQuestions: (id, answers) => then(api.answerQuestions(id, answers)),
    dismissEscalation: (id, note) => then(api.dismissEscalation(id, note)),
    decideProposal: (id, verdict, note, acknowledged, answers, declined) =>
      then(
        verdict === 'accept'
          ? api.acceptProposal(id, note, acknowledged, answers, declined)
          : api.rejectProposal(id, note),
      ),
    backOutProposal: (id, verdict, note) => then(api.backOutProposal(id, verdict, note)),
    overruleShortfall: (issueNumber, proposalId, text) =>
      then(api.overruleShortfall(issueNumber, text).then(() => api.rejectProposal(proposalId, text))),
    releaseEnvironmentGate: (issueNumber, released, note) =>
      then(api.releaseEnvironmentGate(issueNumber, released, note)),
    decidePermission: (id, allow, note) => then(api.decidePermission(id, allow, note)),
    decideRecovery: (taskId, verdict) => then(api.decideRecovery(taskId, verdict)),
  } satisfies Partial<CockpitActions>;
}

function workActions(then: Then, refresh: Refresh) {
  return {
    replan: (planId) => then(api.replan(planId)),
    ruleWatchProposal: (issueNumber, checkId, accept) => then(api.ruleWatchProposal(issueNumber, checkId, accept)),
    saveWatchCheck: async (issueNumber, check) => {
      const { dryRun } = await api.saveWatchCheck(issueNumber, check);
      await refresh(null);
      return dryRun;
    },
    deleteWatchCheck: (issueNumber, checkId) => then(api.deleteWatchCheck(issueNumber, checkId)),
    extendWatch: (issueNumber, environment) => then(api.extendWatch(issueNumber, environment)),
    setValidation: (issueNumber, checkId, act) => then(api.setValidation(issueNumber, checkId, act)),
    muteObstacle: (id, muted) => then(api.muteObstacle(id, muted)),
    decideObstacleTicket: (id, approved) => then(api.decideObstacleTicket(id, approved)),
    ownObstacle: (id, ownerRef) => then(api.ownObstacle(id, ownerRef)),
    retireObstacle: (id) => then(api.retireObstacle(id)),
    writeDownObstacle: (id) => then(api.writeDownObstacle(id)),
    reopenThread: (prNumber, threadId, reopened) => then(api.reopenPrThread(prNumber, threadId, reopened)),
    ruleRemoteQuery: (issueNumber, environment, rowId, accept) =>
      then(api.ruleRemoteQuery(issueNumber, environment, rowId, accept)),
    selectRemoteRow: (issueNumber, environment, rowId, selected) =>
      then(api.selectRemoteRow(issueNumber, environment, rowId, selected)),
    pressRemoteSheet: (issueNumber, environment) => then(api.pressRemoteSheet(issueNumber, environment)),
    cancelRemoteRun: (issueNumber, environment) => then(api.cancelRemoteRun(issueNumber, environment)),
    reseedRemoteTenant: (issueNumber, environment) => then(api.reseedRemoteTenant(issueNumber, environment)),
    reorderUpNext: (origins) => then(api.reorderUpNext(origins)),
    setUpNextProfile: (origin, profile) => then(api.setUpNextProfile(origin, profile)),
  } satisfies Partial<CockpitActions>;
}

function placeActions(go: Go) {
  return {
    viewPlan: (planId) => go({ plan: planId, planRegroup: false }),
    regroupPlanView: (on) => go({ planRegroup: on }),
    viewRetro: (issueRef) => go({ retro: issueRef }),
    hatchEgg: (id) => go({ hatch: id }),
    viewScratchpad: (issueRef) => go({ scratchpad: issueRef }),
    setObstacleQuery: (next) => go(next),
    openConfig: (where) => go({ tab: 'config', goal: null, ...where }),
    openInsights: (where) =>
      go((current) => {
        const next = { tab: 'insights' as const, goal: null, ...where };
        /* A tab only a fleet holds about itself cannot survive a move to the
           pool, so the scope move carries the reading back to Economics rather
           than drawing a refusal where a tab used to be. */
        const view = next.insightsView ?? current.insightsView;
        const scope = next.insightsScope ?? current.insightsScope;
        return scope === 'pool' && !POOL_VIEWS.includes(view) ? { ...next, insightsView: 'economics' } : next;
      }),
    selectGoal: (ref) => go((current) => goalMove(current, ref)),
    openGoalPrediction: (ref) => go((current) => ({ ...goalMove(current, ref), goalTab: PREDICTION_PANE })),
    openGoalPane: (ref, pane) => go((current) => ({ ...goalMove(current, ref), goalTab: pane })),
    selectPr: (prNumber) =>
      go((current) => (prNumber === null ? { pr: null } : { pr: prNumber, tab: homeTab(current.tab) })),
    openPanel: (panel) => go({ panel }),
    openTab: (next) => go(next === 'features' ? { tab: next, featureCard: null } : { tab: next }),
    setTicketQuery: (next) => {
      logUsage('ticket.filter');
      go(next);
    },
    setFeatureQuery: (next) => {
      logUsage('feature.filter');
      go(next);
    },
    showBlendedPets: (petsBlended) => go({ petsBlended }),
    setOverviewShape: (overview) => go({ overview }),
    setFeatureMode: (featureMode) => go({ featureMode }),
    collapseFeature: (issueNumber, collapsed) =>
      go((current) => ({
        collapsed: collapsed ? [...current.collapsed, issueNumber] : current.collapsed.filter((n) => n !== issueNumber),
      })),
    openGoalSection: (section, open) =>
      go((current) => ({
        goalOpen: open
          ? [...current.goalOpen.filter((name) => name !== section), section].sort((a, b) => a.localeCompare(b))
          : current.goalOpen.filter((name) => name !== section),
        goalShut: open
          ? current.goalShut.filter((name) => name !== section)
          : [...current.goalShut.filter((name) => name !== section), section].sort((a, b) => a.localeCompare(b)),
      })),
    openGoalTab: (tab) => go({ goalTab: tab }),
    openRemoteSheet: (environment) => go({ sheetEnvironment: environment }),
  } satisfies Partial<CockpitActions>;
}

function machineActions(then: Then) {
  return {
    upgrade: (action, opts) => then(api.upgrade(action, opts)),
    checkBuild: () => then(api.checkBuild()),
    pullProject: () => then(api.pullProject()),
    snoozeUpdate: (target) => then(api.snoozeUpdate(target)),
    startLocalRun: (issueNumber, ref) => then(api.startLocalRun(issueNumber, ref)),
    stopLocalRun: () => then(api.stopLocalRun()),
    messageLocalRun: (text) => api.messageLocalRun(text).then(() => undefined),
    refreshLocalRun: () => then(api.refreshLocalRun()),
    validateLocally: (issueNumber, opts) => then(api.validateLocally(issueNumber, opts)),
    cancelLocalValidation: (issueNumber) => then(api.cancelLocalValidation(issueNumber)),
    localRunOutput: () => api.localRunOutput().then((r) => r.lines),
    tenantCommandOutput: (environment) => api.tenantCommandOutput(environment),
  } satisfies Partial<CockpitActions>;
}

function recordActions(then: Then, refresh: Refresh) {
  return {
    openPet: (id) => then(api.openPet(id)),
    feedPet: (id, beats) => then(api.feedPet(id, beats)),
    renamePet: (id, name) => then(api.renamePet(id, name)),
    placePet: (id, placed) => then(api.placePet(id, placed)),
    blendPet: (id) => then(api.blendPet(id)),
    completeHumanTask: (id, note) => then(api.completeHumanTask(id, note)),
    declineHumanTask: (id, note) => then(api.declineHumanTask(id, note)),
    closeHumanTaskTicket: (id, note) => then(api.closeHumanTaskTicket(id, note)),
    dismissHumanTask: (id) => then(api.dismissHumanTask(id)),

    setPrWatched: (n, watched) => then(api.setPrWatched(n, watched)),
    setStackLanding: (ref, landing) => then(api.setStackLanding(ref, landing)),
    setIssueWatched: (n, watched) => then(api.setIssueWatched(n, watched)),
    setIssueState: (n, state) => then(api.setIssueState(n, state)),
    setGoalPriority: (n, priority) => then(api.setGoalPriority(n, priority)),
    setIssueProfile: (n, profile) => then(api.setIssueProfile(n, profile)),
    setIssueParent: (n, parent) => then(api.setIssueParent(n, parent)),
    setIssueAreaPath: (n, areaPath) => then(api.setIssueAreaPath(n, areaPath)),
    setPartProfile: (planId, slug, profile) => then(api.setPartProfile(planId, slug, profile)),
    restartPart: (planId, slug) => then(api.restartPart(planId, slug)),
    regroupPlan: (planId, groups) => then(api.regroupPlan(planId, groups)),
    setIssueConclusion: (n, verdict) => then(api.setIssueConclusion(n, verdict)),
    setIssueAppraisal: (n, verdict) => then(api.setIssueAppraisal(n, verdict)),
    addInstruction: (n, text) => then(api.addInstruction(n, text)),
    withdrawInstruction: (n, id) => then(api.withdrawInstruction(n, id)),
    raiseBug: (n, summary, title) => then(api.raiseBug(n, summary, title)),
    probeFilingTarget: () => api.probeFilingTarget(),
    raiseIssue: async (title, body, watch) => {
      const filed = await api.raiseIssue(title, body, watch);
      await refresh(null);
      return filed;
    },
    dismissRun: (n, note) => then(api.dismissRun(n, note)),
  } satisfies Partial<CockpitActions>;
}

function configFixActions(undoable: Undoable, setAppliedFixes: (update: (rows: AppliedFix[]) => AppliedFix[]) => void) {
  return {
    applyConfigFix: async (checkId, set) => {
      const config = await api.getConfig();
      const paths = Object.keys(set);
      const previous: Record<string, unknown> = {};
      const clear: string[] = [];
      for (const path of paths) {
        const entry = config.groups.flatMap((group) => group.entries).find((e) => e.path === path);
        if (entry === undefined || entry.isDefault) clear.push(path);
        else previous[path] = entry.value;
      }
      await api.saveConfig({ set, baseline: config.revision });
      undoable.set(checkId, {
        ...(Object.keys(previous).length > 0 ? { set: previous } : {}),
        ...(clear.length > 0 ? { clear } : {}),
      });
      setAppliedFixes((rows) => [
        ...rows.filter((row) => row.checkId !== checkId),
        {
          checkId,
          summary: paths.map((path) => `${path} = ${JSON.stringify(set[path])}`).join(', '),
          file: config.file,
        },
      ]);
    },
    undoConfigFix: async (checkId) => {
      const edits = undoable.get(checkId);
      if (edits === undefined) return;
      const config = await api.getConfig();
      await api.saveConfig({ ...edits, baseline: config.revision });
      undoable.delete(checkId);
      setAppliedFixes((rows) => rows.filter((row) => row.checkId !== checkId));
    },
    dismissConfigFix: (checkId) => {
      undoable.delete(checkId);
      setAppliedFixes((rows) => rows.filter((row) => row.checkId !== checkId));
    },
  } satisfies Partial<CockpitActions>;
}
