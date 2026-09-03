import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, connectWs, isDemo, UnauthorizedError } from '../api.js';
import type { WsClient } from '../api.js';
import type { AppState, GoalAgentsPayload, SetupPayload, StateSection } from '../types.js';
import type { AppliedFix } from '../view/needsYou.js';
import { useNow } from '../hooks.js';
import { buildViewModel, type CockpitView } from '../view/viewModel.js';
import { useNavigation } from './useNavigation.js';
import { homeTab } from './place.js';
import type { CockpitActions } from './actions.js';
import { fireNotifications, loadNotifyPrefs, notifiableChanges, notifySnapshot } from './notify.js';
import { goalPrNumbers } from '../view/goalPage.js';

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
  // What the harness says about its own configuration. Fetched rather than polled:
  // the reading shells out to git and to the agent binary server-side, which is not
  // a thing to do on a heartbeat, and it can only move when the config file does or
  // when a cycle has read the world. So it is re-read on `config:changed` and on
  // each snapshot the first time the world arrives — never on the second.
  const [setup, setSetup] = useState<SetupPayload | null>(null);
  // Fixes written from the rail this session, and how to take each one back. The
  // rows stay until dismissed: the reading re-fetches as soon as the file lands,
  // so a fixed row would otherwise vanish under the click that fixed it.
  const [appliedFixes, setAppliedFixes] = useState<AppliedFix[]>([]);
  const undoable = useRef(new Map<string, { set?: Record<string, unknown>; clear?: string[] }>());
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
  /**
   * What the signals waiting to be coalesced actually touched.
   *
   * `null` means "everything" and is the safe value: a signal that cannot name its
   * sections, and the first load, both ask for the lot. A set is the **union** of
   * what the coalesced signals named, so collapsing a burst can only ever widen
   * the request — never narrow it past something one of them said had moved.
   * → `docs/spec/16-http-api.md#sections`
   */
  const pending = useRef<Set<StateSection> | null>(null);

  const refresh = useCallback(async (sections: ReadonlySet<StateSection> | null) => {
    try {
      const patch = await api.getState(sections);
      setState((prev) => {
        // A patch is merged over the snapshot we hold, which is what keeps the
        // cockpit's state one complete `AppState`: `buildViewModel` and every
        // surface under it go on receiving a whole object and never learn that
        // anything arrived in parts. A full fetch carries every key, so the merge
        // is a replacement in that case and the branch is not worth taking.
        if (prev === null || sections === null) return patch as AppState;
        // `refUrls` rides every response and is merged rather than replaced: a
        // ref's URL is stable, so an entry can only go stale by being absent, and
        // a ref learned in one patch has to survive the next.
        return { ...prev, ...patch, refUrls: { ...prev.refUrls, ...patch.refUrls } };
      });
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
  const scheduleRefresh = useCallback(
    (sections?: readonly StateSection[]) => {
      // Widen first, always — before any early return. A signal that arrives while
      // a fetch is in flight or a timer is pending still has to be recorded, or the
      // request that eventually goes out asks for less than it was told about and
      // the cockpit settles on a surface that quietly stopped updating.
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
        // Reset before the fetch, not after: a signal that lands mid-flight is
        // about state the in-flight request may already have read past, and it
        // belongs to the queued fetch behind it.
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
        // The cap or the pause moved, and the frame carries both — so it *is* the
        // delivery, and there is nothing to fetch. `ControlState` is exactly
        // `{cap, paused}`: pushing the cap used to cost a rebuild of all 48 keys
        // of the snapshot, for two numbers the socket had already sent.
        if (e.type === 'control:changed' && typeof e.cap === 'number' && typeof e.paused === 'boolean') {
          const control = { cap: e.cap, paused: e.paused };
          setState((prev) => (prev === null ? prev : { ...prev, control }));
        }
        // A `dirty` names the sections it touched, or names none — which means all
        // of them, and is what a signal that cannot say should send.
        else if (e.type === 'dirty') scheduleRefresh(e.sections);
        else if (e.type === 'world:changed' || e.type === 'world:events') scheduleRefresh();
        // The config file moved — a save from another cockpit, or the watcher
        // picking up an edit on disk. Re-broadcast as a DOM event rather than
        // folded into `scheduleRefresh`: the config is not on `/api/state` (it is
        // a constant this socket is the only news about), and the page that cares
        // is the one place that should pay for re-reading it.
        else if (e.type === 'config:changed') window.dispatchEvent(new Event('lubbdubb:config-changed'));
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
    const next = notifySnapshot(state, setup);
    // Read the preference per fire rather than holding it: Settings writes it to
    // `localStorage` directly, and a copy captured at mount would go on notifying
    // for the rest of the session after the operator switched it off.
    fireNotifications(notifiableChanges(notified.current, next), loadNotifyPrefs());
    notified.current = next;
  }, [state, setup]);

  /**
   * The open goal's whole run history, fetched when its page opens.
   *
   * On its own route rather than off `/api/state`, and here rather than in the
   * page, for the transcript's and the files list's reason: the snapshot carries
   * the fleet's live agents and a bounded tail of ended ones, because the all-time
   * list grew for the life of the deployment and was re-serialised on every
   * signal. One goal at a time is what the surface actually draws.
   *
   * Re-read when the goal's pull requests change and not on the state poll: the
   * page merges this with the snapshot's own agents, so a run dispatched since the
   * fetch is already drawn — what only this can add is history, and history does
   * not move.
   */
  const [goalAgents, setGoalAgents] = useState<GoalAgentsPayload | null>(null);
  const goalRef = place.goal;
  // A string, so the effect below compares by value: `goalPrNumbers` builds a new
  // array on every render and an array in the dependency list would refetch on
  // every poll.
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
      // Drawn as nothing, recorded nowhere, for the setup reading's reason: the
      // page still has the snapshot's own agents, so a failed history read is a
      // shorter list rather than a broken page.
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

  // The setup reading, on open and whenever the file moves. The same event the
  // config page listens on, for the same reason: an edit made in an editor, a save
  // from another cockpit and this cockpit's own write all land on one apply path,
  // so one signal is the whole of keeping this honest.
  const readSetup = useCallback(() => {
    void api
      .getSetup()
      .then(setSetup)
      // Recorded nowhere and drawn as nothing. A reading the harness could not take
      // is not a fault to put in front of an operator — the surface it feeds simply
      // does not appear, which is also what a fully-configured harness looks like.
      .catch(() => setSetup(null));
  }, []);
  useEffect(() => {
    readSetup();
    const onChanged = (): void => readSetup();
    window.addEventListener('lubbdubb:config-changed', onChanged);
    return () => window.removeEventListener('lubbdubb:config-changed', onChanged);
  }, [readSetup]);

  const actions = useMemo<CockpitActions>(() => {
    // An operator's own write is followed by a **full** refresh: a click can move
    // anything (a watch toggle re-decides pickup, a job lands in the queue and on
    // the graph), and unlike a socket signal there is nothing here that knows what
    // it touched. Sections are for the fleet's own chatter, which is what there is
    // a lot of.
    const then = <T>(p: Promise<T>) => p.then(() => refresh(null));
    return {
      refresh: () => refresh(null),
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
      extendStall: (id) => then(api.extendStall(id)),

      answerEscalation: (id, text) => then(api.answerEscalation(id, text)),
      answerQuestions: (id, answers) => then(api.answerQuestions(id, answers)),
      dismissEscalation: (id, note) => then(api.dismissEscalation(id, note)),
      decideProposal: (id, verdict, note, acknowledged) =>
        then(verdict === 'accept' ? api.acceptProposal(id, note, acknowledged) : api.rejectProposal(id, note)),
      backOutProposal: (id, verdict, note) => then(api.backOutProposal(id, verdict, note)),
      // No refetch: nothing on the glass changes until the operator sends the
      // verdict, and the draft is the modal's own state until they do.
      proposalCommentDraft: (id) => api.proposalCommentDraft(id).then((r) => r.draft),
      overruleShortfall: (issueNumber, proposalId, text) =>
        then(api.overruleShortfall(issueNumber, text).then(() => api.rejectProposal(proposalId, text))),
      releaseEnvironmentGate: (issueNumber, released, note) =>
        then(api.releaseEnvironmentGate(issueNumber, released, note)),
      decidePermission: (id, allow, note) => then(api.decidePermission(id, allow, note)),
      decideRecovery: (taskId, verdict) => then(api.decideRecovery(taskId, verdict)),

      replan: (planId) => then(api.replan(planId)),
      ruleWatchProposal: (issueNumber, checkId, accept) => then(api.ruleWatchProposal(issueNumber, checkId, accept)),
      // Refetches like every other write, and hands the dry run's refusals back to
      // the form that caused them: the check is saved either way, and what the
      // environment could not answer about it is the operator's to act on.
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
      // Closing the pack drops the idea with it: an idea is a fold on the page, and
      // a place naming one with no page open is a place that does not exist.
      viewReviewPack: (prNumber) =>
        go(prNumber === null ? { reviewPack: null, reviewIdea: null } : { reviewPack: prNumber }),
      openReviewIdea: (id) => go({ reviewIdea: id }),
      // One `go` for both: which row is unfolded
      // and whether the terminal tail is open are one place, and two calls would
      // push two history entries for a single move.
      setObstacleQuery: (next) => go(next),
      muteObstacle: (id, muted) => then(api.muteObstacle(id, muted)),
      ownObstacle: (id, ownerRef) => then(api.ownObstacle(id, ownerRef)),
      retireObstacle: (id) => then(api.retireObstacle(id)),
      writeDownObstacle: (id) => then(api.writeDownObstacle(id)),
      openConfig: (where) => go({ tab: 'config', goal: null, ...where }),
      // One `go` for both halves: the tab and the window are one place, and two
      // calls would push two history entries for a single change of question.
      openInsights: (where) => go({ tab: 'insights', goal: null, ...where }),
      // The tab comes with it, narrowed to one that could have led here. Nothing
      // that opens a goal moves the nav — the rail is on every tab and a `<Ref>`
      // opens one from anywhere — so left alone the crumb names wherever the nav
      // last was, and a goal opened while reading Insights draws a way out that
      // leads to a page it is not on. → `homeTab`
      selectGoal: (ref) =>
        go((current) => (ref === null ? { goal: null, pr: null } : { goal: ref, pr: null, tab: homeTab(current.tab) })),
      // The goal underneath is left where it was: it is what the crumb names and
      // what leaving the page lands on. The tab travels for `selectGoal`'s reason
      // — a pull request is reached by a `<Ref>` from anywhere at all.
      selectPr: (prNumber) =>
        go((current) => (prNumber === null ? { pr: null } : { pr: prNumber, tab: homeTab(current.tab) })),
      reopenThread: (prNumber, threadId, reopened) => then(api.reopenPrThread(prNumber, threadId, reopened)),
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
      openGoalSection: (section, open) =>
        go((current) => ({
          goalOpen: open
            ? [...current.goalOpen, section].sort((a, b) => a.localeCompare(b))
            : current.goalOpen.filter((name) => name !== section),
        })),
      reorderUpNext: (origins) => then(api.reorderUpNext(origins)),
      setUpNextProfile: (origin, profile) => then(api.setUpNextProfile(origin, profile)),

      upgrade: (action, opts) => then(api.upgrade(action, opts)),
      checkBuild: () => then(api.checkBuild()),
      startLocalRun: (issueNumber, ref) => then(api.startLocalRun(issueNumber, ref)),
      stopLocalRun: () => then(api.stopLocalRun()),
      // Conversational, like `respondAgent`: the server's `dirty` brings the echo.
      messageLocalRun: (text) => api.messageLocalRun(text).then(() => undefined),
      refreshLocalRun: () => then(api.refreshLocalRun()),
      // Not wrapped in `then`: this one is a read, and refetching the whole
      // snapshot to draw a log tail would make opening the panel cost what a pulse
      // costs.
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
      setIssueConclusion: (n, verdict) => then(api.setIssueConclusion(n, verdict)),
      setIssueAppraisal: (n, verdict) => then(api.setIssueAppraisal(n, verdict)),
      addInstruction: (n, text) => then(api.addInstruction(n, text)),
      withdrawInstruction: (n, id) => then(api.withdrawInstruction(n, id)),
      raiseBug: (n, summary, title) => then(api.raiseBug(n, summary, title)),
      // A read, so no refetch — nothing about asking where a filing would land
      // changes the world.
      probeFilingTarget: () => api.probeFilingTarget(),
      // Refetched like every other mutation, but the filed issue is handed back
      // rather than swallowed: the modal's done state links to it. The refresh is
      // awaited because on the deployment that works LubbDubb's own repo the report
      // is in the world the cockpit draws, and it should be there before the modal
      // says it exists; anywhere else it is one cheap read that finds nothing new,
      // which is a smaller cost than a second code path (issue #449).
      raiseIssue: async (title, body, watch) => {
        const filed = await api.raiseIssue(title, body, watch);
        await refresh(null);
        return filed;
      },
      dismissRun: (n, note) => then(api.dismissRun(n, note)),

      applyConfigFix: async (checkId, set) => {
        const config = await api.getConfig();
        // What the file said before, so the undo is a real restore rather than a
        // guess: a key the operator's own file never set is cleared back out, not
        // written with the default they were already getting.
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
    }),
  };
}
