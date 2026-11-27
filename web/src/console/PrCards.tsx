import { Fragment, type JSX, type ReactNode } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { OpenPullRequest, PrOnYouReason } from '../types.js';
import { buildGoalPage } from '../view/goalPage.js';
import { buildGoalTrack } from '../view/goalStages.js';
import { goalIssue, goalOfPr } from '../view/goalRefs.js';
import { prOnYouReasons } from '../view/needsYouPage.js';
import { PR_REASON_LABEL } from '../view/prsOnYou.js';
import { rackByGoal, type RackGoal } from '../view/prRack.js';
import { prHeadline } from '../view/prHeadline.js';
import { BareButton } from '../components/button.js';
import { classes } from '../components/classes.js';
import { Ref, refLabel } from '../components/refs.js';
import { waitedFor } from '../components/util.js';
import { AgentOnIt } from '../components/AgentOnIt.js';
import { CiMark } from '../components/CiMark.js';
import { CommentsMark } from '../components/CommentsMark.js';
import { ReviewMark } from '../components/ReviewMark.js';
import { Track } from '../components/track.js';
import { GroupHead, type RowGroup } from './PanelRow.js';
import { WatchToggle } from './prRow.js';

// → docs/spec/17-cockpit.md#the-pull-request-card

export interface PrCardModel {
  pr: OpenPullRequest;
  group?: RowGroup;
  goal?: boolean;
  watch?: boolean;
  who?: ReactNode;
  action?: ReactNode;
  below?: ReactNode;
}

export function goalPrCards(prs: readonly OpenPullRequest[], view: CockpitView): PrCardModel[] {
  const goals = rackByGoal(view.state, prs);
  const byGoal = goals.some((g) => g.goal !== null);
  return goals.flatMap((g) => {
    const group = byGoal ? goalBand(g, view) : undefined;
    return g.rungs.map((rung) => ({
      pr: rung.pr,
      goal: !byGoal,
      ...(group === undefined ? {} : { group }),
    }));
  });
}

function goalBand(g: RackGoal, view: CockpitView): RowGroup {
  if (g.goal === null) return { key: 'goal:none', label: 'No goal', note: `${g.rungs.length}` };
  const issue = goalIssue(view.state, g.goal);
  const page = buildGoalPage(view.state, g.goal, view.needsYou, null);
  const track = page === null ? null : buildGoalTrack(page.parts);
  return {
    key: `goal:${g.goal}`,
    tone: 'title',
    label: issue?.title ?? refLabel(g.goal),
    refs: <Ref to={g.goal} title={`Open the goal these pull requests are delivering — ${refLabel(g.goal)}`} />,
    note:
      track === null || track.total === 0 ? (
        `${g.rungs.length} open`
      ) : (
        <>
          <Track track={track} />
          {track.merged} of {track.total} merged
        </>
      ),
  };
}

type Stack = NonNullable<CockpitView['state']['stacks']>[number];
type StackRung = Stack['rungs'][number];

type PrItem =
  | { kind: 'card'; key: string; card: PrCardModel }
  | {
      kind: 'stack';
      key: string;
      stack: Stack;
      group?: RowGroup;
      rungs: { rung: StackRung; card: PrCardModel | null }[];
    };

/**
 * The cards in their order, with each stack's cards drawn together as one stack at the place of
 * its first card. `ghosts` keeps a stack's other rungs as slim rows, where the list holds only some
 * of a stack's pull requests; without it a stack draws only the cards it was given.
 */
