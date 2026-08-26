import { useState } from 'react';
import type { JSX } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions, ConsoleTab } from '../cockpit/actions.js';
import { FleetControl } from '../components/FleetControl.js';
import { ExtLink } from '../components/util.js';
import { RaiseIssueModal } from '../components/RaiseIssueModal.js';
import { untriagedCount } from '../worldBuckets.js';

/**
 * The nav's destinations, in reading order — the order the tabs are drawn in.
 *
 * Four. Insights is the one destination here that is read rather than acted on,
 * which is worth stating because the nav used to be described as "the surfaces
 * work happens on": the rule that actually holds is that the nav is where you
 * *go*, and Config stays out of it because it is set up once, not because it is
 * passive. Insights is somewhere an operator goes several times a day and comes
 * back from.
 *
 * **Knowledge is the fourth, and it was a reading on this bar until it was one.**
 * A count that opened a panel said the fleet's written record was something you
 * glance at, and the panel drew over the rail an operator had just come from — but
 * ruling on a claim is triage, done in a sitting, several times a day, exactly like
 * the tickets tab beside it. What it needed was the situation area and a way back,
 * which is what a tab is. The count did not go: it is the badge on the button.
 *
 * **Work was the second of these and is not here any more.** Every part of it had
 * found a better home — a goal's record onto its goal page, the unrecorded-work
 * call-out onto the tickets tab, and the roots nothing has claimed into the
 * `record` panel on this bar — so what the slot held by the end was a disclosure
 * triangle over an index of pages that are one click away anyway. A nav slot is
 * the most expensive space in the cockpit and it was buying a fold.
 *
 * `pets` is absent when the snapshot ships no vivarium — the feature off, or on
 * and hidden — exactly as the rail's vivarium is: a tab that opens on a page
 * explaining a subsystem this cockpit does not draw is worse than no tab.
 *
 * `features` is absent for the same reason and on the same test: a tracker that
 * reports no hierarchy has no tree to draw, and the tab would open on a page
 * explaining a concept its provider does not have. It is listed here rather than
 * appended, because where it *is* drawn it belongs beside the tickets it rolls up
 * rather than at the end of the nav. → docs/spec/17-cockpit.md#the-features-page
 */
const TABS: readonly ConsoleTab[] = ['overview', 'tickets', 'features', 'knowledge', 'insights'];

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
  tickets: 'Tickets',
  features: 'Features',
  knowledge: 'Knowledge',
  insights: 'Insights',
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
 * either half left standing would land somewhere else. Two of the tabs carry a
 * badge and the rest carry none — see {@link navBadge} for which number and why.
 *
 * Tabs and nothing else: the open goal's crumb is drawn at the head of the
 * situation area instead ({@link ConsoleRoot}). A title is as long as whoever
 * filed it made it, and one in here widens the nav by whatever that is — pushing
 * the readings onto a second line on the act of opening a goal. The bar is the
 * row an operator glances at without looking; it has to be the same shape every
 * time they do.
 */
