import { useState } from 'react';
import type { JSX } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions, ConsoleTab } from '../cockpit/actions.js';
import { FleetControl } from '../components/FleetControl.js';
import { ExtLink } from '../components/util.js';
import { RaiseIssueModal } from '../components/RaiseIssueModal.js';
import { untriagedCount } from '../worldBuckets.js';
import { productionReading } from '../view/production.js';

/**
 * The nav's destinations, in reading order — the order the tabs are drawn in.
 *
 * `pets` is absent when the snapshot ships no vivarium — the feature off, or on
 * and hidden — exactly as the rail's vivarium is: a tab that opens on a page
 * explaining a subsystem this cockpit does not draw is worse than no tab.
 */
const TABS: readonly ConsoleTab[] = ['overview', 'work', 'tickets'];

/**
 * Where a bug in LubbDubb goes when the harness cannot file one itself — fixed, and
 * deliberately not derived from `github.owner`/`github.repo`.
 *
 * Those name the repo this harness *works on*, which is LubbDubb only while it is
 * dogfooding itself. A fault in the cockpit belongs on the cockpit's own tracker
 * whatever repo the fleet happens to be pointed at, so a deployment driving a
 * customer's repo — or a fork — is sent here too. That is the trade: the link is
 * about the tool, not about the work, and nothing on the wire has to carry it.
 *
 * It lands on the *form* rather than the repo or the issue list, because the whole
 * point is the number of clicks between noticing something and having written it
 * down (#404).
 *
 * Since #413 it is the **fallback** rather than the only path: a connected cockpit
 * gets a compose modal that creates the issue directly. Since #449 the modal files
 * *here* too, through the operator's own `gh` login, so the two faces of this
 * control are one destination reached two ways rather than two destinations. The
 * constant survives because the modal's every refusal ends here, and because the one
 * state this control most has to work in — a dropped socket — is the one the harness
 * cannot be posted to.
 */
const NEW_ISSUE_URL = 'https://github.com/AdamAwan/LubbDubb/issues/new';

export const TAB_LABEL: Record<ConsoleTab, string> = {
  overview: 'Overview',
  work: 'Work',
  tickets: 'Tickets',
  pets: 'Pets',
  config: 'Config',
};

/**
 * Where you are, and the other places you can be.
 *
 * It sits in the top bar rather than at the head of the situation area, which
 * scrolls: the primary navigation of a page must not be a thing you scroll away
 * from, and the bar is the one row of the shell that is always on screen.
 *
 * A click clears *both* pieces of state, because a nav click means "go here" and
 * either half left standing would land somewhere else. Tickets carries its
 * triage count — the one number that says whether it is worth opening; the other
 * two carry none, since neither has a number that decides whether to look.
 *
 * Tickets carries the triage tally the backlog used to, since it is now the surface
 * triage happens on. It counts what the tab's Unwatched filter draws, so the number
 * and the rows behind it cannot differ, and it is hidden at zero — a badge that
 * always shows is one nobody reads.
 *
 * Three tabs and nothing else: the open goal's crumb is drawn at the head of the
 * situation area instead ({@link ConsoleRoot}). A title is as long as whoever
 * filed it made it, and one in here widens the nav by whatever that is — pushing
 * the readings onto a second line on the act of opening a goal. The bar is the
 * row an operator glances at without looking; it has to be the same shape every
 * time they do.
 */
