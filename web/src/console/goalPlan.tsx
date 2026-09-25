import { useState, type JSX } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { GoalPageView, PartGroup } from '../view/goalPage.js';
import { planUnderWay, planVerdictAsk, GOAL_ANCHOR } from '../view/goalPage.js';
import type { OpenPullRequest, PlanPart, PullRequest } from '../types.js';
import { PartDescriptionTag } from '../components/partDescriptions.js';
import { PlanRevealGate } from '../components/PlanRevealGate.js';
import { PredictionReview } from '../components/PredictionReview.js';
import { PanelRows, type PanelRowModel } from './PanelRow.js';
import { closedPrRow, prRow } from './prRow.js';
import { NeedsBand } from './NeedsBand.js';
import { AgentOnIt } from '../components/AgentOnIt.js';
import type { Fold } from './goalFold.js';

// → docs/spec/17-cockpit.md

type PartPr = { open: true; pr: OpenPullRequest } | { open: false; pr: PullRequest };

const GROUP_ORDER: PartGroup[] = ['merged', 'now', 'held', 'waiting'];

/**
 * The groups the board actually draws, in order. One definition, because the pane
 * reads it too: the panel's pointer is aimed at the card the operator chose, and a
 * second spelling of which columns exist is how that pointer comes to aim at the
 * wrong one.
 */
function liveGroups(page: GoalPageView): PartGroup[] {
  return GROUP_ORDER.filter((group) => page.parts.some((p) => p.group === group));
}

const GROUP_LABEL: Record<PartGroup, string> = {
  merged: 'Merged',
  now: 'Now',
  held: 'Held',
  waiting: 'Not started',
};

/* The pull requests this goal owns that no part of the plan carries. A goal
   delivered whole has no parts at all, a pull request can be filed before the
   plan exists, and the provider links some itself — so `ownsPr`'s answer is
   wider than the plan's, and the difference is work the board would otherwise
   not draw at all. → docs/spec/17-cockpit.md#a-part-and-its-pull-request */
function loosePullRequests(page: GoalPageView): PartPr[] {
  const carried = new Set(
    [...page.parts.map((p) => p.part), ...page.retiredParts]
      .map((part) => part.prNumber)
      .filter((n): n is number => n !== null),
  );
  return [
    ...page.openPullRequests.filter((pr) => !carried.has(pr.number)).map((pr): PartPr => ({ open: true, pr })),
    ...page.closedPullRequests.filter((pr) => !carried.has(pr.number)).map((pr): PartPr => ({ open: false, pr })),
  ];
}

export function PlanWaves({
  page,
  view,
  actions,
  fold,
}: {
  page: GoalPageView;
  view: CockpitView;
  actions: CockpitActions;
  fold: Fold;
}): JSX.Element {
  const plan = page.plan;
  // The gate lifts here the moment the reveal returns, rather than waiting on the
  // payload the refresh behind it brings. `revealed` is the server's fact and this
  // is only the page catching up to it, so the flag is never read the other way:
  // once the payload says revealed, this is dead weight and the gate is gone for
  // good. → docs/proposals/prediction-record-and-criteria-integrity.md
  const [lifted, setLifted] = useState(false);
  const gated = plan !== null && !plan.revealed && !lifted;
  const underWay = planUnderWay(page);
  const verdict = planVerdictAsk(page, view.state.escalations);

  return (
    <section className="cn-card" id={GOAL_ANCHOR.plan}>
      <PlanHeading page={page} gated={gated} actions={actions} />
      {gated && (
        <PlanRevealGate
          issueNumber={page.issue.number}
          onRevealed={async () => {
            try {
              await actions.refresh();
            } finally {
              setLifted(true);
            }
          }}
        />
      )}
      {/* Above the parts, and only while the plan is still at its gate: marking the
          prediction against what the plan says is what this pane is *for* at that
          moment, and the parts below it are not going anywhere until it is approved.
          Once the plan is approved the prediction leaves this card altogether —
          `WorkPaneBody` draws it at the foot of the pane.
          → docs/spec/17-cockpit.md#where-the-prediction-is-drawn */}
      {!gated && !underWay && (
        <PredictionReview
          issueNumber={page.issue.number}
          revealed={plan !== null && (plan.revealed || lifted)}
          plan={plan}
          parts={page.parts.map((p) => p.part)}
          open={fold.open}
          settled={fold.settled}
          onToggle={fold.onToggle}
          now={view.now}
        />
      )}
      {/* Under the prediction, and only while the plan is read and undecided: the
          sitting the gate opened ends in a verdict, and an operator who has just
          marked their prediction against the plan had to go back up the page to
          give one. The ask itself is drawn — not a second spelling of it — so the
          caveats, the check set and every refusal the routes can give are the
          rail's own.
          → docs/spec/17-cockpit.md#the-verdict-where-the-plan-was-read */}
      {!gated && verdict !== null && (
        <div className="cn-plan-verdict">
          <NeedsBand row={verdict} view={view} actions={actions} />
        </div>
      )}
      <PlanBoard page={page} board={planBoard(page, view, actions)} gated={gated} view={view} actions={actions} />
    </section>
  );
}

