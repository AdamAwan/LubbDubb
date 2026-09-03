import { useState } from 'react';
import type { JSX } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { EnvironmentHealthReading } from '../types.js';
import type { CockpitActions, ConsoleTab } from '../cockpit/actions.js';
import { FleetControl } from '../components/FleetControl.js';
import { ExtLink, fmtUsd, relTime } from '../components/util.js';
import { RaiseIssueModal } from '../components/RaiseIssueModal.js';
import { DesktopLink } from '../components/DesktopLink.js';
import { questionPrompt } from '../cockpit/desktopLink.js';
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
 * **Obstacles is the fourth, and it holds the slot Knowledge held.** The board
 * shipped reachable by URL only, and the operator lifted that; it takes Knowledge's
 * slot rather than a fifth because Knowledge is the surface it replaces, and two
 * tabs answering one question is how an operator ends up ruling on the same thing
 * twice. It carries **no badge**, and that is the whole of it rather than an
 * omission: a badge counts what is waiting on a decision, and nothing on the board
 * is — every state there has an exit that is not you. Knowledge's badge was
 * `factsNeedingYou`, over a queue only a person emptied, which is exactly the shape
 * the board is arranged not to have.
 * → `docs/spec/27-obstacles.md#in-the-cockpit`
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
 */
const TABS: readonly ConsoleTab[] = ['overview', 'tickets', 'obstacles', 'insights'];

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
  obstacles: 'Obstacles',
  features: 'Features',
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

  // Appended rather than listed, so the nav is the same four tabs on a deployment
  // drawing no vivarium and the fifth cannot be reached by a stale URL either
  // — `tabBody` refuses it for the same reason.
  //
  // Features rides the same rule and is **inserted** rather than appended, because
  // it belongs beside Tickets: the two are the same backlog read at two altitudes,
  // and a reader moving between them should not cross the board to do it. It is
  // absent unless the deployment has a board at all — the operator's flag *and* a
  // provider with a hierarchy, folded server-side by `featureBoardOn` so the tab
  // and the route can never disagree. A tab that opens on a page explaining a
  // hierarchy this tracker does not have is worse than no tab.
  const withFeatures: readonly ConsoleTab[] = view.state.config.featureBoard
    ? ['overview', 'tickets', 'features', 'obstacles', 'insights']
    : TABS;
  const tabs = view.state.pets === null ? withFeatures : [...withFeatures, 'pets' as const];

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
 * **A badge, not a phrase.** Tickets reads `2 to triage`: the question is *is
 * there anything here for me*, and the answer is the digit. The words were a
 * sentence in the one row an operator glances at without reading, and they widened
 * the button by however long they happened to be, which is the thing the nav most
 * has to not do. The sentence survives as the button's `title`, where it costs no
 * width and is there for whoever wants it.
 *
 * Hidden at zero: a badge that always shows is one nobody reads.
 *
 * The number is the *same* number the surface behind it draws — `untriagedCount`
 * over the watch bucket the tickets tab's Unwatched filter uses — so the badge and
 * the rows behind it cannot differ.
 *
 * **Obstacles has none**, and never gains one: a badge counts what is waiting on a
 * decision, the board has nothing that is, and a count there would be the first
 * step back toward the queue only a person emptied that killed the store it
 * replaced. → `docs/spec/27-obstacles.md#in-the-cockpit`
 */