function Nav({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const goal = view.goalPage;
  const go = (tab: ConsoleTab) => () => {
    actions.selectGoal(null);
    actions.openTab(tab);
  };

  const tabs = [
    // Filtered rather than appended, because where the Features tab is drawn at all
    // it belongs beside the tickets it rolls up. `tabBody` refuses a stale URL to
    // either of the two conditional tabs, for the same reason the nav omits them.
    ...TABS.filter((tab) => tab !== 'features' || view.state.config.tracksHierarchy),
    ...(view.state.pets === null ? [] : ['pets' as const]),
  ];

  return (
    <nav className="cn-nav">
      {tabs.map((tab) => {
        const badge = navBadge(tab, view);
        return (
          <button
            key={tab}
            type="button"
            className={goal === null && view.tab === tab ? 'cn-on' : ''}
            onClick={go(tab)}
            // The sentence the badge used to be. A tab with no number to carry
            // needs none: its own label already says where it goes.
            {...(badge === null ? {} : { title: badge.title })}
          >
            {TAB_LABEL[tab]}
            {badge !== null && <i className="cn-badge">{badge.count}</i>}
          </button>
        );
      })}
    </nav>
  );
}

/**
 * What is waiting behind a nav button, as a number and the sentence that explains
 * it — or null, for a tab with no number that decides whether to look.
 *
 * **A badge, not a phrase.** Tickets read `2 to triage` and Knowledge was a count
 * on the readings strip; both are the same question — is there anything here for
 * me — and the answer is the digit. The words were a sentence in the one row an
 * operator glances at without reading, and they widened the button by however long
 * they happened to be, which is the thing the nav most has to not do. The sentence
 * survives as the button's `title`, where it costs no width and is there for
 * whoever wants it.
 *
 * Hidden at zero, both of them: a badge that always shows is one nobody reads.
 *
 * Each number is the *same* number the surface behind it draws — `untriagedCount`
 * over the watch bucket the tickets tab's Unwatched filter uses, and
 * `factsNeedingYou` over the corroborated claims the Knowledge page opens on — so
 * the badge and the rows behind it cannot differ.
 */
function navBadge(tab: ConsoleTab, view: CockpitView): { count: number; title: string } | null {
  if (tab === 'tickets') {
    const count = untriagedCount(view.state.world.issues, view.state.config.watchLabel);
    return count === 0 ? null : { count, title: `${count} untriaged — nothing has said whether the fleet works these` };
  }
  if (tab === 'knowledge') {
    const count = view.factsNeedingYou;
    return count === 0
      ? null
      : { count, title: `${count} claim${count === 1 ? '' : 's'} two agents agreed on that nobody has ruled on` };
  }
  return null;
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
 * The pulse countdown, and the way to force one — drawn **inside the fleet reading,
 * beside the pause control** rather than as a chip of its own further along the bar.
 *
 * The two are one subject. Pause is the control that stops the next dispatch
 * decision from happening and this is the clock counting down to it, so a reader
 * asking "is anything about to happen" was reading two separated chips that only
 * make sense together. Beside it they are one gauge, read left to right: what the
 * fleet is allowed to do, and when it next gets to.
 *
 * **Beside and not under.** Stacking it was tried and reads worse: the bar is a
 * single row of chips at one height, and a two-row gauge in it is a gauge that has
 * grown a row whatever the pixels say. Inline it costs the bar nothing and stays on
 * the baseline the readings share.
 *
 * **It carries no label.** "Scan" named the mechanism, and the mechanism is not the
 * question — `47s`, `paused` and `held` each say what they are, in the one spot
 * where the countdown is the only thing that could be counting down. The word cost
 * a third of the chip's width to restate the row it was in. The sentence it carried
 * is the `title`, which is where the two states that are *not* a countdown explain
 * themselves.
 *
 * It acts rather than opening a panel, so it carries no chevron: a reading that
 * opens something and a reading that does something are different promises, and the
 * chevron is the only thing that says which.
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
      className={`cn-countdown ${stopped ? 'cn-quiet' : ''}`}
      onClick={() => void actions.pulse()}
      title={title}
      aria-label={title}
    >
      {reading}
    </button>
  );
}

/**
 * The cog, and the console's first icon.
 *
 * Config is the one way-in on this strip that is not a reading of anything: it
 * states no count and no state, and wearing the label-and-value face of the gauges
 * beside it said otherwise — a word in a row of numbers, read as a subject whose
 * number had gone quiet. A cog says "settings" without claiming to be a measurement
 * of anything, and it buys back the width of the word in a strip that wraps at
 * laptop sizes.
 *
 * Drawn inline rather than reached for from an icon set, and in `currentColor`, so
 * it takes the hover and the theme through the cascade like everything else here —
 * a set would be a dependency and a second colour system for one glyph. The label
 * is not lost: it is the `aria-label` and the `title`, which is what a
 * pointer and a screen reader each ask for.
 */