function PlanHeading({
  page,
  gated,
  actions,
}: {
  page: GoalPageView;
  gated: boolean;
  actions: CockpitActions;
}): JSX.Element {
  const plan = page.plan;
  const retired = page.retiredParts;
  return (
    <h3>
      The plan
      {page.parts.length > 0 && <i className="cn-n">{page.parts.length} parts</i>}
      {page.parts.length === 0 && retired.length > 0 && <i className="cn-n">{retired.length} retired</i>}
      <span className="cn-more">
        left to right is dispatch order
        {/* The way to the whole plan, on the card that draws its summary. The
            waves are titles and dependencies; the diagnosis, the map, each part's
            acceptance and what was decided are the sheet's, and it was reachable
            from here only through the validation card's aside about amending the
            checks — a door nobody looking for the plan would think to try. */}
        {plan !== null && !gated && (
          <button
            type="button"
            className="cn-linkish"
            title="The plan sheet — the write-up, the shape, each part in full, and the decision that was made on it"
            onClick={() => actions.viewPlan(plan.id)}
          >
            open the full plan ↗
          </button>
        )}
      </span>
    </h3>
  );
}

interface Board {
  prs: Map<number, PartPr>;
  loose: PartPr[];
  rail: PanelRowModel[];
}

function planBoard(page: GoalPageView, view: CockpitView, actions: CockpitActions): Board {
  const prs = new Map<number, PartPr>();
  for (const pr of page.closedPullRequests) prs.set(pr.number, { open: false, pr });
  for (const pr of page.openPullRequests) prs.set(pr.number, { open: true, pr });
  /* Each part draws its pull request in a card of its own, so each would size its
     own columns and the board's marks would sit at a different x on every part.
     The rail is every part's row, handed to all of them: one set of columns
     across the whole board, which is what `PanelRows`' own rail is for.
     → docs/spec/17-cockpit.md#a-part-and-its-pull-request */
  const loose = loosePullRequests(page);
  const rail = [
    ...[...page.parts.map((p) => p.part), ...page.retiredParts]
      .map((part) => (part.prNumber === null ? null : (prs.get(part.prNumber) ?? null)))
      .filter((pr): pr is PartPr => pr !== null),
    ...loose,
  ].map((pr) => (pr.open ? prRow(pr.pr, view, actions, { goal: false }) : closedPrRow(pr.pr, view, actions)));
  return { prs, loose, rail };
}

function emptyBoard(page: GoalPageView): string {
  if (page.plan === null) return 'No plan has been drawn for this goal.';
  return page.retiredParts.length > 0
    ? 'Every part of this plan was retired. What it proposed is below.'
    : 'The plan has no live parts.';
}

