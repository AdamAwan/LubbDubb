import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, connectWs, isDemo, UnauthorizedError } from '../api.js';
import type { WsClient } from '../api.js';
import type { AppState, GoalAgentsPayload, SetupPayload, StateSection } from '../types.js';
import type { AppliedFix } from '../view/needsYou.js';
import { useNow } from '../hooks.js';
import { buildViewModel, type CockpitView } from '../view/viewModel.js';
import { useNavigation } from './useNavigation.js';
import { homeTab, POOL_VIEWS, type Place } from './place.js';
import { logUsage, notePlace, placeReach } from './usage.js';
import type { CockpitActions } from './actions.js';
import { fireNotifications, loadNotifyPrefs, notifiableChanges, notifySnapshot } from './notify.js';
import { reconnectWatch } from './reconnect.js';
import { goalPrNumbers } from '../view/goalPage.js';

// → docs/spec/17-cockpit.md#the-address-bar

const REFRESH_COALESCE_MS = 200;

type CockpitStatus =
  | { kind: 'loading' }
  | { kind: 'denied'; error: UnauthorizedError }
  | { kind: 'ready'; view: CockpitView; actions: CockpitActions };

function useSurfaceReach(place: Place, arrival: 'linked' | 'direct'): void {
  const reach = placeReach(place);
  const key = `${reach.key}:${arrival}`;
  useEffect(() => {
    notePlace(reach.key, arrival);
    if (reach.view !== null) logUsage(reach.view);
    // `key` is the whole dependency on purpose; `reach` is recomputed each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

export function useCockpit(): CockpitStatus {
  const [state, setState] = useState<AppState | null>(null);
  const [denied, setDenied] = useState<UnauthorizedError | null>(null);
  const [connected, setConnected] = useState(false);
  const [setup, setSetup] = useState<SetupPayload | null>(null);
  const [appliedFixes, setAppliedFixes] = useState<AppliedFix[]>([]);
  const undoable = useRef(new Map<string, { set?: Record<string, unknown>; clear?: string[] }>());
  const { place, go, arrival } = useNavigation();
  useSurfaceReach(place, arrival);
  const selected = place.agent;
  const liveOutput = useRef<Map<string, string>>(new Map());
  const tails = useRef<Map<string, string>>(new Map());
  const wsRef = useRef<WsClient | null>(null);
  const [, forceRender] = useState(0);
  const lastPulse = useRef<number>(Date.now());
  const now = useNow(1000);

  const rejoined = useRef(reconnectWatch());
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshing = useRef(false);
  const refreshQueued = useRef(false);
  const pending = useRef<Set<StateSection> | null>(null);

  const refresh = useCallback(async (sections: ReadonlySet<StateSection> | null) => {
    try {
      const patch = await api.getState(sections);
      setState((prev) => {
        if (prev === null || sections === null) return patch as AppState;
        return { ...prev, ...patch, refUrls: { ...prev.refUrls, ...patch.refUrls } };
      });
      setDenied(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) setDenied(err);
    }
  }, []);

  const scheduleRefresh = useCallback(
    (sections?: readonly StateSection[]) => {
      if (sections === undefined) pending.current = null;
      else if (pending.current !== null) for (const section of sections) pending.current.add(section);

      if (refreshing.current) {
        refreshQueued.current = true;
        return;
      }
      if (refreshTimer.current) return;
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null;
        refreshing.current = true;
        const asked = pending.current;
        pending.current = new Set();
        void refresh(asked).finally(() => {
          refreshing.current = false;
          if (refreshQueued.current) {
            refreshQueued.current = false;
            scheduleRefresh();
          }
        });
      }, REFRESH_COALESCE_MS);
    },
    [refresh],
  );

  useEffect(() => {
    void refresh(null);
    const ws = connectWs(
      (ev) => {
        const e = ev as {
          type: string;
          agentId?: string;
          delta?: string;
          line?: string;
          text?: string;
          sections?: StateSection[];
          cap?: number;
          paused?: boolean;
        };
        if (e.type === 'control:changed' && typeof e.cap === 'number' && typeof e.paused === 'boolean') {
          const control = { cap: e.cap, paused: e.paused };
          setState((prev) => (prev === null ? prev : { ...prev, control }));
        } else if (e.type === 'dirty') scheduleRefresh(e.sections);
        else if (e.type === 'world:changed' || e.type === 'world:events') scheduleRefresh();
        else if (e.type === 'config:changed') window.dispatchEvent(new Event('lubbdubb:config-changed'));
        else if (e.type === 'agent:output' && e.agentId && e.delta) {
          const cur = liveOutput.current.get(e.agentId) ?? '';
          liveOutput.current.set(e.agentId, (cur + e.delta).slice(-1_000_000));
          forceRender((n) => n + 1);
        } else if (e.type === 'agent:tail' && e.agentId && e.line) {
          tails.current.set(e.agentId, e.line);
          forceRender((n) => n + 1);
        } else if (e.type === 'cycle:end') {
          lastPulse.current = Date.now();
          scheduleRefresh();
        }
      },
      (isConnected) => {
        setConnected(isConnected);
        if (!rejoined.current(isConnected)) return;
        scheduleRefresh();
        window.dispatchEvent(new Event('lubbdubb:config-changed'));
      },
    );
    wsRef.current = ws;
    return () => {
      ws.close();
      wsRef.current = null;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [refresh, scheduleRefresh]);

  const notified = useRef<ReturnType<typeof notifySnapshot> | null>(null);

  useEffect(() => {
    if (!state) return;
    const next = notifySnapshot(state, setup);
    fireNotifications(notifiableChanges(notified.current, next), loadNotifyPrefs());
    notified.current = next;
  }, [state, setup]);

  const [goalAgents, setGoalAgents] = useState<GoalAgentsPayload | null>(null);
  const goalRef = place.goal;
  const goalPrs = state !== null && goalRef !== null ? goalPrNumbers(state, goalRef).join(',') : '';
  useEffect(() => {
    if (goalRef === null) {
      setGoalAgents(null);
      return;
    }
    let live = true;
    void api
      .getGoalAgents(goalRef, goalPrs === '' ? [] : goalPrs.split(',').map(Number))
      .then((payload) => {
        if (live) setGoalAgents(payload);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [goalRef, goalPrs]);

  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || !selected) return;
    ws.subscribe(selected);
    return () => ws.unsubscribe(selected);
  }, [selected]);

  const readSetup = useCallback(() => {
    void api
      .getSetup()
      .then(setSetup)
      .catch(() => setSetup(null));
  }, []);
  useEffect(() => {
    readSetup();
    const onChanged = (): void => readSetup();
    window.addEventListener('lubbdubb:config-changed', onChanged);
    return () => window.removeEventListener('lubbdubb:config-changed', onChanged);
  }, [readSetup]);

  const actions = useMemo<CockpitActions>(() => {
    const then = <T>(p: Promise<T>) => p.then(() => refresh(null));
    return {
      refresh: () => refresh(null),
      pulse: () => then(api.pulse()),
      clearErrors: () => then(api.clearErrors()),
      select: (agentId) => go({ agent: agentId }),

      killAgent: (id) => then(api.killAgent(id)),
      completeAgent: (id) => then(api.completeAgent(id)),
      interruptAgent: (id) => api.interruptAgent(id).then(() => undefined),
      respondAgent: (id, text) => api.respondAgent(id, text).then(() => undefined),
      resumeAgent: (id) => then(api.resumeAgent(id)),
      ejectAgent: (id, reason) => then(api.ejectAgent(id, reason)),
      settleEjection: (id, outcome, note) => then(api.settleEjection(id, outcome, note)),
      extendStall: (id) => then(api.extendStall(id)),

      answerEscalation: (id, text) => then(api.answerEscalation(id, text)),
      answerQuestions: (id, answers) => then(api.answerQuestions(id, answers)),
      dismissEscalation: (id, note) => then(api.dismissEscalation(id, note)),
      decideProposal: (id, verdict, note, acknowledged, answers) =>
        then(verdict === 'accept' ? api.acceptProposal(id, note, acknowledged, answers) : api.rejectProposal(id, note)),
      backOutProposal: (id, verdict, note) => then(api.backOutProposal(id, verdict, note)),
      overruleShortfall: (issueNumber, proposalId, text) =>
        then(api.overruleShortfall(issueNumber, text).then(() => api.rejectProposal(proposalId, text))),
      releaseEnvironmentGate: (issueNumber, released, note) =>
        then(api.releaseEnvironmentGate(issueNumber, released, note)),
      decidePermission: (id, allow, note) => then(api.decidePermission(id, allow, note)),
      decideRecovery: (taskId, verdict) => then(api.decideRecovery(taskId, verdict)),

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
      viewPlan: (planId) => go({ plan: planId, planRegroup: false }),
      regroupPlanView: (on) => go({ planRegroup: on }),
      viewRetro: (issueRef) => go({ retro: issueRef }),
      hatchEgg: (id) => go({ hatch: id }),
      viewScratchpad: (issueRef) => go({ scratchpad: issueRef }),
      viewReviewPack: (prNumber) =>
        go(prNumber === null ? { reviewPack: null, reviewIdea: null } : { reviewPack: prNumber }),
      openReviewIdea: (id) => go({ reviewIdea: id }),
      setObstacleQuery: (next) => go(next),
      muteObstacle: (id, muted) => then(api.muteObstacle(id, muted)),
      ownObstacle: (id, ownerRef) => then(api.ownObstacle(id, ownerRef)),
      retireObstacle: (id) => then(api.retireObstacle(id)),
      writeDownObstacle: (id) => then(api.writeDownObstacle(id)),
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
      selectGoal: (ref) =>
        go((current) => (ref === null ? { goal: null, pr: null } : { goal: ref, pr: null, tab: homeTab(current.tab) })),
      selectPr: (prNumber) =>
        go((current) => (prNumber === null ? { pr: null } : { pr: prNumber, tab: homeTab(current.tab) })),
      reopenThread: (prNumber, threadId, reopened) => then(api.reopenPrThread(prNumber, threadId, reopened)),
      openPanel: (panel) => go({ panel }),
      openTab: (next) => go({ tab: next }),
      setTicketQuery: (next) => {
        logUsage('ticket.filter');
        go(next);
      },
      setFeatureQuery: (next) => {
        logUsage('feature.filter');
        go(next);
      },
      collapseFeature: (issueNumber, collapsed) =>
        go((current) => ({
          collapsed: collapsed
            ? [...current.collapsed, issueNumber]
            : current.collapsed.filter((n) => n !== issueNumber),
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
      openRemoteSheet: (environment) => go({ sheetEnvironment: environment }),
      ruleRemoteQuery: (issueNumber, environment, rowId, accept) =>
        then(api.ruleRemoteQuery(issueNumber, environment, rowId, accept)),
      selectRemoteRow: (issueNumber, environment, rowId, selected) =>
        then(api.selectRemoteRow(issueNumber, environment, rowId, selected)),
      pressRemoteSheet: (issueNumber, environment) => then(api.pressRemoteSheet(issueNumber, environment)),
      cancelRemoteRun: (issueNumber, environment) => then(api.cancelRemoteRun(issueNumber, environment)),
      reseedRemoteTenant: (issueNumber, environment) => then(api.reseedRemoteTenant(issueNumber, environment)),
      reorderUpNext: (origins) => then(api.reorderUpNext(origins)),
      setUpNextProfile: (origin, profile) => then(api.setUpNextProfile(origin, profile)),

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
        undoable.current.set(checkId, {
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
        const edits = undoable.current.get(checkId);
        if (edits === undefined) return;
        const config = await api.getConfig();
        await api.saveConfig({ ...edits, baseline: config.revision });
        undoable.current.delete(checkId);
        setAppliedFixes((rows) => rows.filter((row) => row.checkId !== checkId));
      },
      dismissConfigFix: (checkId) => {
        undoable.current.delete(checkId);
        setAppliedFixes((rows) => rows.filter((row) => row.checkId !== checkId));
      },

      fetchWorkSubtree: (ref) => api.getWorkSubtree(ref),
    };
  }, [refresh, go]);

  if (denied) return { kind: 'denied', error: denied };
  if (!state) return { kind: 'loading' };

  return {
    kind: 'ready',
    actions,
    view: buildViewModel({
      state,
      now,
      connected,
      demo: isDemo,
      setup,
      appliedFixes,
      selected,
      liveOutput: liveOutput.current,
      tails: tails.current,
      lastPulseAt: lastPulse.current,
      viewingPlan: place.plan,
      regroupingPlan: place.planRegroup,
      viewingRetro: place.retro,
      hatching: place.hatch,
      viewingScratchpad: place.scratchpad,
      viewingReviewPack: place.reviewPack,
      reviewIdea: place.reviewIdea,
      viewingObstacle: place.obstacle,
      obstacleEnded: place.obstacleEnded,
      insightsView: place.insightsView,
      insightsScope: place.insightsScope,
      insightsWindow: place.insightsWindow,
      poolProject: place.poolProject,
      sheetEnvironment: place.sheetEnvironment,
      selectedGoal: place.goal,
      selectedPr: place.pr,
      goalAgents,
      consolePanel: place.panel,
      tab: place.tab,
      collapsed: place.collapsed,
      goalOpen: place.goalOpen,
      goalShut: place.goalShut,
      configTab: place.configTab,
      configGroup: place.configGroup,
      ticketWatch: place.ticketWatch,
      ticketTracking: place.ticketTracking,
      ticketState: place.ticketState,
      ticketFeature: place.ticketFeature,
      ticketGroup: place.ticketGroup,
      ticketOrder: place.ticketOrder,
      ticketView: place.ticketView,
      ticketColumns: place.ticketColumns,
      featureCard: place.featureCard,
      featureSort: place.featureSort,
      featurePrs: place.featurePrs,
    }),
  };
}
