import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, connectWs, isDemo, UnauthorizedError } from '../api.js';
import type { WsClient } from '../api.js';
import type { AppState } from '../types.js';
import { useNow } from '../hooks.js';
import { buildViewModel, type CockpitView } from '../view/viewModel.js';
import { useNavigation } from './useNavigation.js';
import type { CockpitActions } from './actions.js';
import { fireNotifications, loadNotifyPrefs, notifiableChanges, notifySnapshot } from './notify.js';

/**
 * How long a refetch waits so a burst of live signals collapses into one request.
 * Short enough to read as immediate, long enough to swallow the four signals one
 * pulse emits and the per-file ones an agent's writes emit.
 */
const REFRESH_COALESCE_MS = 200;

type CockpitStatus =
  | { kind: 'loading' }
  | { kind: 'denied'; error: UnauthorizedError }
  | { kind: 'ready'; view: CockpitView; actions: CockpitActions };

/**
 * Everything between the harness and the drawn surface: the snapshot fetch, the
 * websocket, the coalescing refresh, and which drawer is open. The presentation
 * layer receives its output and never sees any of this — which is the point,
 * since it is the half that must behave identically whatever the cockpit looks
 * like.
 */
export function useCockpit(): CockpitStatus {
  const [state, setState] = useState<AppState | null>(null);
  const [denied, setDenied] = useState<UnauthorizedError | null>(null);
  const [connected, setConnected] = useState(false);
  // Where the operator is, held in the address bar rather than in a state each —
  // see `useNavigation`. Everything below reads off it; nothing else moves it.
  const { place, go } = useNavigation();
  const selected = place.agent;
  // Live per-agent output accumulated from WS deltas (only for subscribed agents).
  const liveOutput = useRef<Map<string, string>>(new Map());
  // Last output line per agent, fed by compact `agent:tail` frames — used for
  // fleet-card previews since full output no longer reaches every client.
  const tails = useRef<Map<string, string>>(new Map());
  // Stable reconnecting WS client so subscribe/unsubscribe survives effect churn.
  const wsRef = useRef<WsClient | null>(null);
  const [, forceRender] = useState(0);
  // Anchor for the heartbeat countdown: when the last pulse landed.
  const lastPulse = useRef<number>(Date.now());
  const now = useNow(1000);

  // Coalescing state for `scheduleRefresh`: the pending trailing timer, whether a
  // fetch is in flight, and whether a signal arrived while one was.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshing = useRef(false);
  const refreshQueued = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setState(await api.getState());
      setDenied(null);
    } catch (err) {
      // A refused credential is the one fetch failure that never resolves itself
      // by retrying, so it gets a screen. Everything else is a transient the next
      // poll fixes, and must not replace a working cockpit with an error page.
      if (err instanceof UnauthorizedError) setDenied(err);
    }
  }, []);

  /**
   * Refetch the whole snapshot, coalescing bursts into one request. Every live
   * signal lands here, and the server pairs a coarse `dirty` with almost every
   * specific frame — so one pulse alone is four signals, and `agents.on('files')`
   * fires once *per file an agent writes*. Fetching per signal made the request
   * rate a function of agent tool-call volume.
   *
   * At most one request in flight and at most one queued behind it, plus a short
   * trailing window so a burst collapses. The queued one always runs: coalescing
   * may merge the signals in between but must never drop the last, or the cockpit
   * settles on a state older than what it was told about.
   */
  const scheduleRefresh = useCallback(() => {
    if (refreshing.current) {
      refreshQueued.current = true;
      return;
    }
    if (refreshTimer.current) return; // a trailing fetch is already pending
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      refreshing.current = true;
      void refresh().finally(() => {
        refreshing.current = false;
        if (refreshQueued.current) {
          refreshQueued.current = false;
          scheduleRefresh();
        }
      });
    }, REFRESH_COALESCE_MS);
  }, [refresh]);

  useEffect(() => {
    void refresh();
    const ws = connectWs(
      (ev) => {
        const e = ev as { type: string; agentId?: string; delta?: string; line?: string; text?: string };
        if (
          e.type === 'dirty' ||
          e.type === 'world:changed' ||
          e.type === 'control:changed' ||
          e.type === 'world:events'
        )
          scheduleRefresh();
        else if (e.type === 'agent:output' && e.agentId && e.delta) {
          const cur = liveOutput.current.get(e.agentId) ?? '';
          // Full output now only arrives for the subscribed (open) agent, so we
          // keep a large scrollback (~1M chars) instead of the old 20k window —
          // the watched session no longer loses history. Capped to bound memory.
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
      (isConnected) => setConnected(isConnected),
    );
    wsRef.current = ws;
    return () => {
      ws.close();
      wsRef.current = null;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [refresh, scheduleRefresh]);

  // What the last snapshot held, for the notification diff. A ref rather than
  // state: it must not itself cause a render, and the comparison has to survive
  // the renders the snapshot does cause.
  const notified = useRef<ReturnType<typeof notifySnapshot> | null>(null);

  useEffect(() => {
    if (!state) return;
    const next = notifySnapshot(state);
    // Read the preference per fire rather than holding it: Settings writes it to
    // `localStorage` directly, and a copy captured at mount would go on notifying
    // for the rest of the session after the operator switched it off.
    fireNotifications(notifiableChanges(notified.current, next), loadNotifyPrefs());
    notified.current = next;
  }, [state]);

  // Subscribe to full output only while a drawer is open; unsubscribe on close/switch.
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || !selected) return;
    ws.subscribe(selected);
    return () => ws.unsubscribe(selected);
  }, [selected]);

  const actions = useMemo<CockpitActions>(() => {
    const then = <T>(p: Promise<T>) => p.then(() => refresh());
    return {
      refresh,
      pulse: () => then(api.pulse()),
      clearErrors: () => then(api.clearErrors()),
      select: (agentId) => go({ agent: agentId }),

      killAgent: (id) => then(api.killAgent(id)),
      completeAgent: (id) => then(api.completeAgent(id)),
      // Interrupt and respond deliberately do not refetch: both are conversational
      // and the `dirty` the server emits brings the new state along anyway.
      interruptAgent: (id) => api.interruptAgent(id).then(() => undefined),
      respondAgent: (id, text) => api.respondAgent(id, text).then(() => undefined),
      resumeAgent: (id) => then(api.resumeAgent(id)),

      answerEscalation: (id, text) => then(api.answerEscalation(id, text)),
      answerQuestions: (id, answers) => then(api.answerQuestions(id, answers)),
      dismissEscalation: (id, note) => then(api.dismissEscalation(id, note)),
      decideProposal: (id, verdict, note) =>
        then(verdict === 'accept' ? api.acceptProposal(id, note) : api.rejectProposal(id, note)),
      overruleShortfall: (issueNumber, proposalId, text) =>
        then(api.overruleShortfall(issueNumber, text).then(() => api.rejectProposal(proposalId, text))),
      decidePermission: (id, allow, note) => then(api.decidePermission(id, allow, note)),
      decideRecovery: (taskId, verdict) => then(api.decideRecovery(taskId, verdict)),

      replan: (planId) => then(api.replan(planId)),
      setAcceptance: (planId, slug, criterion, met) => then(api.setAcceptance(planId, slug, criterion, met)),
      setValidation: (issueNumber, checkId, act) => then(api.setValidation(issueNumber, checkId, act)),
      viewPlan: (planId) => go({ plan: planId }),
      viewRetro: (issueRef) => go({ retro: issueRef }),
      viewScratchpad: (issueRef) => go({ scratchpad: issueRef }),
      openSettings: (open) => go({ settings: open }),
      openSpend: (open) => go({ spend: open }),
      openReliability: (open) => go({ reliability: open }),
      selectGoal: (ref) => go({ goal: ref }),
      openPanel: (panel) => go({ panel }),
      openTab: (next) => go({ tab: next }),
      // One `go` for however many of the three moved: they are one place, and two
      // calls would push two history entries for a single change of question.
      setTicketQuery: (next) => go(next),
      collapseFeature: (issueNumber, collapsed) =>
        go((current) => ({
          collapsed: collapsed
            ? [...current.collapsed, issueNumber]
            : current.collapsed.filter((n) => n !== issueNumber),
        })),
      discussPlan: (planId) => then(api.discussPlan(planId)),
      endPlanDiscussion: (planId) => then(api.endPlanDiscussion(planId)),
      reorderUpNext: (origins) => then(api.reorderUpNext(origins)),

      upgrade: (action, opts) => then(api.upgrade(action, opts)),
      checkBuild: () => then(api.checkBuild()),

      promoteFinding: (id) => then(api.promoteFinding(id)),
      fileFinding: (id) => then(api.fileFinding(id)),
      dismissFinding: (id) => then(api.dismissFinding(id)),
      proposeLesson: (text, originRef) => then(api.proposeLesson(text, originRef)),
      promoteLesson: (id) => then(api.promoteLesson(id)),
      retireLesson: (id) => then(api.retireLesson(id)),
      completeHumanTask: (id) => then(api.completeHumanTask(id)),
      declineHumanTask: (id, note) => then(api.declineHumanTask(id, note)),
      dismissHumanTask: (id) => then(api.dismissHumanTask(id)),

      setPrExcluded: (n, excluded) => then(api.setPrExcluded(n, excluded)),
      setStackLanding: (ref, landing) => then(api.setStackLanding(ref, landing)),
      setIssueWatched: (n, watched) => then(api.setIssueWatched(n, watched)),
      setGoalPriority: (n, priority) => then(api.setGoalPriority(n, priority)),
      setIssueProfile: (n, profile) => then(api.setIssueProfile(n, profile)),
      setPartProfile: (planId, slug, profile) => then(api.setPartProfile(planId, slug, profile)),
      setIssueConclusion: (n, verdict) => then(api.setIssueConclusion(n, verdict)),
      setIssueAssay: (n, verdict) => then(api.setIssueAssay(n, verdict)),
      addInstruction: (n, text) => then(api.addInstruction(n, text)),
      withdrawInstruction: (n, id) => then(api.withdrawInstruction(n, id)),
      raiseBug: (n, summary, title) => then(api.raiseBug(n, summary, title)),
      dismissRun: (n) => then(api.dismissRun(n)),

      // A read, so no refetch: the work graph rides its own route precisely
      // because it must not be pulled along by the state poll.
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
      selected,
      liveOutput: liveOutput.current,
      tails: tails.current,
      lastPulseAt: lastPulse.current,
      viewingPlan: place.plan,
      viewingRetro: place.retro,
      viewingScratchpad: place.scratchpad,
      settingsOpen: place.settings,
      spendOpen: place.spend,
      reliabilityOpen: place.reliability,
      selectedGoal: place.goal,
      consolePanel: place.panel,
      tab: place.tab,
      collapsed: place.collapsed,
      ticketWatch: place.ticketWatch,
      ticketTracking: place.ticketTracking,
      ticketState: place.ticketState,
      ticketFeature: place.ticketFeature,
      ticketGroup: place.ticketGroup,
      ticketOrder: place.ticketOrder,
    }),
  };
}