function Nav({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const goal = view.goalPage;
  const untriaged = untriagedCount(view.state.world.issues, view.state.config.watchLabel);
  const go = (tab: ConsoleTab) => () => {
    actions.selectGoal(null);
    actions.openTab(tab);
  };

  // Appended rather than listed, so the nav is the same three tabs on a deployment
  // drawing no vivarium and the fourth cannot be reached by a stale URL either
  // — `tabBody` refuses it for the same reason.
  const tabs = view.state.pets === null ? TABS : [...TABS, 'pets' as const];

  return (
    <nav className="cn-nav">
      {tabs.map((tab) => (
        <button key={tab} type="button" className={goal === null && view.tab === tab ? 'cn-on' : ''} onClick={go(tab)}>
          {TAB_LABEL[tab]}
          {/* The space is the gap: `.cn-n` carries no margin of its own. */}
          {tab === 'tickets' && untriaged > 0 && (
            <>
              {' '}
              <i className="cn-n">{untriaged} to triage</i>
            </>
          )}
        </button>
      ))}
    </nav>
  );
}

/**
 * The wordmark, the link lamp, and the one thing on this bar that is about
 * LubbDubb rather than about the work.
 *
 * A component rather than markup in `TopBar` because **both** arms draw it — the
 * live bar and the dropped-socket one. A socket that just went down is a moment an
 * operator has something to report, and a way to report it that is only there when
 * the harness is healthy is missing exactly then. The lamp is the only thing that
 * differs between the two: green from the stylesheet, red inline when the link is
 * gone.
 *
 * That is also why the control has two faces rather than one. Where the harness can
 * file, it is a button opening {@link RaiseIssueModal} and the issue is created in
 * the tracker directly; where it cannot — no tracker configured, or no socket — it
 * is the external link it has always been. The fallback is not a nicety: this whole
 * component exists because the offline bar draws it, and a compose modal is the one
 * shape of this feature that offline cannot serve.
 *
 * The link sits here and not among the readings for the reason the readings are a
 * group at all — every one of them is a gauge on the fleet or on this build, read
 * left to right as one sentence about what is happening. "Raise an issue" answers
 * nothing about the fleet, and a tenth chip in a group that already wraps at laptop
 * widths would cost a line to say so.
 */
function Ident({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const [composing, setComposing] = useState(false);

  // One cut, made before a round trip is spent, and it is deliberately **not**
  // `config.canFileTickets` any more (issue #449). That flag says whether the
  // tracker *the fleet is pointed at* accepts new items, which since #449 has
  // nothing to do with this control: the report goes to LubbDubb's own repository
  // through the operator's `gh` login, so an Azure deployment and a read-only
  // tracker can both compose one. What is left is the half that always mattered
  // most — a modal that posts to this harness's own server has nothing to post to
  // with the socket down, which is exactly when an operator has something to
  // report. The live half of the gate is the probe, and it runs inside the modal.
  const canCompose = view.connected;

  return (
    <div className="cn-ident">
      <i className="cn-dot" style={view.connected ? undefined : { background: 'var(--cn-red)' }} />
      LubbDubb
      {view.demo && <span style={{ color: 'var(--cn-fg-faint)', fontWeight: 400 }}>· demo</span>}
      {/* `.cn-issue` is the console's own hook for sizing the control out of the
          wordmark — see `console.css`; it styles nothing `ExtLink` owns. */}
      <span className="cn-issue">
        {canCompose ? (
          <button
            type="button"
            className="cn-issue-btn"
            title="Write an issue about LubbDubb and file it on its own tracker, without leaving the cockpit"
            onClick={() => setComposing(true)}
          >
            Raise an issue
          </button>
        ) : (
          <ExtLink href={NEW_ISSUE_URL} title="Raise an issue on the LubbDubb repo">
            Raise an issue
          </ExtLink>
        )}
      </span>
      {/* Local state and not `Place`: a half-typed report is not somewhere you can
          come back to, so it is not somewhere the URL should be able to send you.
          `GoalPage`'s compose modals are held the same way. */}
      {composing && (
        <RaiseIssueModal
          probe={actions.probeFilingTarget}
          fallbackUrl={NEW_ISSUE_URL}
          onSubmit={actions.raiseIssue}
          onClose={() => setComposing(false)}
        />
      )}
    </div>
  );
}

/**
 * One reading: a label and a value, optionally a button that opens something.
 *
 * A zero count mutes the reading — `.cn-quiet` dims the value — and never
 * removes it. The gauge staying put is what lets an operator glance at the same
 * spot every time rather than hunting for a control that reflows when the count
 * it reads happens to hit zero.
 */
function Read({
  label,
  value,
  quiet,
  onOpen,
  title,
}: {
  label: string;
  value: string | null;
  quiet: boolean;
  onOpen?: () => void;
  title: string;
}): JSX.Element {
  const cls = `cn-read ${onOpen ? 'cn-act' : ''} ${quiet ? 'cn-quiet' : ''}`;
  if (!onOpen) {
    return (
      <div className={cls} title={title}>
        <span>{label}</span>
        {value !== null && <b>{value}</b>}
      </div>
    );
  }
  return (
    <button type="button" className={cls} onClick={onOpen} title={title} aria-label={title}>
      <span>{label}</span>
      {value !== null && <b>{value}</b>}
      <i className="cn-chev">›</i>
    </button>
  );
}

/**
 * The pulse countdown, and the way to force one. Wears the same raised chrome
 * as the other readings but acts rather than opening a panel, so it carries no
 * chevron: a reading that opens something and a reading that does something are
 * different promises, and the chevron is the only thing that says which.
 */
function Scan({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const stopped = view.pulseHeld || view.state.control.paused;
  const reading = view.pulseHeld ? 'held' : view.state.control.paused ? 'paused' : `${view.nextPulseIn}s`;
  const title = view.pulseHeld
    ? 'Scan held: agents from the previous run need a recovery decision — press to try one anyway'
    : view.state.control.paused
      ? 'Scan paused — press to run one now'
      : `Next scan in about ${view.nextPulseIn} seconds — press to run one now`;
  return (
    <button
      type="button"
      className={`cn-read cn-act cn-scan ${stopped ? 'cn-quiet' : ''}`}
      onClick={() => void actions.pulse()}
      title={title}
      aria-label={title}
    >
      <span>Scan</span>
      <b>{reading}</b>
    </button>
  );
}

/**
 * Where the harness's own build stands — the one reading on this bar that is about
 * the process rather than the work.
 *
 * It wears the ordinary reading chrome and **stays in place at every state**,
 * including the one it spends almost all its life in: `current`, muted, saying
 * nothing. That is the whole design. A notification that appears only when there is
 * news is one an operator has to notice; a gauge in a fixed spot is one they can
 * glance at, and the mute is what keeps it from competing with the readings beside
 * it for the 99% of the time nothing has changed.
 *
 * It is deliberately not the recovery banner's treatment. That is a stop sign, and
 * it is loud because the harness is running *no cycles* while it is up. An update
 * being available stops nothing, so borrowing the banner would say something untrue
 * — and after the second time, be scrolled past.
 */
function Build({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const build = view.state.build;
  const quiet = build.state === 'current' || build.state === 'unknown';
  const title =
    build.state === 'behind'
      ? `LubbDubb is ${build.standing.behind} commit(s) behind upstream — open to see what changed`
      : build.state === 'draining'
        ? 'Upgrade pending: dispatch is paused while the fleet finishes — open to apply or cancel'
        : build.state === 'ready'
          ? 'Ready to upgrade — open to apply'
          : build.state === 'unknown'
            ? `This build could not be checked: ${build.standing.unavailable ?? 'no reason given'}`
            : 'This build is up to date with upstream — open for details';
  return (
    <button
      type="button"
      className={`cn-read cn-act cn-build ${quiet ? 'cn-quiet' : ''} ${build.state === 'behind' || build.state === 'ready' ? 'cn-build-due' : ''}`}
      onClick={() => actions.openPanel('build')}
      title={title}
      aria-label={title}
    >
      <span>Build</span>
      <b>{build.label}</b>
      <i className="cn-chev">›</i>
    </button>
  );
}

/**
 * Whether anything is running on this machine, and which goal's code it is.
 *
 * A reading rather than a nav tab: it is a state of the operator's own machine, not
 * a surface work happens on, and `TABS` is deliberately the three that are. Quiet
 * when nothing is up — which is most of the time, and is the reading rather than
 * the absence of one.
 *
 * The **goal number** is the value, because that is the question. "Running" alone
 * would leave an operator opening the panel to find out whether it is the goal they
 * are looking at, which is the only thing they wanted to know.
 */
function LocalRun({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const run = view.state.localRun;
  const live = run !== null && run.live;
  const number = run === null ? null : originIssueNumber(run.originRef);
  const title = live
    ? `Goal #${String(number)} is running locally${run.url === null ? '' : ` on ${run.url}`} — open to stop it or swap goals`
    : run === null
      ? 'Nothing has been run locally — open to start a goal on this machine'
      : `Nothing is running locally; the last attempt ${run.status === 'failed' ? 'did not start' : 'was stopped'} — open for the reason`;
  return (
    <button
      type="button"
      className={`cn-read cn-act ${live ? '' : 'cn-quiet'}`}
      onClick={() => actions.openPanel('localRun')}
      title={title}
      aria-label={title}
    >
      <span>Local</span>
      <b>{live && number !== null ? `#${String(number)}` : 'off'}</b>
      <i className="cn-chev">›</i>
    </button>
  );
}

/**
 * How many of the harness's own checks are outstanding — and **nothing at all**
 * once none are.
 *
 * A reading that is always green is one nobody reads, so this one earns its place
 * in the bar by not being there most of the time. It is also the reason the checks
 * outlive the first three minutes they were written for: this is how an operator
 * finds out on a Tuesday that a token expired, or that a repository nobody has
 * tagged anything in will keep the fleet idle and report nothing wrong.
 */
function Setup({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element | null {
  const setup = view.setup;
  if (setup === null || setup.outstanding === 0) return null;
  const worst = setup.checks.some((check) => check.verdict === 'bad');
  const title = setup.pointed
    ? `${setup.outstanding} thing(s) about this harness's own configuration need a look — open Setup`
    : 'This harness is running the shipped mock and has not been pointed at any work — open Setup';
  return (
    <button
      type="button"
      className={`cn-read cn-act ${worst ? 'cn-setup-bad' : 'cn-setup-warn'}`}
      onClick={() => actions.openPanel('setup')}
      title={title}
      aria-label={title}
    >
      <span>Setup</span>
      <b>{setup.outstanding}</b>
      <i className="cn-chev">›</i>
    </button>
  );
}

/** `issue:284` → 284. The panel and this both address a goal by its number. */
function originIssueNumber(originRef: string): number | null {
  const m = /^issue:(\d+)$/.exec(originRef);
  return m ? Number(m[1]) : null;
}

/**
 * The control-room strip: ident, the nav, the pulse, the fleet cap, and seven
 * readings. The nav is here because this is the only row of the shell that never
 * scrolls — everything else lives inside `.cn-sit`, which does. The ident carries
 * the one way off this bar to a tracker — the compose modal where the harness can
 * file, and the external form it falls back to where it cannot ({@link Ident}).
 *
 * Each reading is one subject stated once, mirroring `StatusBar`'s rule but
 * with the mockup's plain text-and-number face — the console has no icon set of
 * its own to draw from. Spend,
 * Yield, Output, Findings and Faults open a panel or a full-surface view;
 * Settings does too. None reaches `api.js` — every one of these is a method on
 * `CockpitActions`, and the fleet cap is the shared `FleetControl`, which is
 * already on that seam.
 *
 * Output reads `productionReading` from `../view/production.js` — the same
 * derivation the production graph itself is built on — rather than a
 * differently-shaped count of the same events: a gauge and the panel it opens
 * must agree from the first paint, and only sharing the one function keeps
 * that true by construction. It sits in `view/` — a pure, React-free derivation,
 * same as `viewModel.ts` and `goalPage.ts` — so that a gauge and the panel behind
 * it can share it without either reaching into the other's presentation.
 */
export function TopBar({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const { state } = view;

  if (!view.connected) {
    return (
      <div className="cn-bar">
        <Ident view={view} actions={actions} />
        <div className="cn-read">
          <span>Link</span>
          <b>offline</b>
        </div>
      </div>
    );
  }

  const yieldPct =
    state.runOutcomes.completionRate === null ? null : Math.round(state.runOutcomes.completionRate * 100);
  const spendUsd = state.usage.windows.fiveHourCostUsd;
  const faultCount = state.errors.length;
  // The queue, not the history: a launched blueprint that has been dispatched is
  // an agent in the Fleet, and counting it here would have the reading climb as
  // work starts rather than as it waits.
  const queued = state.jobs.filter((job) => job.status === 'queued').length;
  // Same derivation the production graph itself is built on (`actions.openPanel('output')`
  // opens it) — a gauge and the panel it opens must start out agreeing, so this is
  // the windowed rate, not a different-shaped count of the same events.
  const production = productionReading({
    decisions: state.decisions,
    worldEvents: state.worldEvents,
    fiveHourCostUsd: state.usage.windows.fiveHourCostUsd,
    now: view.now,
  });
  const mergesPerHour = production.series.find((s) => s.key === 'merges')?.perHour ?? 0;

  return (
    <div className="cn-bar">
      <Ident view={view} actions={actions} />
      <div className="cn-sep" />

      <Nav view={view} actions={actions} />

      <div className="cn-sep" />

      <Scan view={view} actions={actions} />

      <div className="cn-read cn-cap">
        <span>Fleet</span>
        <FleetControl live={view.live.length} cap={state.control.cap} paused={state.control.paused} />
      </div>

      <div className="cn-reads">
        <Read
          label="Spend"
          value={`$${spendUsd.toFixed(2)}`}
          quiet={spendUsd === 0}
          onOpen={() => actions.openSpend(true)}
          title="What the fleet has spent — open the breakdown"
        />
        <Read
          label="Yield"
          value={yieldPct === null ? null : `${yieldPct}%`}
          quiet={yieldPct === null || yieldPct === 100}
          onOpen={() => actions.openReliability(true)}
          title="How much of the settled work finished — open the breakdown"
        />
        <Read
          label="Output"
          value={`${mergesPerHour.toFixed(1)}/h`}
          quiet={mergesPerHour === 0}
          onOpen={() => actions.openPanel('output')}
          title={`${mergesPerHour.toFixed(1)} merges an hour over the last ${Math.round(production.windowMs / 3_600_000)}h — open the output panel`}
        />
        <Read
          label="Findings"
          value={`${view.openFindingCount}`}
          quiet={view.openFindingCount === 0}
          onOpen={() => actions.openPanel('findings')}
          title="Findings nobody has ruled on — open the findings panel"
        />
        <Read
          label="Lessons"
          value={`${view.proposedLessonCount}`}
          quiet={view.proposedLessonCount === 0}
          onOpen={() => actions.openPanel('lessons')}
          title="Lessons nobody has ruled on — open the lessons panel"
        />
        <Read
          label="Faults"
          value={`${faultCount}`}
          quiet={faultCount === 0}
          onOpen={() => actions.openPanel('faults')}
          title="Recorded faults — open the fault log"
        />
        <Read
          label="Launch"
          value={`${queued}`}
          quiet={queued === 0}
          onOpen={() => actions.openPanel('launch')}
          title="Blueprints waiting for a free slot — open the launch desk"
        />
        <Setup view={view} actions={actions} />
        <LocalRun view={view} actions={actions} />
        <Build view={view} actions={actions} />
        {/* Config is a destination now, not a modal — but it stays here rather
            than joining the nav: the nav is the three surfaces work happens on,
            and a fourth button beside them would say configuration is a fourth
            thing you do rather than the thing you set up once. */}
        <Read
          label="Config"
          value={null}
          quiet={false}
          onOpen={() => actions.openConfig({})}
          title="How this harness is configured"
        />
      </div>
    </div>
  );
}
