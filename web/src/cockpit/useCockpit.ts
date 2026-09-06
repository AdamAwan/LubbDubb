import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, connectWs, isDemo, UnauthorizedError } from '../api.js';
import type { WsClient } from '../api.js';
import type { AppState, GoalAgentsPayload, SetupPayload, StateSection } from '../types.js';
import type { AppliedFix } from '../view/needsYou.js';
import { useNow } from '../hooks.js';
import { buildViewModel, type CockpitView } from '../view/viewModel.js';
import { useNavigation } from './useNavigation.js';
import { homeTab, type Place } from './place.js';
import { logUsage, notePlace, placeReach } from './usage.js';
import type { CockpitActions } from './actions.js';
import { fireNotifications, loadNotifyPrefs, notifiableChanges, notifySnapshot } from './notify.js';
import { goalPrNumbers } from '../view/goalPage.js';

/** How long a refetch waits so a burst of live signals (a pulse's four, an agent's per-file writes) collapses into one request. */
const REFRESH_COALESCE_MS = 200;

type CockpitStatus =
  | { kind: 'loading' }
  | { kind: 'denied'; error: UnauthorizedError }
  | { kind: 'ready'; view: CockpitView; actions: CockpitActions };

/**
 * Everything between the harness and the drawn surface: the snapshot fetch, the websocket, the
 * coalescing refresh, and which drawer is open. The presentation layer never sees any of this.
 */