function PlanBoard({
  page,
  board,
  gated,
  view,
  actions,
}: {
  page: GoalPageView;
  board: Board;
  gated: boolean;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  const groups = liveGroups(page).map((group) => ({
    group,
    parts: page.parts.filter((p) => p.group === group),
  }));
  const retired = page.retiredParts;
  const { prs, loose, rail: prRail } = board;
  return (
    <div className="cn-waves" hidden={gated}>
      {groups.length === 0 && <p className="cn-empty">{emptyBoard(page)}</p>}
      {groups.map(({ group, parts }) => (
        <div className="cn-col" key={group}>
          <div className="cn-coln">{GROUP_LABEL[group]}</div>
          {parts.map((p) => (
            <Part
              key={p.part.id}
              part={p.part}
              group={p.group}
              agentId={p.agentId}
              agentLive={p.agentLive}
              pr={p.part.prNumber === null ? null : (prs.get(p.part.prNumber) ?? null)}
              prRail={prRail}
              view={view}
              actions={actions}
            />
          ))}
        </div>
      ))}
      {/* A column of its own, last: these are the goal's work as much as any part
          is, and left off the board they were a card further down the pane
          repeating the same row under a different heading. Drawn as parts with
          nothing known about them rather than as a second list — what the plan
          does not account for is still what is happening to this goal.
          → docs/spec/17-cockpit.md#a-part-and-its-pull-request */}
      {loose.length > 0 && (
        <div className="cn-col">
          <div className="cn-coln">Not in the plan</div>
          {loose.map((pr) => (
            <div className="cn-part cn-loose" key={pr.pr.number}>
              <PartPrRow pr={pr} rail={prRail} view={view} actions={actions} />
              <span className="cn-dep">no part of the plan names this</span>
            </div>
          ))}
        </div>
      )}
      {retired.length > 0 && (
        <div className="cn-col">
          <div className="cn-coln">Retired</div>
          {retired.map((part) => (
            <Part
              key={part.id}
              part={part}
              group="retired"
              agentId={null}
              agentLive={false}
              pr={part.prNumber === null ? null : (prs.get(part.prNumber) ?? null)}
              prRail={prRail}
              view={view}
              actions={actions}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Part({
  part,
  group,
  agentId,
  agentLive,
  pr,
  prRail,
  view,
  actions,
}: {
  part: PlanPart;
  group: PartGroup | 'retired';
  agentId: string | null;
  agentLive: boolean;
  pr: PartPr | null;
  prRail: readonly PanelRowModel[];
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  /* A part is a pull request, and the pull request's own page is where everything
     about it is — the threads, the checks, and the description an operator writes.
     So the card is a way *there* rather than a way to a panel of its own: the board
     tells the parts apart, and the page the change is read on is where it is worked.
     → docs/spec/07-pull-requests.md#the-pull-requests-own-page-is-where-it-is-written */
  const prNumber = part.prNumber;
  const pickable = prNumber !== null;
  const pick = (): void => actions.selectPr(prNumber ?? 0);
  return (
    <div
      className={`cn-part cn-${group} ${pickable ? 'is-pickable' : ''}`}
      /* The whole card is the way in, and the title carries the same press for a
         keyboard — a control inside it (the PR reference, the agent) is its own
         press and must not also open the page. */
      onClick={
        pickable
          ? (event) => {
              if ((event.target as HTMLElement).closest('a, button') === null) pick();
            }
          : undefined
      }
    >
      {pickable ? (
        <button
          type="button"
          className="cn-partpick"
          title="Open this part’s pull request — its threads, its checks, and what it says it does"
          onClick={pick}
        >
          <b>
            {part.seq} · {part.title}
          </b>
        </button>
      ) : (
        <b>
          {part.seq} · {part.title}
        </b>
      )}
      {group === 'held' && part.blockedReason !== null && <p className="cn-why">{part.blockedReason}</p>}
      {part.scope !== '' && <p>{part.scope}</p>}
      {pr !== null && <PartPrRow pr={pr} rail={prRail} view={view} actions={actions} />}
      {/* The description's standing, said on the part it belongs to: the board is
          where the parts are told apart, so it is where an operator reads which of
          them wants a sentence. The card is the way to the page that takes one.
          → docs/spec/07-pull-requests.md#the-pull-requests-own-page-is-where-it-is-written */}
      <PartDescriptionTag slug={part.slug} prNumber={part.prNumber} />
      <span className="cn-dep">
        {part.dependsOn.length > 0 ? `depends on ${part.dependsOn.join(', ')}` : 'depends on nothing'}
        {/* A live agent gets the chip the whole cockpit says this with; a
            finished one keeps the plain way in, because what it offers is the
            record of what happened here and not a claim that anything still is. */}
        {agentId !== null && (
          <>
            {' · '}
            {agentLive ? (
              <AgentOnIt agentId={agentId} actions={actions} />
            ) : (
              <button
                type="button"
                className="cn-openagent"
                title="Open the agent that worked this part — its transcript, what it cost, and its controls"
                onClick={() => actions.select(agentId)}
              >
                open the agent ↗
              </button>
            )}
          </>
        )}
      </span>
    </div>
  );
}

/* The pull request carrying this part, drawn as the one pull-request row the
   cockpit has — the same `prRow` the overview's rack is built from, so a part
   and the rack say the same thing about the same pull request in the same
   shape. A strip of bare marks under the title said all of it and named none of
   it: the row is what makes "what is happening to this part" readable without
   first learning six glyphs.
   → docs/spec/17-cockpit.md#a-part-and-its-pull-request */
function PartPrRow({
  pr,
  rail,
  view,
  actions,
}: {
  pr: PartPr;
  rail: readonly PanelRowModel[];
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  return (
    <div className="cn-partpr cn-read-marks">
      <PanelRows
        layout="stacked"
        rail={rail}
        /* The goal reference is the page this row is already on, and the rack's
           own `goal: false` reason applies here twice over. */
        rows={[pr.open ? prRow(pr.pr, view, actions, { goal: false }) : closedPrRow(pr.pr, view, actions)]}
      />
    </div>
  );
}
