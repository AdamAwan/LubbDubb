import { useCallback, useEffect, useRef, useState } from 'react';
import { api, connectWs, isDemo, UnauthorizedError } from '../api.js';
import type { WsClient } from '../api.js';
import type { AppState, GoalAgentsPayload, SetupPayload, StateSection } from '../types.js';
import { useNow } from '../hooks.js';
import { buildViewModel, type CockpitView } from '../view/viewModel.js';
import { useNavigation } from './useNavigation.js';
import type { Place } from './place.js';
import { logUsage, notePlace, placeReach } from './usage.js';
import type { CockpitActions } from './actions.js';
import { useCockpitActions } from './useCockpitActions.js';
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

type SocketEvent = {
  type: string;
  agentId?: string;
  delta?: string;
  line?: string;
  text?: string;
  sections?: StateSection[];
  cap?: number;
  paused?: boolean;
};

function useStateFetch() {
  const [state, setState] = useState<AppState | null>(null);
  const [denied, setDenied] = useState<UnauthorizedError | null>(null);

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

  return { state, setState, denied, refresh };
}

function useCoalescedRefresh(refresh: (sections: ReadonlySet<StateSection> | null) => Promise<void>) {
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshing = useRef(false);
  const refreshQueued = useRef(false);
  const pending = useRef<Set<StateSection> | null>(null);

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

  const cancelRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
  }, []);

  return { scheduleRefresh, cancelRefresh };
}

function streamAgent(e: SocketEvent, liveOutput: Map<string, string>, tails: Map<string, string>): boolean {
  if (e.type === 'agent:output' && e.agentId && e.delta) {
    const cur = liveOutput.get(e.agentId) ?? '';
    liveOutput.set(e.agentId, (cur + e.delta).slice(-1_000_000));
    return true;
  }
  if (e.type === 'agent:tail' && e.agentId && e.line) {
    tails.set(e.agentId, e.line);
    return true;
  }
  return false;
}

function useLiveState() {
  const { state, setState, denied, refresh } = useStateFetch();
  const { scheduleRefresh, cancelRefresh } = useCoalescedRefresh(refresh);
  const [connected, setConnected] = useState(false);
  const liveOutput = useRef<Map<string, string>>(new Map());
  const tails = useRef<Map<string, string>>(new Map());
  const wsRef = useRef<WsClient | null>(null);
  const [, forceRender] = useState(0);
  const lastPulse = useRef<number>(Date.now());
  const rejoined = useRef(reconnectWatch());

  useEffect(() => {
    void refresh(null);
    const ws = connectWs(
      (ev) => {
        const e = ev as SocketEvent;
        if (e.type === 'control:changed' && typeof e.cap === 'number' && typeof e.paused === 'boolean') {
          const control = { cap: e.cap, paused: e.paused };
          setState((prev) => (prev === null ? prev : { ...prev, control }));
        } else if (e.type === 'dirty') scheduleRefresh(e.sections);
        else if (e.type === 'world:changed' || e.type === 'world:events') scheduleRefresh();
        else if (e.type === 'config:changed') window.dispatchEvent(new Event('lubbdubb:config-changed'));
        else if (streamAgent(e, liveOutput.current, tails.current)) forceRender((n) => n + 1);
        else if (e.type === 'cycle:end') {
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
      cancelRefresh();
    };
  }, [refresh, scheduleRefresh, setState, cancelRefresh]);

  return { state, denied, connected, refresh, liveOutput, tails, lastPulse, wsRef };
}

function useNotifications(state: AppState | null, setup: SetupPayload | null): void {
  const notified = useRef<ReturnType<typeof notifySnapshot> | null>(null);

  useEffect(() => {
    if (!state) return;
    const next = notifySnapshot(state, setup);
    fireNotifications(notifiableChanges(notified.current, next), loadNotifyPrefs());
    notified.current = next;
  }, [state, setup]);
}

function useGoalAgents(state: AppState | null, goalRef: string | null): GoalAgentsPayload | null {
  const [goalAgents, setGoalAgents] = useState<GoalAgentsPayload | null>(null);
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
  return goalAgents;
}

function useAgentSubscription(wsRef: { readonly current: WsClient | null }, selected: string | null): void {
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || !selected) return;
    ws.subscribe(selected);
    return () => ws.unsubscribe(selected);
  }, [wsRef, selected]);
}

function useSetup(): SetupPayload | null {
  const [setup, setSetup] = useState<SetupPayload | null>(null);
  const readSetup = useCallback(() => {
    void api
      .getSetup()
      .then(setSetup)
      .catch(() => setSetup(null));
  }, [setSetup]);
  useEffect(() => {
    readSetup();
    const onChanged = (): void => readSetup();
    window.addEventListener('lubbdubb:config-changed', onChanged);
    return () => window.removeEventListener('lubbdubb:config-changed', onChanged);
  }, [readSetup]);
  return setup;
}

export function useCockpit(): CockpitStatus {
  const { place, go, arrival } = useNavigation();
  useSurfaceReach(place, arrival);
  const live = useLiveState();
  const setup = useSetup();
  const now = useNow(1000);
  useNotifications(live.state, setup);
  const goalAgents = useGoalAgents(live.state, place.goal);
  useAgentSubscription(live.wsRef, place.agent);
  const { actions, appliedFixes } = useCockpitActions(live.refresh, go);

  const { state, denied, connected } = live;
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
      selected: place.agent,
      liveOutput: live.liveOutput.current,
      tails: live.tails.current,
      lastPulseAt: live.lastPulse.current,
      viewingPlan: place.plan,
      regroupingPlan: place.planRegroup,
      viewingRetro: place.retro,
      hatching: place.hatch,
      viewingScratchpad: place.scratchpad,
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
      goalTab: place.goalTab,
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
      featureDensity: place.featureDensity,
      petsBlended: place.petsBlended,
      overviewShape: place.overview,
      featureMode: place.featureMode,
      featurePrs: place.featurePrs,
    }),
  };
}