/**
 * The surface-reach writer: one `view` per place the operator lands on, and the place every other
 * `logUsage` call is attributed to. **Keyed on the reach, not on the place** — a place carries far
 * more than a surface, and keying on the whole thing would log a fresh `view` on every fold. Key is
 * the surface plus how it was arrived at. → `docs/spec/34-usage-metrics.md#surface-reach`
 */
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
  // What the harness says about its own configuration. Fetched, not polled — it shells out to git
  // and the agent binary server-side. Re-read on `config:changed` and once per world arrival.
  const [setup, setSetup] = useState<SetupPayload | null>(null);
  // Fixes written from the rail this session, and how to take each one back. Rows stay until
  // dismissed so a fixed row doesn't vanish under the click that fixed it.
  const [appliedFixes, setAppliedFixes] = useState<AppliedFix[]>([]);
  const undoable = useRef(new Map<string, { set?: Record<string, unknown>; clear?: string[] }>());
  // Where the operator is, held in the address bar rather than state — see `useNavigation`.
  const { place, go, arrival } = useNavigation();
  useSurfaceReach(place, arrival);
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
  /**
   * What the signals waiting to be coalesced actually touched. `null` means "everything" — the
   * safe value for a signal that cannot name its sections, and the first load. A set is the
   * **union** of the coalesced signals' sections, so collapsing a burst can only widen the request.
   * → `docs/spec/16-http-api.md#sections`
   */
  const pending = useRef<Set<StateSection> | null>(null);

  const refresh = useCallback(async (sections: ReadonlySet<StateSection> | null) => {
    try {
      const patch = await api.getState(sections);
      setState((prev) => {
        // A patch is merged over the held snapshot so the cockpit's state stays one complete
        // `AppState`. A full fetch carries every key, so the merge is a replacement there.
        if (prev === null || sections === null) return patch as AppState;
        // `refUrls` is merged, not replaced: an entry can only go stale by being absent.
        return { ...prev, ...patch, refUrls: { ...prev.refUrls, ...patch.refUrls } };
      });
      setDenied(null);
    } catch (err) {
      // A refused credential never resolves by retrying, so it gets a screen; everything else
      // is a transient the next poll fixes.
      if (err instanceof UnauthorizedError) setDenied(err);
    }
  }, []);

  /**
   * Refetch the whole snapshot, coalescing bursts into one request. The server pairs a coarse
   * `dirty` with almost every specific frame — one pulse alone is four signals, and
   * `agents.on('files')` fires once per file an agent writes. At most one request in flight and one
   * queued behind it, plus a short trailing window. The queued fetch always runs: coalescing may
   * merge signals but must never drop the last.
   */
  const scheduleRefresh = useCallback(
    (sections?: readonly StateSection[]) => {
      // Widen first, always — before any early return, so a signal arriving mid-fetch is recorded.
      if (sections === undefined) pending.current = null;
      else if (pending.current !== null) for (const section of sections) pending.current.add(section);

      if (refreshing.current) {
        refreshQueued.current = true;
        return;
      }
      if (refreshTimer.current) return; // a trailing fetch is already pending
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null;
        refreshing.current = true;
        const asked = pending.current;
        // Reset before the fetch: a signal landing mid-flight belongs to the queued fetch behind it.
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
        // The cap or the pause moved and the frame carries both, so there is nothing to fetch.
        if (e.type === 'control:changed' && typeof e.cap === 'number' && typeof e.paused === 'boolean') {
          const control = { cap: e.cap, paused: e.paused };
          setState((prev) => (prev === null ? prev : { ...prev, control }));
        }
        // A `dirty` names the sections it touched, or none — which means all of them.
        else if (e.type === 'dirty') scheduleRefresh(e.sections);
        else if (e.type === 'world:changed' || e.type === 'world:events') scheduleRefresh();
        // The config file moved. Re-broadcast as a DOM event rather than folded into
        // `scheduleRefresh`: config is not on `/api/state`, and only the page that cares should pay
        // to re-read it.
        else if (e.type === 'config:changed') window.dispatchEvent(new Event('lubbdubb:config-changed'));
        else if (e.type === 'agent:output' && e.agentId && e.delta) {
          const cur = liveOutput.current.get(e.agentId) ?? '';
          // Full output only arrives for the subscribed (open) agent; kept scrollback is capped to bound memory.
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

  // What the last snapshot held, for the notification diff. A ref, not state, so it doesn't
  // itself cause a render.
  const notified = useRef<ReturnType<typeof notifySnapshot> | null>(null);

  useEffect(() => {
    if (!state) return;
    const next = notifySnapshot(state, setup);
    // Read the preference per fire, not held: Settings writes it to `localStorage` directly.
    fireNotifications(notifiableChanges(notified.current, next), loadNotifyPrefs());
    notified.current = next;
  }, [state, setup]);

  /**
   * The open goal's whole run history, fetched when its page opens. On its own route rather than
   * off `/api/state`: the snapshot carries only the fleet's live agents and a bounded tail of ended
   * ones. Re-read when the goal's pull requests change, not on the state poll — a run dispatched
   * since the fetch is already drawn by the snapshot's own agents.
   */
  const [goalAgents, setGoalAgents] = useState<GoalAgentsPayload | null>(null);
  const goalRef = place.goal;
  // A string, so the effect compares by value — an array dependency would refetch on every poll.
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
      // Drawn as nothing, recorded nowhere: a failed history read is a shorter list, not a broken page.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [goalRef, goalPrs]);

  // Subscribe to full output only while a drawer is open; unsubscribe on close/switch.
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || !selected) return;
    ws.subscribe(selected);
    return () => ws.unsubscribe(selected);
  }, [selected]);

  // The setup reading, on open and whenever the file moves — same event the config page listens on.
  const readSetup = useCallback(() => {
    void api
      .getSetup()
      .then(setSetup)
      // Recorded nowhere, drawn as nothing: the surface it feeds simply does not appear.
      .catch(() => setSetup(null));
  }, []);
  useEffect(() => {
    readSetup();
    const onChanged = (): void => readSetup();
    window.addEventListener('lubbdubb:config-changed', onChanged);
    return () => window.removeEventListener('lubbdubb:config-changed', onChanged);
  }, [readSetup]);

  const actions = useMemo<CockpitActions>(() => {
    // An operator's own write is followed by a **full** refresh: a click can move anything, and
    // unlike a socket signal nothing here knows what it touched. Sections are for fleet chatter.
    const then = <T>(p: Promise<T>) => p.then(() => refresh(null));
    return {
      refresh: () => refresh(null),
      pulse: () => then(api.pulse()),
      clearErrors: () => then(api.clearErrors()),
      select: (agentId) => go({ agent: agentId }),

      killAgent: (id) => then(api.killAgent(id)),
      completeAgent: (id) => then(api.completeAgent(id)),
      // Interrupt and respond do not refetch: both are conversational and the server's `dirty` brings the state along.
      interruptAgent: (id) => api.interruptAgent(id).then(() => undefined),
      respondAgent: (id, text) => api.respondAgent(id, text).then(() => undefined),
      resumeAgent: (id) => then(api.resumeAgent(id)),
      extendStall: (id) => then(api.extendStall(id)),

      answerEscalation: (id, text) => then(api.answerEscalation(id, text)),
      answerQuestions: (id, answers) => then(api.answerQuestions(id, answers)),
      dismissEscalation: (id, note) => then(api.dismissEscalation(id, note)),
      decideProposal: (id, verdict, note, acknowledged) =>
        then(verdict === 'accept' ? api.acceptProposal(id, note, acknowledged) : api.rejectProposal(id, note)),
      backOutProposal: (id, verdict, note) => then(api.backOutProposal(id, verdict, note)),
      // No refetch: nothing changes until the operator sends the verdict.
      overruleShortfall: (issueNumber, proposalId, text) =>
        then(api.overruleShortfall(issueNumber, text).then(() => api.rejectProposal(proposalId, text))),
      releaseEnvironmentGate: (issueNumber, released, note) =>
        then(api.releaseEnvironmentGate(issueNumber, released, note)),
      decidePermission: (id, allow, note) => then(api.decidePermission(id, allow, note)),
      decideRecovery: (taskId, verdict) => then(api.decideRecovery(taskId, verdict)),

      replan: (planId) => then(api.replan(planId)),
      ruleWatchProposal: (issueNumber, checkId, accept) => then(api.ruleWatchProposal(issueNumber, checkId, accept)),
      // Refetches like every other write, and hands the dry run's refusals back to the form.
      saveWatchCheck: async (issueNumber, check) => {
        const { dryRun } = await api.saveWatchCheck(issueNumber, check);
        await refresh(null);
        return dryRun;
      },
      deleteWatchCheck: (issueNumber, checkId) => then(api.deleteWatchCheck(issueNumber, checkId)),
      extendWatch: (issueNumber, environment) => then(api.extendWatch(issueNumber, environment)),
      setAcceptance: (planId, slug, criterion, met) => then(api.setAcceptance(planId, slug, criterion, met)),
      setValidation: (issueNumber, checkId, act) => then(api.setValidation(issueNumber, checkId, act)),
      viewPlan: (planId) => go({ plan: planId }),
      viewRetro: (issueRef) => go({ retro: issueRef }),
      hatchEgg: (id) => go({ hatch: id }),
      viewScratchpad: (issueRef) => go({ scratchpad: issueRef }),
      // Closing the pack drops the idea with it: a place naming one with no page open doesn't exist.
      viewReviewPack: (prNumber) =>
        go(prNumber === null ? { reviewPack: null, reviewIdea: null } : { reviewPack: prNumber }),
      openReviewIdea: (id) => go({ reviewIdea: id }),
      // One `go` for both fields — one history entry for a single move.
      setObstacleQuery: (next) => go(next),
      muteObstacle: (id, muted) => then(api.muteObstacle(id, muted)),
      ownObstacle: (id, ownerRef) => then(api.ownObstacle(id, ownerRef)),
      retireObstacle: (id) => then(api.retireObstacle(id)),
      writeDownObstacle: (id) => then(api.writeDownObstacle(id)),
      openConfig: (where) => go({ tab: 'config', goal: null, ...where }),
      // One `go` for both halves — one history entry for a single change.
      openInsights: (where) => go({ tab: 'insights', goal: null, ...where }),
      // The tab comes with it, narrowed to one that could have led here, since a `<Ref>` opens a
      // goal from anywhere and the crumb must lead back to a page the nav was actually on. → `homeTab`
      selectGoal: (ref) =>
        go((current) => (ref === null ? { goal: null, pr: null } : { goal: ref, pr: null, tab: homeTab(current.tab) })),
      // The goal underneath is left where it was — the crumb's target. Tab travels for `selectGoal`'s reason.
      selectPr: (prNumber) =>
        go((current) => (prNumber === null ? { pr: null } : { pr: prNumber, tab: homeTab(current.tab) })),
      reopenThread: (prNumber, threadId, reopened) => then(api.reopenPrThread(prNumber, threadId, reopened)),
      openPanel: (panel) => go({ panel }),
      openTab: (next) => go({ tab: next }),
      // One `go` for however many fields moved — one history entry per change.
      setTicketQuery: (next) => {
        // The one seam every filter/ordering/layout control on the tab funnels through.
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
      // Written to *both* lists, always: recording only the open half would leave "shut" meaning
      // "whatever the goal's progress says", springing the card open under them later.
      openGoalSection: (section, open) =>
        go((current) => ({
          goalOpen: open
            ? [...current.goalOpen.filter((name) => name !== section), section].sort((a, b) => a.localeCompare(b))
            : current.goalOpen.filter((name) => name !== section),
          goalShut: open
            ? current.goalShut.filter((name) => name !== section)
            : [...current.goalShut.filter((name) => name !== section), section].sort((a, b) => a.localeCompare(b)),
        })),
      reorderUpNext: (origins) => then(api.reorderUpNext(origins)),
      setUpNextProfile: (origin, profile) => then(api.setUpNextProfile(origin, profile)),

      upgrade: (action, opts) => then(api.upgrade(action, opts)),
      checkBuild: () => then(api.checkBuild()),
      pullProject: () => then(api.pullProject()),
      snoozeUpdate: (target) => then(api.snoozeUpdate(target)),
      startLocalRun: (issueNumber, ref) => then(api.startLocalRun(issueNumber, ref)),
      stopLocalRun: () => then(api.stopLocalRun()),
      // Conversational, like `respondAgent`: the server's `dirty` brings the echo.
      messageLocalRun: (text) => api.messageLocalRun(text).then(() => undefined),
      refreshLocalRun: () => then(api.refreshLocalRun()),
      // Refetched: the write moves the local run and the goal at once, drawn on the same screen.
      validateLocally: (issueNumber, opts) => then(api.validateLocally(issueNumber, opts)),
      cancelLocalValidation: (issueNumber) => then(api.cancelLocalValidation(issueNumber)),
      // Not wrapped in `then`: a read, so opening the panel doesn't cost a full snapshot refetch.
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
      setIssueConclusion: (n, verdict) => then(api.setIssueConclusion(n, verdict)),
      setIssueAppraisal: (n, verdict) => then(api.setIssueAppraisal(n, verdict)),
      addInstruction: (n, text) => then(api.addInstruction(n, text)),
      withdrawInstruction: (n, id) => then(api.withdrawInstruction(n, id)),
      raiseBug: (n, summary, title) => then(api.raiseBug(n, summary, title)),
      // A read, so no refetch.
      probeFilingTarget: () => api.probeFilingTarget(),
      // Refetched like every other mutation, but the filed issue is handed back rather than
      // swallowed, so the modal's done state can link to it (issue #449).
      raiseIssue: async (title, body, watch) => {
        const filed = await api.raiseIssue(title, body, watch);
        await refresh(null);
        return filed;
      },
      dismissRun: (n, note) => then(api.dismissRun(n, note)),

      applyConfigFix: async (checkId, set) => {
        const config = await api.getConfig();
        // What the file said before, so the undo is a real restore: a key never set stays cleared.
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

      // A read: the work graph rides its own route so it isn't pulled along by the state poll.
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
      viewingRetro: place.retro,
      hatching: place.hatch,
      viewingScratchpad: place.scratchpad,
      viewingReviewPack: place.reviewPack,
      reviewIdea: place.reviewIdea,
      viewingObstacle: place.obstacle,
      obstacleEnded: place.obstacleEnded,
      insightsView: place.insightsView,
      insightsWindow: place.insightsWindow,
      poolProject: place.poolProject,
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
