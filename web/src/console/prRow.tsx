import type { JSX } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { OpenPullRequest, PullRequest } from '../types.js';
import { goalOfPr } from '../view/goalPage.js';
import { AsyncButton } from '../components/AsyncButton.js';
import { Ref, refLabel } from '../components/refs.js';
import { waitedFor } from '../components/util.js';
import type { PanelRowModel } from './PanelRow.js';
import { AgentOnIt } from '../components/AgentOnIt.js';
import { CiMark, CiSlot } from '../components/CiMark.js';
import { CommentsMark } from '../components/CommentsMark.js';
import { ReviewMark } from '../components/ReviewMark.js';
import { Tag } from '../components/tag.js';

// → docs/spec/17-cockpit.md#the-pull-request-row

/**
 * The one pull-request row. Every surface that draws a pull request as a row
 * draws this one: the rack on the overview, and each part of a goal's plan for
 * the pull request carrying it. Two readings of one pull request side by side is
 * how the same PR comes to wear two sets of marks nobody chose — the same rule
 * `CiMark` is one component for.
 *
 * `goal` is the only thing that varies: the rack says which goal a pull request
 * is delivering, and on the goal's own page that reference points at the page
 * the reader is already on.
 */
export function prRow(
  pr: OpenPullRequest,
  view: CockpitView,
  actions: CockpitActions,
  { goal: withGoal = true }: { goal?: boolean } = {},
): PanelRowModel {
  const unwatched = pr.attention.status === 'unwatched';
  const goal = goalOfPr(view.state, pr.number);
  const onIt = view.agentOnBranch.get(pr.branch);
  const watchLabel = view.state.config.watchLabel;
  return {
    key: String(pr.number),
    title: pr.title,
    refs: (
      <>
        <Ref to={`pr:${pr.number}`} />
        {withGoal && goal !== null && (
          <Ref to={goal} title={`Open the goal this pull request is delivering — ${refLabel(goal)}`} />
        )}
      </>
    ),
    open: () => actions.selectPr(pr.number),
    openTitle: `Open pull request #${pr.number} — its review threads, its checks and the work on its branch`,
    facts: unwatched ? undefined : prFacts(pr, view.now),
    why: unwatched ? null : pr.attention.reasons.join(' '),
    lamp: onIt === undefined ? undefined : <AgentOnIt agentId={onIt.id} note={onIt.note} actions={actions} />,
    reading: (
      <>
        {onIt === undefined ? <CiMark pr={pr} reserve onOpen={() => actions.selectPr(pr.number)} /> : <CiSlot />}
        {/* The fleet's own reading of the diff; survives an agent taking the
            chip's place since what was already read doesn't change on a move. */}
        <ReviewMark review={pr.review} now={view.now} reserve onOpen={() => actions.selectPr(pr.number)} />
        {/* Whether anybody is waiting on an answer — a verdict, not a fact like
            an age, so it left the sub-line for its own mark. */}
        <CommentsMark comments={pr.unresolvedComments} reserve onOpen={() => actions.selectPr(pr.number)} />
      </>
    ),
    toggle: (
      <AsyncButton
        className="cn-eye"
        disabled={watchLabel === ''}
        onClick={() => actions.setPrWatched(pr.number, unwatched)}
        title={
          watchLabel === ''
            ? 'No watch label configured — the watch gate is off'
            : unwatched
              ? `Tag this PR "${watchLabel}" and let the harness work it`
              : `Take the "${watchLabel}" tag off so the harness leaves this PR alone`
        }
      >
        <Eye open={!unwatched} />
      </AsyncButton>
    ),
    spent: unwatched,
    live: onIt !== undefined,
  };
}

/**
 * The same row for a pull request nothing will happen on again. What it keeps is
 * what is still a record — the fleet's reading, and the word for how it ended;
 * the checks, the court and the watch gate are all about what happens next, and
 * on a dead pull request there is no next.
 */
export function closedPrRow(pr: PullRequest, view: CockpitView, actions: CockpitActions): PanelRowModel {
  return {
    key: String(pr.number),
    title: pr.title,
    refs: <Ref to={`pr:${pr.number}`} />,
    open: () => actions.selectPr(pr.number),
    openTitle: `Open pull request #${pr.number} — its review threads, its checks and the work on its branch`,
    reading: <ReviewMark review={pr.review} now={view.now} reserve onOpen={() => actions.selectPr(pr.number)} />,
    chips: (
      <Tag tone={pr.merged ? 'green' : undefined} fill={pr.merged}>
        {pr.merged ? 'merged' : 'closed'}
      </Tag>
    ),
    spent: true,
  };
}

function prFacts(pr: OpenPullRequest, now: number): PanelRowModel['facts'] {
  const facts: { label: string; value: string; alarm?: boolean }[] = [];
  if (pr.mergeableState === 'dirty') facts.push({ label: 'merge', value: 'conflict', alarm: true });
  const since = pr.attention.reviewWaitingSince;
  if (since !== undefined) facts.push({ label: 'waiting', value: waitedFor(since, now) });
  return facts.length === 0 ? undefined : facts;
}

function Eye({ open }: { open: boolean }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <path
        d="M1 8s2.6-4.2 7-4.2S15 8 15 8s-2.6 4.2-7 4.2S1 8 1 8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <circle cx="8" cy="8" r="1.9" fill="currentColor" />
      {!open && <path d="M2.5 13.5 13.5 2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />}
    </svg>
  );
}
