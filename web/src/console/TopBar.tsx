import { useState } from 'react';
import type { JSX } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { EnvironmentHealthReading } from '../types.js';
import type { CockpitActions, ConsoleTab } from '../cockpit/actions.js';
import { FleetControl } from '../components/FleetControl.js';
import { Icon } from '../components/icons.js';
import { ExtLink, fmtUsd, relTime } from '../components/util.js';
import { Button } from '../components/button.js';
import { RaiseIssueModal } from '../components/RaiseIssueModal.js';
import { DesktopLink } from '../components/DesktopLink.js';
import { questionPrompt } from '../cockpit/desktopLink.js';
import { untriagedCount } from '../worldBuckets.js';
import { useThemeUnsaved } from '../hooks.js';
import { signalRows } from './WorldSignals.js';

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
 * **Pets was the third of these and is not here any more.** It is drawn at full
 * size in the bottom-left corner already, on a strip that was itself a button, so
 * the tab was a second way to a surface the eye lands on anyway — and a nav slot is
 * the most expensive space in the cockpit. The Vivarium bar carries the destination
 * now, which also puts it where the thing it names is. → `Vivarium`
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

  // Features is **inserted** rather than appended, because
  // it belongs beside Tickets: the two are the same backlog read at two altitudes,
  // and a reader moving between them should not cross the board to do it. It is
  // absent unless the deployment has a board at all — the operator's flag *and* a
  // provider with a hierarchy, folded server-side by `featureBoardOn` so the tab
  // and the route can never disagree. A tab that opens on a page explaining a
  // hierarchy this tracker does not have is worse than no tab.
  const tabs: readonly ConsoleTab[] = view.state.config.featureBoard
    ? ['overview', 'tickets', 'features', 'obstacles', 'insights']
    : TABS;

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
function Ident({ view }: { view: CockpitView }): JSX.Element {
  return (
    <div className="cn-ident">
      <i className="cn-dot" style={view.connected ? undefined : { background: 'var(--cn-red)' }} />
      LubbDubb
      {view.demo && <span style={{ color: 'var(--cn-fg-faint)', fontWeight: 400 }}>· demo</span>}
    </div>
  );
}

/**
 * The bar's two ways out — file one, or ask one — drawn together at the right-hand
 * end beside the readings.
 *
 * **Beside each other, always.** The two are the same moment — something looks
 * wrong — and the cheaper reading of it is offered first; split up, the expensive
 * one ends up the only one on the bar.
 *
 * They sit with the readings rather than against the wordmark because that is
 * where the operator's hand already is: every other control on this strip that
 * *does* something rather than naming the product is in this group, and the
 * wordmark's job is to say where you are. It also stops the pair inheriting the
 * ident's 600, which read them as a second half of the wordmark.
 *
 * **All three faces are the shared button** — `Button` connected, `ExtLink` with a
 * `look` offline, `DesktopLink` beside them — at `ghost small`, which is the
 * console's chip size to begin with. `console.css` used to draw the chrome itself,
 * on a wrapper `<span>`, because `ExtLink` took no class and a rule naming
 * `.ext-ref` is the one thing this stylesheet is tested not to do. What that bought
 * was a pill inside a pill once the question hand-off became a `DesktopLink` and
 * arrived wearing the button kit: two borders, two radii and two grounds on one
 * control. The wrapper is gone and the seam is the `look` prop, which is the same
 * bargain `DesktopLink` already made.
 *
 * One word and a mark each. `Raise an issue` and `Got a question?` were two
 * sentences in the same weight and the same ink, a hand's width apart, and read as
 * one run of small print; the punctuation is what tells them apart at a glance,
 * since it is the difference between them — one files, one asks. It carries that
 * difference alone now: the accent edge the question wore was the wrapper's, and a
 * tone is the one thing `className` on a button may not carry.
 */