function stackItems(cards: readonly PrCardModel[], stacks: readonly Stack[], ghosts: boolean): PrItem[] {
  const byPr = new Map<number, Stack>();
  for (const st of stacks) for (const r of st.rungs) if (!byPr.has(r.prNumber)) byPr.set(r.prNumber, st);
  const stackOf = (n: number): Stack | undefined => byPr.get(n);
  const drawn = new Set<string>();
  const items: PrItem[] = [];
  for (const card of cards) {
    const stack = stackOf(card.pr.number);
    if (stack === undefined) {
      items.push({ kind: 'card', key: String(card.pr.number), card });
      continue;
    }
    const key = `${card.group?.key ?? ''}|${stack.ref}`;
    if (drawn.has(key)) continue;
    drawn.add(key);
    const mine = cards.filter((c) => c.group?.key === card.group?.key && stackOf(c.pr.number) === stack);
    const rungs = [...stack.rungs]
      .sort((a, b) => a.position - b.position)
      .map((rung) => ({ rung, card: mine.find((c) => c.pr.number === rung.prNumber) ?? null }))
      .filter((r) => ghosts || r.card !== null);
    if (rungs.length < 2) {
      items.push({ kind: 'card', key: String(card.pr.number), card });
      continue;
    }
    items.push({ kind: 'stack', key, stack, rungs, ...(card.group === undefined ? {} : { group: card.group }) });
  }
  return items;
}