function navBadge(tab: ConsoleTab, view: CockpitView): { count: number; title: string } | null {
  if (tab === 'tickets') {
    const count = untriagedCount(view.state.world.issues, view.state.config.watchLabel);
    return count === 0 ? null : { count, title: `${count} untriaged — nothing has said whether the fleet works these` };
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
 * left to right as one sentence about what is happening. "Issue!" answers
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
          wordmark, and `.cn-ident-act` is what makes it read as a control rather
          than as more wordmark — see `console.css`. Both are on the *wrapper*: `ExtLink`
          takes no class, and a rule on `.ext-ref` is the one thing this stylesheet
          is tested not to do, so the chrome goes round the link rather than on it.

          One word and a mark. `Raise an issue` and `Got a question?` were two
          sentences in the same weight and the same ink, a hand's width apart, and
          read as one run of small print; the punctuation is what tells them apart at
          a glance, since it is the difference between them — one files, one asks. */}
      <span className="cn-issue cn-ident-act">
        {canCompose ? (
          <button
            type="button"
            className="cn-issue-btn"
            title="Write an issue about LubbDubb and file it on its own tracker, without leaving the cockpit"
            onClick={() => setComposing(true)}
          >
            Issue!
          </button>
        ) : (
          <ExtLink href={NEW_ISSUE_URL} title="Raise an issue on the LubbDubb repo">
            Issue!
          </ExtLink>
        )}
      </span>
      {/* Local state and not `Place`: a half-typed report is not somewhere you can
          come back to, so it is not somewhere the URL should be able to send you.
          `GoalPage`'s compose modals are held the same way. */}
      {/* The bar's second way out, and the one that answers rather than files.
          Most of what arrives as an issue about the fleet is not a fault in it —
          it is "why has this not moved", which the harness's own record answers in
          a sentence and which nobody asks because asking meant opening a client,
          finding the checkout and remembering the skill. This is that, as a
          control: a `DesktopLink` onto the repository the fleet works, with
          `/lubbdubb ` in the composer and the question left to the operator.

          Beside *Issue!* deliberately. The two are the same moment —
          something looks wrong — and the cheaper reading of it is offered first;
          drawn anywhere else, the expensive one stays the only one on the bar.

          Unconditional, like every other deep link: it reaches only the machine
          the browser is on, and `DesktopLink` puts the command in the title for
          exactly the operator it cannot reach. */}
      <span className="cn-issue cn-ident-act cn-ident-ask">
        <DesktopLink
          className="cn-ask-btn"
          folder={view.state.config.desktopFolder}
          prompt={questionPrompt()}
          ready="waiting for your question"
          explain="which answers it from the harness’s own record of the work, and says so when the record is silent."
        >
          Question?
        </DesktopLink>
      </span>
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
 * What the Environments chip draws: the worst reading, said in one count and one
 * word, and the sentence behind it.
 *
 * The fold is exported for the tests, like {@link usageReading}'s: this is the
 * whole of the chip's judgement — which reading is worst, and what to call it — and a rank
 * that drifts is a bar reporting an outage as an amber.
 */
interface EnvironmentsReading {
  /** `1 red`, `2 not well`, `1 no answer`, `4 well`. */
  value: string;
  /** True while the worst environment is well — the state it spends nearly all its life in. */
  quiet: boolean;
  /** Which tint the chip takes, or none. */
  tone: 'ill' | 'watch' | null;
  title: string;
}

/**
 * Worst first, and an **untiered `unhealthy` ranks with a red**: an unstated
 * severity is not a reason to rank an outage below one that stated it, which is
 * the card's rule for the tone read as an ordering.
 *
 * `unknown` sits below both because it is not a claim that anything is wrong —
 * and above `healthy` because it is not a claim that anything is right.
 */
function healthRank(reading: EnvironmentHealthReading): number {
  if (reading.state === 'unhealthy') return reading.tier === 'orange' ? 1 : 0;
  if (reading.state === 'unknown') return 2;
  return 3;
}

/** What one reading is called on the chip — the tier where it named one, else the state's word. */
function healthWord(reading: EnvironmentHealthReading): string {
  if (reading.tier !== null) return reading.tier;
  return reading.state === 'healthy' ? 'well' : reading.state === 'unknown' ? 'no answer' : 'not well';
}

/**
 * Fold the readings to the one thing a glance can settle: is anything out there
 * broken, and how many.
 *
 * **The value is a count and a word, never a bare number.** `Env 1` would leave
 * an operator opening the card to find out which of three quite different things
 * it meant, which is the only thing they wanted to know.
 *
 * The count is of environments sharing the *worst* word rather than of every
 * environment that is not well, so `2 red` and `1 orange` never add up into a
 * single figure that describes neither.
 *
 * `unknown` takes the amber the orange takes and is told apart by its word, which
 * is the card's pairing exactly: a check that could not answer is a thing to look
 * at, and drawing it green or red would be claiming an answer it did not give.
 */
export function environmentsReading(readings: readonly EnvironmentHealthReading[], now: number): EnvironmentsReading {
  const worst = [...readings].sort((a, b) => healthRank(a) - healthRank(b))[0]!;
  const word = healthWord(worst);
  const count = readings.filter((r) => healthWord(r) === word).length;
  const rank = healthRank(worst);
  const read = `read ${relTime(worst.observedAt, now)}`;
  const title =
    rank === 3
      ? `Every environment answered well — ${read}. Open the overview for the readings.`
      : `${worst.environment} ${worst.state === 'unknown' ? 'did not answer' : 'is not well'} — ${word} since ${relTime(worst.changedAt, now).replace(' ago', '')}, ${read}. Open the overview for what the check said.`;
  return {
    value: `${count} ${word}`,
    quiet: rank === 3,
    tone: rank === 2 ? 'watch' : rank === 3 ? null : 'ill',
    title,
  };
}

/**
 * Whether anything out there is broken — the bar's reading of the Environments
 * card, and the only thing on this strip that is about the world the work ships
 * into rather than about the fleet or this build.
 *
 * The Build gauge's argument, applied to a subject that needed it more: a reading
 * in a fixed spot is one an operator can glance at, where a surface that appears
 * only when there is news is one they have to notice. Health was drawn on one card
 * on one tab, so an outage in testUk reached exactly the people already looking at
 * it.
 *
 * **Absent, not zeroed, where no environment declares a check** — the card's own
 * exception, for its reason: a chip reading `0 well` on a deployment that
 * configured none announces a feature as broken.
 *
 * It opens the overview rather than a panel of its own. The reasons, the ages and
 * the per-environment rows are the card's, and a second surface drawing them is a
 * second place for them to disagree.
 */
function Environments({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element | null {
  const readings = view.state.environmentHealth ?? [];
  if (readings.length === 0) return null;
  const reading = environmentsReading(readings, view.now);
  return (
    <button
      type="button"
      className={`cn-read cn-act ${reading.quiet ? 'cn-quiet' : ''} ${reading.tone === null ? '' : `cn-env-${reading.tone}`}`}
      onClick={() => {
        actions.selectGoal(null);
        actions.openTab('overview');
      }}
      title={reading.title}
      aria-label={reading.title}
    >
      <span>Env</span>
      <b>{reading.value}</b>
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
 * a surface work happens on, and `TABS` is deliberately the ones that are. Quiet
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
  // Behind the tip of its own branch: the environment is showing old code. Said on
  // the reading itself, because the panel is where you find out and this is where
  // you would not think to look.
  const stale = live && run.freshness !== null && run.freshness.behindTip !== null && run.freshness.behindTip > 0;
  const title = live
    ? `Goal #${String(number)} is running locally${run.url === null ? '' : ` on ${run.url}`}${stale ? ' · behind the branch tip' : ''} — open to stop it or swap goals`
    : run === null
      ? 'Nothing has been run locally — open to start a goal on this machine'
      : `Nothing is running locally; the last attempt ${run.status === 'failed' ? 'did not start' : 'was stopped'} — open for the reason`;
  return (
    <button
      type="button"
      className={`cn-read cn-act ${live ? '' : 'cn-quiet'} ${stale ? 'cn-stale' : ''}`}
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
 * How stale a limits reading has to be before the chip says so beside the figures.
 *
 * The reading is turn-bound — it arrives only when an agent takes a turn — so an
 * idle fleet's ages while the account's real windows keep moving underneath it:
 * an operator's own Claude Code spends from the same allowance. Ten minutes is
 * about a turn. Under it the numbers are what the account looks like now; over it
 * they are history, and the chip has to stop implying otherwise.
 * → docs/spec/18-observability.md
 */
const USAGE_STALE_MS = 10 * 60 * 1000;

/**
 * One window's slot on the chip. Both are always drawn and always in the same
 * order — see {@link usageReading}.
 */
interface UsageSlot {
  /** `5h` / `7d`, drawn above-left of the figure it labels. */
  label: string;
  /** The percentage, or `—` for a window the wire reported nothing for. */
  value: string;
  /** Whether this is the window nearer its limit, and so the one lettered at full strength. */
  binds: boolean;
}

/** What the Usage chip draws: the figures, the tone they carry, and the sentence behind them. */
interface UsageReading {
  /** The two windows, five-hour then weekly. Empty when nothing reported either. */
  slots: UsageSlot[];
  /** The five-hour spend, drawn instead of the slots when no window was reported at all. */
  cost: string | null;
  /** `plain` is the resting state, `quiet` mutes; the other two tint the chip. */
  tone: 'quiet' | 'plain' | 'warn' | 'spent';
  title: string;
  /** The reading's age, drawn beside the figures once it is stale enough to matter. */
  age: string | null;
}

/** How far off a window's reset is, at the scale it is actually read: `42m`, `3h`, `2d`. */
function resetIn(iso: string, now: number): string {
  const mins = Math.max(0, Math.round((new Date(iso).getTime() - now) / 60_000));
  if (mins < 60) return `${mins}m`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / (24 * 60))}d`;
}

/**
 * The account's allowance as one reading — **both** subscriber windows where an
 * agent has reported them, and the rolling cost where none has.
 *
 * **Both windows, because either one parks the fleet.** A chip carrying only the
 * five-hour reads fine on the morning a weekly allowance runs out, which is the
 * failure a gauge exists to prevent.
 *
 * **Five-hour left, weekly right, always.** Ordering them by which is worse would
 * put the number an operator glances at without reading in a slot that moves, so
 * the *position* is fixed and the **weight** carries which one bites: the window
 * nearer its limit is `binds`, lettered at full strength and the one the tone reads,
 * while the other sits dim. Without that mark the chip is two numbers and a shrug —
 * the comparison is precisely the work it exists to have already done.
 *
 * **A window nothing reported is an em dash, never `0%`.** Each is independently
 * nullable on the wire, and a zero would claim a fresh allowance nobody measured.
 * Where *neither* was reported — API-key auth, an older CLI, a fleet that has not
 * taken a turn — there is no pair to draw, so the five-hour cost stands in: it is
 * self-computed and always there, and a chip that went blank would leave a hole in
 * the bar on the deployments least able to spare one.
 *
 * **A stale reading is drawn stale, never hidden and never freshened.** No probe can
 * ask the account directly, so the honest chip is the figures with their age on them.
 * → docs/spec/10-agent-runtimes.md#the-account-usage-windows
 */
export function usageReading(usage: CockpitView['state']['usage'], now: number): UsageReading {
  const limits = usage.rateLimits;
  const five = limits?.fiveHour ?? null;
  const seven = limits?.sevenDay ?? null;

  if (limits === null || (five === null && seven === null)) {
    const { fiveHourCostUsd, sevenDayCostUsd } = usage.windows;
    return {
      slots: [],
      cost: fmtUsd(fiveHourCostUsd),
      // Nothing spent is a reading and not the absence of one — the mute rule the
      // fault and launch counts follow.
      tone: fiveHourCostUsd === 0 && sevenDayCostUsd === 0 ? 'quiet' : 'plain',
      title:
        'No subscriber usage windows have been reported — API-key auth, or no agent has taken a turn yet. ' +
        `Spent ${fmtUsd(fiveHourCostUsd)} in the last five hours, ${fmtUsd(sevenDayCostUsd)} over seven days.`,
      age: null,
    };
  }

  // A window that reported nothing cannot be the one nearer its limit, whatever the
  // other says — so the comparison is only ever between windows that exist.
  const weekBinds = five === null || (seven !== null && seven.usedPercentage > five.usedPercentage);
  const binding = weekBinds ? seven : five;
  const pct = (w: typeof five) => (w === null ? '—' : `${Math.round(w.usedPercentage)}%`);
  const bindingPct = binding === null ? 0 : Math.round(binding.usedPercentage);
  const other = weekBinds ? five : seven;

  return {
    slots: [
      { label: '5h', value: pct(five), binds: !weekBinds },
      { label: '7d', value: pct(seven), binds: weekBinds },
    ],
    cost: null,
    tone: bindingPct >= 90 ? 'spent' : bindingPct >= 75 ? 'warn' : bindingPct >= 25 ? 'plain' : 'quiet',
    title:
      `Claude account: ${weekBinds ? 'weekly' : 'five-hour'} window ${bindingPct}% used` +
      `${binding?.resetsAt == null ? '' : `, resets in ${resetIn(binding.resetsAt, now)}`}` +
      `${other === null ? '' : ` · ${weekBinds ? 'five-hour' : 'weekly'} ${Math.round(other.usedPercentage)}%`}. ` +
      `Read ${relTime(limits.capturedAt, now)} off an agent's turn — the windows keep moving while the fleet is idle.`,
    age: now - new Date(limits.capturedAt).getTime() >= USAGE_STALE_MS ? relTime(limits.capturedAt, now) : null,
  };
}

/**
 * What the account has left, in the one row an operator glances at.
 *
 * It leads the readings because it is the only gauge here that can stop everything:
 * an allowance that runs out parks the whole fleet, and learning that from a parked
 * agent's row is learning it afterwards. Beside the fleet cap it reads as the second
 * half of one sentence — what the fleet is allowed to run, and what the account has
 * left to run it on.
 *
 * **A way-in now, and the only reading here whose destination is a whole page.**
 * It was a plain reading for as long as the honest answer to "spent on what?" was
 * nothing — the chip could give a percentage and the page had no span that matched
 * it. The `session` window is that span: the same five hours the account is
 * metering, anchored to the reset this chip already reads
 * ([18](../../../docs/spec/18-observability.md#the-window)). A gauge that can stop
 * the whole fleet and cannot be asked what spent it is the state this replaces, so
 * the chevron is owed rather than promised.
 *
 * It carries the same title either way: the click is an *addition* to the reading,
 * and an operator who has always glanced at the numbers and moved on loses nothing.
 *
 * The slots are `<i>` and their labels `<em>`, deliberately: `.cn-read span` is a
 * *descendant* rule and would letter a wrapping `<span>` as a second chip label —
 * uppercase, faint and 11px — which is the reading's own name, not a window's.
 */
function Usage({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const reading = usageReading(view.state.usage, view.now);
  const tone = reading.tone === 'quiet' ? 'cn-quiet' : reading.tone === 'plain' ? '' : `cn-usage-${reading.tone}`;
  const title = `${reading.title} Open for what spent it.`;
  return (
    <button
      type="button"
      className={`cn-read cn-act ${tone}`}
      // Economics, because "where did it go" is a question about money and that is
      // the tab that splits it. The window is the point of the trip: landing on the
      // page's own default would answer for a week, which is a different question
      // with a bigger number — and the number is what an operator would remember.
      onClick={() => actions.openInsights({ insightsView: 'economics', insightsWindow: 'session' })}
      title={title}
      aria-label={title}
    >
      <span>Usage</span>
      {reading.cost === null ? (
        <i className="cn-usage-pair">
          {reading.slots.map((slot) => (
            <i key={slot.label} className={`cn-usage-win ${slot.binds ? 'cn-binds' : ''}`}>
              <em>{slot.label}</em>
              <b>{slot.value}</b>
            </i>
          ))}
        </i>
      ) : (
        <b>{reading.cost}</b>
      )}
      {/* The age only appears once the reading has gone stale, so the chip is the same
          shape on every ordinary glance and grows the caveat exactly when the figures
          have stopped being current. */}
      {reading.age !== null && <i className="cn-usage-age">{reading.age}</i>}
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
  // The queue, not the history: a launched brief that has been dispatched is
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
        <Usage view={view} actions={actions} />
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
          title="Briefs waiting for a free slot — open the launch desk"
        />
        <LocalRun view={view} actions={actions} />
        <Build view={view} actions={actions} />
        <Environments view={view} actions={actions} />
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