function Asks({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  // Local state and not `Place`: a half-typed report is not somewhere you can come
  // back to, so it is not somewhere the URL should be able to send you.
  // `GoalPage`'s compose modals are held the same way.
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
    <div className="cn-asks">
      {canCompose ? (
        <Button
          ghost
          size="small"
          title="Write an issue about LubbDubb and file it on its own tracker, without leaving the cockpit"
          onClick={() => setComposing(true)}
        >
          Issue!
        </Button>
      ) : (
        <ExtLink href={NEW_ISSUE_URL} look={{ ghost: true, size: 'small' }} title="Raise an issue on the LubbDubb repo">
          Issue!
        </ExtLink>
      )}
      {/* The bar's second way out, and the one that answers rather than files.
          Most of what arrives as an issue about the fleet is not a fault in it —
          it is "why has this not moved", which the harness's own record answers in
          a sentence and which nobody asks because asking meant opening a client,
          finding the checkout and remembering the skill. This is that, as a
          control: a `DesktopLink` onto the repository the fleet works, with
          `/lubbdubb ` in the composer and the question left to the operator.

          The one deep link that says `Question?` rather than `Open in Claude
          Code`. The other five are drawn beside the thing they open and are named
          for the destination for that reason; this one addresses nothing, and the
          destination is not the offer — named for it, it read as a developer's
          control parked between `Issue!` and the usage meters rather than as the
          invitation to ask. The questions it is for are in the title, which is the
          only place a label of one word can put them.

          Unconditional, like every other deep link: it reaches only the machine
          the browser is on, and `DesktopLink` puts the command in the title for
          exactly the operator it cannot reach. */}
      <DesktopLink
        folder={view.state.config.desktopFolder}
        prompt={questionPrompt()}
        label="Question?"
        ready="waiting for your question"
        explain="so you can ask why something has not been picked up, what a goal is doing or what any of this means — answered from the harness’s own record of the work, and said so when the record is silent."
      />
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
  // The check's own sentences, verbatim — or the harness's account of why it has
  // none, which is a different thing and never dressed as one. They were the card's
  // `why`, and with the card gone the chip is the only place they are said at all.
  const said = worst.reasons.length > 0 ? worst.reasons.join(' · ') : worst.detail;
  const title =
    rank === 3
      ? `Every environment answered well — ${read}.`
      : `${worst.environment} ${worst.state === 'unknown' ? 'did not answer' : 'is not well'} — ${word} since ${relTime(worst.changedAt, now).replace(' ago', '')}, ${read}.${said === null || said === '' ? '' : ` ${said}`}`;
  return {
    value: `${count} ${word}`,
    quiet: rank === 3,
    tone: rank === 2 ? 'watch' : rank === 3 ? null : 'ill',
    title,
  };
}

/**
 * The Environments chip — **drawn only while something out there is not well**,
 * and beside the fleet cap rather than on the overview.
 *
 * It is the one reading on this bar that comes and goes, which is the opposite of
 * the strip's own rule that a quiet reading is dimmed and never removed. The rule
 * holds for gauges of the fleet: a fault count that vanished at zero is a count an
 * operator has to hunt for on the day it moves. This is not one. An environment is
 * well nearly all of its life and there is nothing to do about it when it is, so a
 * permanent `3 well` is a chip earning its width on the days it says nothing —
 * while an outage is the one thing on this bar that should be impossible to miss.
 * Its absence *is* the healthy reading, in the same way the rack's absence of a red
 * PR is.
 *
 * Beside the fleet cap for the same reason the countdown is: both are the state of
 * the world the fleet is dispatching into, read left to right — what the fleet is
 * allowed to do, when it next gets to, and whether where it ships is up.
 *
 * Nothing here re-decides anything. The word is the check's own tier, the count is
 * of environments sharing it, and the reasons ride the `title` verbatim. **Which**
 * environment, and what each check said, is one press away — the Environments panel,
 * the same one the menu row opens, because two surfaces drawing one check's
 * sentences are two places for them to disagree.
 * → docs/spec/24-environments.md#in-the-cockpit
 */
function Environments({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element | null {
  const readings = view.state.environmentHealth ?? [];
  if (readings.length === 0) return null;
  const reading = environmentsReading(readings, view.now);
  // `unknown` counts as not-well here, on the panel's rule: a check that could not
  // answer is not a claim that anything is right, and folding it into the healthy
  // silence is the one way this chip could hide an outage.
  if (reading.quiet) return null;
  const title = `${reading.title} Open the readings.`;
  return (
    <button
      type="button"
      className={`cn-read cn-act cn-env-${reading.tone ?? 'watch'}`}
      onClick={() => actions.openPanel('environments')}
      title={title}
      aria-label={title}
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
 * Where the harness's own build stands — the one reading in this menu that is about
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
function buildReading(view: CockpitView): MenuReading {
  const build = view.state.build;
  const due = build.state === 'behind' || build.state === 'ready';
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
  return {
    value: build.label,
    tone: due ? 'watch' : null,
    quiet: build.state === 'current' || build.state === 'unknown',
    title,
  };
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
      className={`cn-sub cn-act ${live ? '' : 'cn-quiet'} ${stale ? 'cn-stale' : ''}`}
      onClick={() => actions.openPanel('localRun')}
      title={title}
      aria-label={title}
    >
      <span>Local</span>
      <b>{live && number !== null ? `#${String(number)}` : 'off'}</b>
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
  const stale = reading.age === null ? '' : 'cn-usage-old';
  const title = `${reading.title} Open for what spent it.`;
  return (
    <button
      type="button"
      className={`cn-sub cn-act ${tone} ${stale}`}
      // Economics, because "where did it go" is a question about money and that is
      // the tab that splits it. The window is the point of the trip: landing on the
      // page's own default would answer for a week, which is a different question
      // with a bigger number — and the number is what an operator would remember.
      onClick={() => actions.openInsights({ insightsView: 'economics', insightsWindow: 'session' })}
      title={title}
      aria-label={title}
    >
      {/* The chip's own name is gone — `62%` on this bar is the account, and nothing
          else here is a percentage — but each window keeps a two-character tag.
          Position alone was tried and is not enough: the pair is always five-hour
          then weekly, but an operator glancing at one number cannot tell which they
          landed on, and "which window is that" is the whole question the chip
          answers. The tag is the smallest thing that settles it — 9px, faint, and
          set as a superscript so it costs the strip no width. */}
      {reading.cost === null ? (
        <i className="cn-usage-pair">
          {reading.slots.map((slot, i) => (
            <i key={slot.label} className={`cn-usage-win ${slot.binds ? 'cn-binds' : ''}`}>
              {i > 0 && (
                <i className="cn-usage-sep" aria-hidden="true">
                  /
                </i>
              )}
              <b>{slot.value}</b>
              <em>{slot.label}</em>
            </i>
          ))}
        </i>
      ) : (
        <b>{reading.cost}</b>
      )}
      {/* A stale reading is said in the *weight*, not in a second figure beside the
          first. `11m ago` beside `62% / 30%` is three numbers where the chip has two
          measurements, and the one an operator does not want is the one that changes
          every minute. The sentence is still in the `title`. */}
    </button>
  );
}

/** `issue:284` → 284. The panel and this both address a goal by its number. */
function originIssueNumber(originRef: string): number | null {
  const m = /^issue:(\d+)$/.exec(originRef);
  return m ? Number(m[1]) : null;
}

/** What a menu row draws: its value, the tint it takes, and the sentence behind it. */
interface MenuReading {
  value: string | null;
  tone: 'ill' | 'watch' | null;
  /**
   * A zero, or a state saying nothing — dimmed, never removed. The strip's own
   * rule, and it survives the fold: a row that vanished at zero would be a
   * reading an operator had to hunt for on the days it had nothing to say.
   */
  quiet: boolean;
  title: string;
}

/** One row of the bar's menu — a glyph, a word, and what that word currently reads. */
interface MenuEntry extends MenuReading {
  key: string;
  icon: 'alert' | 'rocket' | 'download' | 'globe' | 'bolt' | 'book' | 'gear';
  label: string;
  /**
   * Something is waiting on this row that its value cannot say — an unsaved theme
   * edit on Config, and so far only that (issue #680). A **dot and not a count**,
   * for the reason Config carries no value at all: what is pending is a fact, not a
   * quantity.
   */
  pending?: boolean;
  onPick: () => void;
}

/**
 * The seven ways-in the bar keeps folded away, in reading order.
 *
 * They are together because none of them is a gauge an operator glances at on
 * every pulse: faults and briefs are counts that are usually zero, the build is
 * `current` nearly all its life, and Record and Config are aimed at rather than
 * read. Spread across the strip they cost the width that pushed the bar into a
 * second row at laptop sizes; folded, each keeps its count — the menu's own
 * button carries the dot when any of them has something to say, so nothing that
 * used to be visible has become invisible.
 *
 * Exported for the tests, like {@link usageReading} and {@link environmentsReading}:
 * the rows are behind a button an operator opens, so a rendered bar cannot say
 * whether the fold that fills them is right — and every one of them was an
 * assertion on the bar's own markup before it moved in here.
 *
 * **Environments is absent, not zeroed, where no environment declares a check** —
 * the card's own exception, for its reason: a row reading `0 well` on a deployment
 * that configured none announces a feature as broken. It opens the overview rather
 * than a panel of its own, because the reasons and the per-environment rows are the
 * card's and a second surface drawing them is a second place for them to disagree.
 */
export function menuEntries(view: CockpitView, actions: CockpitActions, themeUnsaved = false): MenuEntry[] {
  const faults = view.state.errors.length;
  // The queue, not the history: a launched brief that has been dispatched is
  // an agent in the Fleet, and counting it here would have the reading climb as
  // work starts rather than as it waits.
  const queued = view.state.jobs.filter((job) => job.status === 'queued').length;
  const health = view.state.environmentHealth ?? [];
  const env = health.length === 0 ? null : environmentsReading(health, view.now);
  const build = buildReading(view);
  const signals = signalRows(view).length;
  return [
    {
      key: 'faults',
      icon: 'alert',
      label: 'Faults',
      value: `${faults}`,
      tone: faults === 0 ? null : 'ill',
      quiet: faults === 0,
      title: 'Recorded faults — open the fault log',
      onPick: () => actions.openPanel('faults'),
    },
    {
      key: 'launch',
      icon: 'rocket',
      label: 'Launch',
      value: `${queued}`,
      tone: null,
      quiet: queued === 0,
      title: 'Briefs waiting for a free slot — open the launch desk',
      onPick: () => actions.openPanel('launch'),
    },
    {
      key: 'build',
      icon: 'download',
      label: 'Build',
      value: build.value,
      tone: build.tone,
      quiet: build.quiet,
      title: build.title,
      onPick: () => actions.openPanel('build'),
    },
    // Env stays in the menu even though the bar carries a chip for it, because the
    // two answer different questions: the chip is *is something broken*, drawn only
    // when it is, and the row is *what did every environment say*, which is where an
    // operator goes to confirm that nothing is. Both open the one panel.
    ...(env === null
      ? []
      : [
          {
            key: 'env',
            icon: 'globe' as const,
            label: 'Env',
            value: env.value,
            tone: env.tone,
            quiet: env.quiet,
            title: env.title,
            onPick: () => actions.openPanel('environments'),
          },
        ]),
    // What the world did, which was the overview's fourth card until it turned
    // out to be read rather than watched — the same reason everything else in
    // this menu is in it. The count is the whole feed, so the row says whether
    // there is anything in there before it is opened; the Up next band carries
    // the other way in, beside the queue these signals decide.
    {
      key: 'signals',
      icon: 'bolt',
      label: 'Signals',
      value: `${signals}`,
      tone: null,
      quiet: signals === 0,
      title: 'What the world did — the feed the queue is decided off',
      onPick: () => actions.openPanel('signals'),
    },
    {
      key: 'record',
      icon: 'book',
      label: 'Record',
      value: null,
      tone: null,
      quiet: false,
      title: 'What the harness did, after the world snapshot forgot it — operator jobs, and the goals it has worked',
      onPick: () => actions.openPanel('record'),
    },
    {
      key: 'config',
      icon: 'gear',
      label: 'Config',
      value: null,
      tone: null,
      quiet: false,
      pending: themeUnsaved,
      title: themeUnsaved
        ? 'Config — an unsaved theme edit is pending; a reload drops it'
        : 'Config — how this harness is configured',
      onPick: () => actions.openConfig({}),
    },
  ];
}

/**
 * The bar's menu: one button, and the seven ways-in behind it.
 *
 * Closed on `Escape` and on focus leaving the group, which is the pair a keyboard
 * and a pointer each need — a document-level listener would be a third thing to
 * unsubscribe on a component the shell mounts and unmounts with the connection.
 *
 * The button takes a dot whenever a row inside has a tint, so the one thing the
 * fold could have cost — noticing a fault or an upgrade without opening anything —
 * is bought back in the spot the readings used to occupy.
 */
function BarMenu({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const [open, setOpen] = useState(false);
  // The theme's live preview persists when you leave its section, on purpose, but
  // the bar that states what that costs does not — so an unsaved theme was
  // indistinguishable from a saved one everywhere else in the cockpit (#680). It
  // has to reach the *button*, not only the row it belongs to: a mark visible only
  // once the menu is open is the same invisibility one fold further in.
  const entries = menuEntries(view, actions, useThemeUnsaved());
  const flagged = entries.some((entry) => entry.tone !== null || entry.pending === true);
  const title = flagged
    ? 'More — something in here wants a look'
    : 'More — faults, launch, build, signals, record and config';
  return (
    <div
      className="cn-menu-wrap"
      onKeyDown={(e) => {
        if (e.key === 'Escape') setOpen(false);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <button
        type="button"
        className={`cn-read cn-act cn-icon ${flagged ? 'cn-menu-flag' : ''} ${open ? 'cn-on' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        title={title}
        aria-label={title}
      >
        <Icon name="menu" size={15} />
      </button>
      {open && (
        <div className="cn-menu" role="menu">
          {entries.map((entry) => (
            <button
              key={entry.key}
              type="button"
              role="menuitem"
              className={`cn-menu-row ${entry.quiet ? 'cn-quiet' : ''} ${entry.pending === true ? 'cn-pending' : ''} ${
                entry.tone === null ? '' : `cn-tone-${entry.tone}`
              }`}
              title={entry.title}
              onClick={() => {
                setOpen(false);
                entry.onPick();
              }}
            >
              <Icon name={entry.icon} size={14} />
              <span>{entry.label}</span>
              {entry.value !== null && <b>{entry.value}</b>}
              <i className="cn-chev">›</i>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The control-room strip: ident, the nav, the pulse, the fleet cap, and the
 * readings. The nav is here because this is the only row of the shell that never
 * scrolls — everything else lives inside `.cn-sit`, which does. The ident is the
 * wordmark and nothing else; the two ways off this bar to a tracker — the compose
 * modal where the harness can file, and the external form it falls back to where it
 * cannot — ride the readings group at the other end ({@link Asks}).
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
        <Ident view={view} />
        <div className="cn-read">
          <span>Link</span>
          <b>offline</b>
        </div>
        {/* The offline bar keeps them, and the socket being down is the moment they
            matter most: `Asks` falls back to the tracker's own form when it cannot
            compose, which is the whole reason that fallback exists. */}
        <div className="cn-reads">
          <Asks view={view} actions={actions} />
        </div>
      </div>
    );
  }

  return (
    <div className="cn-bar">
      <Ident view={view} />
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

      {/* Only when it has something to say — see {@link Environments}. */}
      <Environments view={view} actions={actions} />

      <div className="cn-reads">
        <Asks view={view} actions={actions} />
        {/* One pill, two readings. Both are gauges of *this machine and this
            account* rather than of the work — what the allowance has left, and
            whether anything is up locally — and each is two or three characters
            wide. Two boxes around six characters was more chrome than reading; one
            box with a rule down the middle is the same two ways-in at half the
            width. Each half still opens its own surface, which is why they are two
            buttons and not one. */}
        <div className="cn-read cn-pill">
          <Usage view={view} actions={actions} />
          <i className="cn-pill-sep" />
          <LocalRun view={view} actions={actions} />
        </div>
        {/* Everything that is not a gauge, behind one button. Usage and Local stay
            on the strip because each is a number that moves on its own and is
            glanced at; the six inside are counts that are usually zero and ways-in
            that are aimed at, and a strip carrying all eight wrapped to two rows on
            a laptop. See {@link menuEntries}. */}
        <BarMenu view={view} actions={actions} />
      </div>
    </div>
  );
}