function Cog(): JSX.Element {
  return (
    <svg className="cn-cog" viewBox="0 0 16 16" aria-hidden focusable="false">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M6.6 0.8L9.4 0.8L9.6 2.7L10.6 3.1L12.1 1.9L14.1 3.9L12.9 5.4L13.3 6.4L15.2 6.6L15.2 9.4L13.3 9.6L12.9 10.6L14.1 12.1L12.1 14.1L10.6 12.9L9.6 13.3L9.4 15.2L6.6 15.2L6.4 13.3L5.4 12.9L3.9 14.1L1.9 12.1L3.1 10.6L2.7 9.6L0.8 9.4L0.8 6.6L2.7 6.4L3.1 5.4L1.9 3.9L3.9 1.9L5.4 3.1L6.4 2.7ZM10.5 8.0L10.4 7.4L10.2 6.8L9.8 6.2L9.3 5.8L8.6 5.6L8.0 5.5L7.4 5.6L6.8 5.8L6.2 6.2L5.8 6.8L5.6 7.4L5.5 8.0L5.6 8.6L5.8 9.3L6.2 9.8L6.7 10.2L7.4 10.4L8.0 10.5L8.6 10.4L9.3 10.2L9.8 9.8L10.2 9.3L10.4 8.6Z"
      />
    </svg>
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

/** `issue:284` → 284. The panel and this both address a goal by its number. */
function originIssueNumber(originRef: string): number | null {
  const m = /^issue:(\d+)$/.exec(originRef);
  return m ? Number(m[1]) : null;
}

/**
 * The control-room strip: ident, the nav, the pulse, the fleet cap, and the
 * readings. The nav is here because this is the only row of the shell that never
 * scrolls — everything else lives inside `.cn-sit`, which does. The ident carries
 * the one way off this bar to a tracker — the compose modal where the harness can
 * file, and the external form it falls back to where it cannot ({@link Ident}).
 *
 * Each reading is one subject stated once, in a plain text-and-number face — the
 * console has no icon set of its own to draw from. None reaches `api.js`: every
 * one is a method on `CockpitActions`, and the fleet cap is the shared
 * `FleetControl`, which is already on that seam.
 *
 * **Spend, Yield and Output are no longer here.** They were three readings of one
 * subject — what the fleet cost, what it landed, how much of that survived — and
 * each of the three had grown a version of the other two on its own panel. They
 * are the Insights destination now, which is in the nav: a reading you go to and
 * come back from rather than a number you glance at, and one whose window an
 * operator changes rather than accepts. What is left on this bar is what a glance
 * can actually settle — counts of things waiting on a person, and the state of
 * this build. → docs/spec/17-cockpit.md#insights
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

  const faultCount = state.errors.length;
  // The queue, not the history: a launched blueprint that has been dispatched is
  // an agent in the Fleet, and counting it here would have the reading climb as
  // work starts rather than as it waits.
  const queued = state.jobs.filter((job) => job.status === 'queued').length;
  return (
    <div className="cn-bar">
      <Ident view={view} actions={actions} />
      <div className="cn-sep" />

      <Nav view={view} actions={actions} />

      <div className="cn-sep" />

      {/* One gauge read left to right: what the fleet is allowed to do, and when it
          next gets to decide. The countdown is inside this reading rather than a chip
          of its own because Pause is the control that stops the thing it is counting
          down to — see {@link Scan}. */}
      <div className="cn-read cn-cap">
        <span>Fleet</span>
        <FleetControl live={view.live.length} cap={state.control.cap} paused={state.control.paused} />
        <Scan view={view} actions={actions} />
      </div>

      <div className="cn-reads">
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
        <LocalRun view={view} actions={actions} />
        <Build view={view} actions={actions} />
        {/* The tail of the strip is the two ways-in that are not gauges. Every
            reading above states a count or a state and is glanced at; these two
            state nothing and are aimed at, so they sit together at the end rather
            than interleaved among numbers that change.

            Record is the durable work graph, which was the console's second nav
            destination until everything on it found a better home. It keeps a way
            in because it is the only surface that outlives the world snapshot —
            the answer to "what happened to that job" long after the pulse forgot
            — and it is a way in from the *bar* so it is reachable from a goal
            page too, which a tab never was.

            Config is a destination and not a modal, but it stays off the nav for
            the same reason as Record: the nav is the surfaces work happens on,
            and a button beside them would say configuration is another thing you
            do rather than the thing you set up once. It is a cog and not a word
            for the reason it is last: it is the one control here that measures
            nothing ({@link Cog}). */}
        <Read
          label="Record"
          value={null}
          quiet={false}
          onOpen={() => actions.openPanel('record')}
          title="What the harness did, after the world snapshot forgot it — operator jobs, and the goals it has worked"
        />
        <button
          type="button"
          className="cn-read cn-act cn-icon"
          onClick={() => actions.openConfig({})}
          title="Config — how this harness is configured"
          aria-label="Config"
        >
          <Cog />
        </button>
      </div>
    </div>
  );
}