export function PrCards({
  cards,
  view,
  actions,
  ghosts = false,
}: {
  cards: readonly PrCardModel[];
  view: CockpitView;
  actions: CockpitActions;
  ghosts?: boolean;
}): JSX.Element {
  let band: string | undefined;
  return (
    <div className="cn-prcards cn-plainrefs">
      {stackItems(cards, view.state.stacks ?? [], ghosts).map((item) => {
        const group = item.kind === 'card' ? item.card.group : item.group;
        const opens = group !== undefined && group.key !== band;
        band = group?.key;
        return (
          <Fragment key={item.key}>
            {opens && <GroupHead group={group} />}
            {item.kind === 'card' ? (
              <PrCardWithBelow card={item.card} view={view} actions={actions} />
            ) : (
              <StackBlock item={item} view={view} actions={actions} />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

/** A rung as its plan numbers it (`2/6`), or by its place in the stack where no single plan owns it. */
function rungLabel(stack: Stack, rung: StackRung): string {
  return rung.partSeq === null || stack.partTotal === null
    ? String(rung.position)
    : `${String(rung.partSeq)}/${String(stack.partTotal)}`;
}

function StackBlock({
  item,
  view,
  actions,
}: {
  item: Extract<PrItem, { kind: 'stack' }>;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  const { stack } = item;
  const open = item.rungs.length;
  const base = stack.rungs.find((r) => r.position === 1)?.base || 'main';
  const landing = view.state.stackLandings.find((l) => l.ref === stack.ref);
  const topFirst = [...item.rungs].reverse();
  return (
    <div className="cn-prstack">
      <div className="cn-prstack-head">
        <span>
          Stack · {open} open · lands on <code>{base}</code>
        </span>
        {landing?.blockedBy != null && <span className="cn-prstack-held">Held: {landing.blockedBy}</span>}
        {landing?.offer === true && <span className="cn-prstack-ready">Ready to land</span>}
      </div>
      <ol className="cn-prstack-rungs">
        {topFirst.map(({ rung, card }) => {
          const part = rungLabel(stack, rung);
          const cls = classes(
            'cn-prstack-rung',
            card === null && 'cn-prstack-ghost',
            landing?.blockedPr === rung.prNumber && 'cn-prstack-blocking',
            rung.position === 1 && 'cn-prstack-next',
          );
          return (
            <li key={rung.prNumber} className={cls}>
              <span className="cn-prstack-pos" aria-label={`part ${part}`}>
                {part}
              </span>
              {card === null ? (
                <span className="cn-prstack-other">
                  <Ref to={`pr:${rung.prNumber}`} />
                  <BareButton
                    usage={{ counted: 'pr.view' }}
                    className="cn-prstack-title"
                    onClick={() => actions.selectPr(rung.prNumber)}
                    title={`Open pull request #${rung.prNumber}`}
                  >
                    {prHeadline(rung.title)}
                  </BareButton>
                  <i>not waiting on you</i>
                </span>
              ) : (
                <div className="cn-prstack-card">
                  <PrCardWithBelow card={card} view={view} actions={actions} />
                </div>
              )}
            </li>
          );
        })}
        <StackFoot merged={stack.mergedBelow} base={base} />
      </ol>
    </div>
  );
}

function StackFoot({ merged, base }: { merged: Stack['mergedBelow']; base: string }): JSX.Element {
  return (
    <>
      {merged.map((part) => (
        <li key={`merged-${String(part.seq)}`} className="cn-prstack-rung cn-prstack-ghost cn-prstack-merged">
          <span className="cn-prstack-pos" aria-label={`part ${String(part.seq)}, merged`}>
            ✓
          </span>
          <span className="cn-prstack-other">
            {part.prNumber !== null && <Ref to={`pr:${part.prNumber}`} />}
            <span className="cn-prstack-title">{part.title}</span>
            <i>merged</i>
          </span>
        </li>
      ))}
      <li className="cn-prstack-rung cn-prstack-base">
        <span className="cn-prstack-pos" aria-hidden>
          ↓
        </span>
        <code>{base}</code>
      </li>
    </>
  );
}

function PrCardWithBelow(props: { card: PrCardModel; view: CockpitView; actions: CockpitActions }): JSX.Element {
  return (
    <>
      <PrCard {...props} />
      {props.card.below}
    </>
  );
}

function PrCard({
  card,
  view,
  actions,
}: {
  card: PrCardModel;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  const { pr } = card;
  const unwatched = pr.attention.status === 'unwatched';
  const goal = card.goal === true ? goalOfPr(view.state, pr.number) : null;
  const onIt = view.agentOnBranch.get(pr.branch);
  const open = (): void => actions.selectPr(pr.number);
  const said = pr.attention.reasons.join(' ');
  return (
    <div className={unwatched ? 'cn-prcard cn-spent' : 'cn-prcard'}>
      {card.who !== undefined && <span className="cn-prcard-who">{card.who}</span>}
      <div className="cn-prcard-body">
        <div className="cn-prcard-top">
          <TopLine pr={pr} now={view.now} unwatched={unwatched} goal={goal} />
          <span className="cn-prcard-marks cn-slot-read">
            {onIt === undefined ? (
              <CiMark pr={pr} reserve onOpen={open} />
            ) : (
              <AgentOnIt agentId={onIt.id} note={onIt.note} actions={actions} />
            )}
            <ReviewMark review={pr.review} now={view.now} reserve onOpen={open} />
            <CommentsMark comments={pr.unresolvedComments} reserve onOpen={open} />
          </span>
        </div>
        <div className="cn-prcard-head">
          <BareButton
            usage={{ counted: 'pr.view' }}
            className="cn-prcard-title"
            onClick={open}
            title={`${pr.title} — open pull request #${pr.number}: its review threads, its checks and the work on its branch`}
          >
            {prHeadline(pr.title)}
          </BareButton>
          {(card.watch === true || card.action !== undefined) && (
            <span className="cn-prcard-acts">
              {card.watch === true && <WatchToggle pr={pr} view={view} actions={actions} />}
              {card.action}
            </span>
          )}
        </div>
        {!unwatched && said !== '' && <p className="cn-prcard-said">{said}</p>}
      </div>
    </div>
  );
}

const LEAD_TONE: Record<PrOnYouReason, string> = {
  review: 'red',
  call: 'amber',
  comments: 'blue',
  assign: 'violet',
  describe: 'grey',
};

function TopLine({
  pr,
  now,
  unwatched,
  goal,
}: {
  pr: OpenPullRequest;
  now: number;
  unwatched: boolean;
  goal: string | null;
}): JSX.Element {
  const lead = unwatched ? undefined : prOnYouReasons(pr)[0];
  const since = pr.attention.reviewWaitingSince;
  return (
    <span className="cn-prcard-l1">
      {lead !== undefined && <b className={`cn-prcard-lead cn-ink-${LEAD_TONE[lead]}`}>{PR_REASON_LABEL[lead]}</b>}
      {unwatched && <span>not watched</span>}
      <span className="cn-refs">
        <Ref to={`pr:${pr.number}`} />
        {goal !== null && <Ref to={goal} title={`Open the goal this pull request is delivering — ${refLabel(goal)}`} />}
      </span>
      {!unwatched && pr.mergeableState === 'dirty' && <span className="cn-alarm">merge conflict</span>}
      {!unwatched && since !== undefined && <span>waiting {waitedFor(since, now)}</span>}
    </span>
  );
}
