/*
 * Shared, not skin-owned — the one panel that moved back across the line when a
 * second skin arrived.
 *
 * It looks like drawing, and most of it is; but the watch/ignore toggles, the
 * conclusion verdict and the assay override are operator controls with refusal
 * rules behind them, and those are what the shared/skinned split is drawn on. A
 * skin that reimplemented this would sooner or later ship a world view missing a
 * toggle, and flipping skins would silently take a capability away. Tinting it
 * through the tokens is the cost of not having that happen.
 *
 * The assay override is the sharpest case of that, which is why it lives here
 * and not only on the Goal Floor: an `unclear` verdict is the one intake reading
 * that *blocks* dispatch, so a skin without the override is a cockpit you cannot
 * un-block an issue from. The floor's refused-assay plate is a second entry
 * point through the same action — `PlanModal`'s pattern, where three surfaces
 * reach one `viewPlan`.
 */
import { useState } from 'react';
import type { AppState, Issue, Plan, PullRequest } from '../types.js';
import { watchBucket, type WatchBucket } from '../worldBuckets.js';
import { statusDot, refLink, refChip } from './util.js';
import { AsyncButton } from './AsyncButton.js';
import { AttachmentStrip } from './AttachmentStrip.js';
import { RaiseBugModal } from './RaiseBugModal.js';

/**
 * The bugs raised from this row: one chip each, in the order they were raised.
 *
 * Both statuses are drawn, because they say different things — `raising` means a
 * desk agent is writing it up and there is nothing to click yet, and a filed one
 * links to the item itself. A filing that never completed therefore stays visible
 * as a filing rather than silently reading like one that was never made.
 *
 * The link goes through `refUrls` like every other ref chip; a provider that
 * resolved no URL degrades to the ref's own label rather than a dead link.
 */
function bugChips(bugFilings: AppState['bugFilings'], issueNumber: number, refUrls: Record<string, string>) {
  const mine = (bugFilings ?? []).filter((b) => b.originRef === `issue:${issueNumber}`);
  if (mine.length === 0) return null;
  return mine.map((bug) =>
    bug.status === 'filing' ? (
      <span key={bug.jobId} className="chip small" title="An agent is writing this bug up in the tracker now">
        raising bug…
      </span>
    ) : (
      <span key={bug.jobId} className="chip small" title="A bug you raised from this item">
        → bug {refLink(`#${bug.ticketRef?.slice('issue:'.length) ?? '?'}`, refUrls)}
      </span>
    ),
  );
}

/**
 * The per-issue pickup chip (mirrors the PR health chip): what the harness is
 * doing with the item, or the first reason it's leaving it alone — full reasons
 * in the title. `done`/`has_pr` stay silent: the state chip and the "→ PR" chip
 * already say it. No verdict (older server) renders nothing.
 *
 * `container` is silent for that same reason and joined the list the moment it
 * had one: `hierarchyChips` draws the item's type and its children, which is the
 * whole of what the verdict says, and its reason is a *sentence* — the longest
 * chip on the row, restating the chip beside it.
 */
function pickupChip(pickup: Issue['pickup']) {
  if (!pickup || pickup.status === 'done' || pickup.status === 'has_pr' || pickup.status === 'container') return null;
  if (pickup.status === 'eligible') {
    return (
      <span className="chip small" title="Would be picked up next cycle">
        eligible
      </span>
    );
  }
  // An agent on it is progress, and a delivered issue is parked on purpose — the
  // assessor's verdict, or the operator's. Neither is a warning; the reason string
  // already says who decided and what they saw, so it needs no colour to be read.
  // A retained run joins them: the ticket closed and the run is being kept on
  // purpose, waiting on a dismissal rather than on anything going wrong (#234).
  const calm = pickup.status === 'active' || pickup.status === 'delivered' || pickup.status === 'retained';
  return (
    <span className={`chip small${calm ? '' : ' warn'}`} title={pickup.reasons.join(', ')}>
      {pickup.reasons[0] ?? pickup.status}
      {pickup.reasons.length > 1 ? ` +${pickup.reasons.length - 1}` : ''}
    </span>
  );
}

/**
 * Where the item sits in the tracker's tree: the feature above it, or the fact
 * that it has none.
 *
 * Three states, and they are the three `parent` has. A tracker with no hierarchy
 * (`undefined` — every GitHub issue) draws nothing at all, so the panel is
 * unchanged for it. A parent draws as a link to the feature. `null` draws the
 * orphan flag, which is the one an operator can act on: a story under no feature
 * is a story whose goal is written down nowhere, and the agents working it are
 * being told to say so.
 *
 * A container draws one chip instead — its type and how much hangs off it, which
 * is the work the harness will actually pick up. That chip is also the *whole* of
 * its verdict: `pickupChip` returns null for a container so the row does not carry
 * the same fact twice, the second time as a sentence.
 */
function hierarchyChips(issue: Issue, refUrls: Record<string, string>) {
  const chips = [];
  const container = issue.pickup?.status === 'container';
  if (issue.parent) {
    chips.push(
      <span
        key="parent"
        className="chip small"
        title={`This ${issue.issueType ?? 'item'} belongs to ${issue.parent.issueType} #${issue.parent.number} — "${issue.parent.title}" (${issue.parent.workItemState}). Its description is the goal agents working this item are given.`}
      >
        ↳ {issue.parent.issueType} {refLink(`#${issue.parent.number}`, refUrls)}
      </span>,
    );
  } else if (issue.parent === null && !container) {
    chips.push(
      // Not `warn`. It is a standing property of the ticket, not something going
      // wrong now, and it sits on every loose item on the board — at warning
      // weight it would out-shout the CI failure two rows down, permanently.
      <span
        key="orphan"
        className="chip small"
        title="No parent feature, so the wider goal this serves is recorded nowhere. Agents working it are told to flag it and suggest which open feature it belongs to — the harness never re-parents a work item itself."
      >
        no parent feature
      </span>,
    );
  }
  // One chip carries the whole of a container's story — what it is, how much
  // hangs off it, and (in the title) why nothing is dispatched at it. `pickupChip`
  // stays silent for one precisely so this is not said twice, once in a sentence.
  if (container || (issue.children && issue.children.length > 0)) {
    const children = issue.children ?? [];
    const open = children.filter((c) => c.state === 'open').length;
    const count =
      children.length === 0 ? 'no children' : `${children.length} child${children.length === 1 ? '' : 'ren'}`;
    chips.push(
      <span
        key="children"
        className="chip small"
        title={[
          ...(container ? [issue.pickup?.reasons[0] ?? '', ''] : []),
          ...children.map((c) => `${c.issueType} #${c.number} "${c.title}" (${c.workItemState})`),
        ]
          .join('\n')
          .trim()}
      >
        {container ? `${issue.issueType} · ` : ''}
        {count}
        {open > 0 ? `, ${open} open` : ''}
      </span>,
    );
  }
  return chips.length === 0 ? null : chips;
}

/**
 * The way into an issue's decomposition, and it draws whenever there is one.
 *
 * It used to ride *on* the pickup chip — the plan opened by clicking whatever
 * that chip said. Two transient conditions were therefore governing access to a
 * standing record: `pickupChip` returns null for `done` and `has_pr`, which is
 * exactly where an issue sits once its parts have pull requests, and the whole
 * chip is hidden off the watched tab. So the plan became unreadable at the point
 * it started being worked. A plan's existence is not a pickup verdict, so this is
 * neither gated on one nor drawn out of one.
 *
 * The status is on the chip rather than left to the modal: it is the one fact
 * that decides whether opening it is a decision or a reading.
 */
function planChip(plan: Plan | undefined, onViewPlan: (planId: string) => void) {
  if (!plan) return null;
  return (
    <button
      className={`btn ghost small chip-button${plan.status === 'awaiting_approval' ? ' warn' : ''}`}
      onClick={() => onViewPlan(plan.id)}
      title="Open the plan for this issue — every part, its scope, and the planner's write-up"
    >
      plan · {plan.status.replace(/_/g, ' ')}
    </button>
  );
}

/**
 * The way into the shared notepad, drawn whenever there is something on it.
 *
 * Keyed on the pad **having entries**, never on what the goal is doing — the
 * lesson the plan and the retrospective both learned, and the reason the snapshot
 * ships a reading rather than the trail. A pad is written during the work and read
 * long after it, so the moment it stops being reachable must not be the moment the
 * goal changes status.
 *
 * The count is on the chip because it is the one fact that decides whether opening
 * it is worth the click: four entries is a conversation, one is a note.
 */
function scratchpadChip(issue: Issue, onViewScratchpad: (issueRef: string) => void) {
  const pad = issue.scratchpad;
  if (!pad || pad.entries === 0) return null;
  return (
    <button
      className="btn ghost small chip-button"
      onClick={() => onViewScratchpad(`issue:${issue.number}`)}
      title="Open the shared notepad for this goal — what the agents working it left each other, oldest first"
    >
      notepad · {pad.entries}
    </button>
  );
}

/**
 * The per-issue conclusion chip: has anyone said this issue is finished?
 *
 * It draws for **`done` and `undeclared` alike**, and that is the point. The two
 * look identical from the outside — a work item sitting in a review state — and
 * the whole reason the harness now stops on silence is that it cannot tell them
 * apart. So the chip is where the difference becomes visible: `undeclared` says
 * nobody vouched for this, which is a prompt to look rather than a fault, and it
 * draws unwarned for that reason.
 *
 * `more_work` renders nothing beyond the note: the pickup chip beside it already
 * says what is happening to the item, and one home per fact.
 */
function conclusionChip(conclusion: Issue['conclusion']) {
  if (!conclusion) return null;
  const who =
    conclusion.by === 'plan'
      ? 'from its plan'
      : conclusion.by === 'operator'
        ? 'you said'
        : conclusion.by === 'agent'
          ? 'the agent said'
          : '';
  if (conclusion.verdict === 'done') {
    return (
      <span className="chip small" title={`${who}: ${conclusion.note}`}>
        finished
      </span>
    );
  }
  if (conclusion.verdict === 'more_work') {
    return (
      <span className="chip small" title={`${who}: ${conclusion.note}`}>
        work left
      </span>
    );
  }
  return (
    <span className="chip small" title="Nobody has said whether this issue is finished — the harness is leaving it">
      unconcluded
    </span>
  );
}

/** What each shortfall cause has the harness offering to do, in the chip's own words. */
const SHORTFALL_LABEL: Record<string, string> = {
  plan: 'plan fell short',
  part: 'part fell short',
  goal: 'goal is wrong',
};

/** What accepting the harness's offer would do, per cause — the chip's second half. */
const SHORTFALL_CONSEQUENCE: Record<string, string> = {
  plan: 'the harness has offered to send the plan back to a planner',
  part: 'the harness has offered to append a follow-up part',
  goal: 'nothing is scheduled — a wrong goal is not something a planner or an agent can fix',
};

/**
 * The per-issue shortfall chip: an assessment said the goal is still not reached.
 *
 * It draws beside the pickup and conclusion chips rather than inside either, for
 * the reason `attention` sits beside `health`: pickup answers "would an agent
 * start on this next cycle", and a shortfall's honest answer to that is "yes, and
 * that is the point". What is missing from both is *what* fell short — which is
 * the whole of what makes the verdict routable, and the one thing an operator has
 * to see before they are asked to authorize a replan.
 *
 * The title names the **consequence** as well as the verdict, and quotes the
 * pending proposal's id when there is one, so the row and the "Needs you" inbox
 * join — `prAttention`'s `settled` arm's trick, paying the same one-item-in-two-
 * places cost for the same reason: a row that says it is stalled without saying
 * what is waiting on you is the re-derivation across four panels this avoids.
 *
 * A shortfall with no cause names nothing to route and draws nothing: the
 * conclusion chip beside it already says "work left", and one home per fact.
 */
function shortfallChip(shortfall: Issue['shortfall'], issueNumber: number, proposals: AppState['proposals']) {
  const label = shortfall?.cause ? SHORTFALL_LABEL[shortfall.cause] : undefined;
  if (!shortfall || !label) return null;
  const who = shortfall.by === 'operator' ? 'You' : 'The assessor';
  const what = shortfall.cause === 'part' ? ` (part "${shortfall.partSlug ?? '?'}")` : '';
  const pending = (proposals ?? []).find(
    (p) => p.kind === 'shortfall' && p.ref === `issue:${issueNumber}:shortfall` && p.status === 'pending',
  );
  const waiting = pending ? ` Awaiting your accept/reject (${pending.id}).` : '';
  return (
    <span
      className="chip small warn"
      title={`${who} said${what}: ${shortfall.summary}\n\n${SHORTFALL_CONSEQUENCE[shortfall.cause!]}.${waiting}`}
    >
      {label}
    </span>
  );
}

/**
 * The one thing an override's buttons cannot say for themselves, and the reason
 * it is said everywhere they are drawn: a refusal is not permanent and nothing is
 * re-asking. It lifts by itself the moment the ticket's own text fingerprints
 * differently — so an operator who does not know that will reach for the override
 * on issues where editing the goal was the honest fix.
 */
export const ASSAY_EXPIRY =
  "This hold also ends by itself the moment the ticket's own text changes — there is no timer and nothing re-asking.";

/** How each attention arm reads on the chip. `done`/`ignored` are omitted — see below. */
const COURT_LABEL: Record<string, string> = {
  you: 'your turn',
  harness: 'harness on it',
  elsewhere: 'waiting on others',
  settled: 'settled',
  stalled: 'stalled',
};

/**
 * The per-PR attention chip: *whose turn* the PR is on, with the reasons in the
 * title. It names the court and nothing else, because scanning a list for "what
 * is mine" is the thing it exists for — the health chip beside it carries the
 * visible detail of *why*.
 *
 * `done` and `ignored` render nothing: the row already draws a "merged" and an
 * "ignored" chip, and one home per fact. Only the two arms that are genuinely
 * asking for a person — your court, and the PR nothing is happening on — warn.
 */
function attentionChip(attention: PullRequest['attention']) {
  const label = attention ? COURT_LABEL[attention.status] : undefined;
  if (!attention || !label) return null;
  const warn = attention.status === 'you' || attention.status === 'stalled';
  return (
    <span className={`chip small${warn ? ' warn' : ''}`} title={attention.reasons.join(', ')}>
      {label}
    </span>
  );
}

const TABS: WatchBucket[] = ['watched', 'unwatched', 'ignored'];
const TAB_LABEL: Record<WatchBucket, string> = {
  watched: 'Watched',
  unwatched: 'Unwatched',
  ignored: 'Ignored',
};
/** Why each tab exists, on the tab itself — the labels alone don't say what the harness does. */
const TAB_TITLE: Record<WatchBucket, string> = {
  watched: 'The harness works these',
  unwatched: 'Not opted in — nothing will happen until you watch one',
  ignored: 'You tagged these leave-alone',
};

export function WorldSummary({
  state,
  showPullRequests = true,
  onToggleExclude,
  onToggleIssueWatch,
  onSetConclusion,
  onSetAssay,
  onRaiseBug,
  onViewPlan,
  onViewScratchpad,
}: {
  state: AppState;
  /**
   * Whether pull requests are listed here. A skin that draws them in full elsewhere
   * passes `false` so one subject is drawn in one place; Classic, which has no other
   * PR surface, leaves the default and is unchanged.
   *
   * It gates the counts and the recently-closed list as well as the rows — tab counts
   * that included PRs nobody could see would not match what the tab shows.
   */
  showPullRequests?: boolean;
  onToggleExclude: (prNumber: number, excluded: boolean) => Promise<unknown> | unknown;
  onToggleIssueWatch: (issueNumber: number, watched: boolean) => Promise<unknown> | unknown;
  onSetConclusion: (issueNumber: number, verdict: 'done' | 'more_work' | null) => Promise<unknown> | unknown;
  /** Override the intake verdict — see {@link ASSAY_EXPIRY} for what it is beside. */
  onSetAssay: (issueNumber: number, verdict: 'workable' | 'unclear' | null) => Promise<unknown> | unknown;
  /**
   * Raise a bug against an item: the operator ran it and it does not do what they
   * expect. Unlike its neighbours this files into the tracker and leaves the
   * item's own verdict alone — the bug is its own work item and carries the work.
   */
  onRaiseBug: (issueNumber: number, summary: string, title?: string) => Promise<unknown> | unknown;
  /** Open the full plan for an issue's decomposition, when it has one. */
  onViewPlan: (planId: string) => void;
  /** Open a goal's shared notepad, when the agents on it wrote anything. */
  onViewScratchpad: (issueRef: string) => void;
}) {
  const [tab, setTab] = useState<WatchBucket>('watched');
  // The item whose "raise issue" was clicked, or null. Held as the issue itself so
  // the modal can name it — one modal for the whole list, not one per row.
  const [raisingBug, setRaisingBug] = useState<Issue | null>(null);
  const { pullRequests, issues } = state.world;
  // Newest first: a PR you were watching disappears mid-session otherwise, with
  // nothing to say whether it landed or was abandoned.
  const recentlyClosed = showPullRequests
    ? [...(state.world.closedPullRequests ?? [])].sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''))
    : [];
  const { refUrls } = state;
  const tag = state.config.ignoreLabel;
  const { watchLabel, ignoreLabel } = state.config;
  // Both labels empty means the operator turned the gates off (`labelPrefix: ''`):
  // every item then sits on its type default, so two of the three tabs could only
  // ever be empty *and* filtering to `watched` would hide every issue. So the tab
  // bar isn't just hidden — nothing is filtered at all, and the panel reads exactly
  // as it did before.
  const gated = Boolean(watchLabel || ignoreLabel);
  const prBucket = (labels: string[] | undefined) =>
    watchBucket(labels, { watchLabel, ignoreLabel, defaultWatched: true });
  const itemBucket = (labels: string[] | undefined) =>
    watchBucket(labels, { watchLabel, ignoreLabel, defaultWatched: false });
  const inTab = (bucket: WatchBucket) => !gated || bucket === tab;

  // The counts on the tabs are of live world items only — a recently-closed PR is
  // news about work that has already ended, so counting it would have the Watched
  // number climb as things finish.
  const counts: Record<WatchBucket, number> = { watched: 0, unwatched: 0, ignored: 0 };
  if (showPullRequests) for (const pr of pullRequests) counts[prBucket(pr.labels)]++;
  for (const i of issues) counts[itemBucket(i.labels)]++;

  const visiblePrs = showPullRequests ? pullRequests.filter((pr) => inTab(prBucket(pr.labels))) : [];
  const visibleIssues = issues.filter((i) => inTab(itemBucket(i.labels)));
  // "Recently closed" lives in the Watched tab alone: it exists so a PR you were
  // following doesn't silently vanish mid-session, which is a statement to someone
  // monitoring. Bucketing those rows by their own labels would scatter them.
  const showClosed = (!gated || tab === 'watched') && recentlyClosed.length > 0;
  // Whatever tab a row is filed under already states its watch state, so the chips
  // that only repeat it are dropped. The pickup chip is safe to drop wholesale
  // here — its one arm carrying more than the tag (the Azure state gate, reported
  // as `unwatched`) fires on *labels* the bucket reads as watched, so it lands in
  // the Watched tab and renders in full.
  const showPickupChip = !gated || tab === 'watched';
  // A linked PR that isn't open is a closed one `linkedPrNumber` stayed pointing at
  // — read off the same list `openPrForIssue` is given, so the two can't disagree.
  const openPrNumbers = new Set(pullRequests.filter((pr) => !pr.merged).map((pr) => pr.number));

  return (
    <div className="world">
      {gated && (
        <div className="world-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={t === tab}
              className={`world-tab${t === tab ? ' on' : ''}`}
              onClick={() => setTab(t)}
              title={TAB_TITLE[t]}
            >
              {TAB_LABEL[t]} <span className="count">{counts[t]}</span>
            </button>
          ))}
        </div>
      )}
      {counts[tab] === 0 && gated && (
        <div className="world-empty">
          no {TAB_LABEL[tab].toLowerCase()} {showPullRequests ? 'PRs or issues' : 'issues'}
        </div>
      )}
      {visiblePrs.length > 0 && (
        <div className="world-row">
          <span>PRs</span>
          <b>{visiblePrs.length}</b>
        </div>
      )}
      {visiblePrs.map((pr) => {
        const isExcluded = (pr.labels ?? []).includes(tag);
        return (
          <div key={pr.id} className={`world-item${isExcluded ? ' excluded' : ''}`}>
            {statusDot(pr.ciStatus)} {refLink(`#${pr.number}`, refUrls)} {pr.title}
            {pr.unresolvedComments.filter((c) => !c.handled).length > 0 && (
              <span className="chip small">{pr.unresolvedComments.filter((c) => !c.handled).length} comments</span>
            )}
            {attentionChip(pr.attention)}
            {isExcluded ? (
              showPickupChip && (
                <span className="chip small" title={`Tagged "${tag}" — the harness is leaving this PR alone`}>
                  ignored
                </span>
              )
            ) : pr.merged ? (
              <span className="chip small">merged</span>
            ) : pr.health?.blocked ? (
              <span className="chip small warn" title={pr.health.reasons.join(', ')}>
                {pr.health.reasons[0]}
                {pr.health.reasons.length > 1 ? ` +${pr.health.reasons.length - 1}` : ''}
              </span>
            ) : (
              pr.ciStatus === 'passing' &&
              pr.approved &&
              pr.mergeable && <span className="chip small warn">merge-ready</span>
            )}
            {!pr.merged && (
              <AsyncButton
                className="ghost world-toggle"
                onClick={() => onToggleExclude(pr.number, !isExcluded)}
                title={
                  isExcluded
                    ? `Remove the "${tag}" tag and let the harness work this PR again`
                    : `Tag this PR "${tag}" so the harness leaves it alone (for a PR blocked on something it can't fix)`
                }
              >
                {isExcluded ? 'watch' : 'ignore'}
              </AsyncButton>
            )}
          </div>
        );
      })}
      {showClosed && (
        <>
          <div className="world-row">
            <span>Recently closed</span>
            <b>{recentlyClosed.length}</b>
          </div>
          {recentlyClosed.map((pr) => (
            <div key={pr.id} className="world-item excluded">
              {refLink(`#${pr.number}`, refUrls)} {pr.title}
              <span
                className={`chip small${pr.state === 'merged' ? '' : ' warn'}`}
                title={pr.closedAt ? `${pr.state === 'merged' ? 'Merged' : 'Closed'} ${pr.closedAt}` : undefined}
              >
                {pr.state === 'merged' ? 'merged' : 'closed unmerged'}
              </span>
            </div>
          ))}
        </>
      )}
      {visibleIssues.length > 0 && (
        <div className="world-row">
          <span>Issues</span>
          <b>{visibleIssues.length}</b>
        </div>
      )}
      {visibleIssues.map((i) => {
        const isIgnored = (i.labels ?? []).includes(ignoreLabel);
        const watched = itemBucket(i.labels) === 'watched';
        const resolved = i.state !== 'open' || i.linkedPrNumber !== null;
        const linkLive = i.linkedPrNumber !== null && openPrNumbers.has(i.linkedPrNumber);
        return (
          <div key={i.id} className={`world-item${isIgnored ? ' excluded' : ''}`}>
            {refLink(`#${i.number}`, refUrls)} {i.title} <span className="chip small">{i.state}</span>
            {isIgnored && showPickupChip && (
              <span className="chip small" title={`Tagged "${ignoreLabel}" — the harness is leaving this issue alone`}>
                ignored
              </span>
            )}
            {hierarchyChips(i, refUrls)}
            {showPickupChip && pickupChip(i.pickup)}
            {planChip(
              (state.plans ?? []).find((p) => p.originRef === `issue:${i.number}`),
              onViewPlan,
            )}
            {scratchpadChip(i, onViewScratchpad)}
            {conclusionChip(i.conclusion)}
            {shortfallChip(i.shortfall, i.number, state.proposals)}
            {i.linkedPrNumber !== null && (
              <span
                className={`chip small${linkLive ? '' : ' stale'}`}
                title={
                  linkLive
                    ? undefined
                    : // Never "merged" or "closed": the PR left the open list, and which
                      // of the two that was is not something the harness observed.
                      'That PR is no longer open — the link is the last one that ever referenced this issue'
                }
              >
                → PR {refLink(`#${i.linkedPrNumber}`, refUrls)}
                {!linkLive && ' (not open)'}
              </span>
            )}
            {!resolved && (
              <AsyncButton
                className="ghost world-toggle"
                onClick={() => onToggleIssueWatch(i.number, !watched)}
                title={
                  watched
                    ? `Remove "${watchLabel}" so the harness leaves this issue alone`
                    : `Tag this issue "${watchLabel}" so the harness picks it up`
                }
              >
                {watched ? 'ignore' : 'watch'}
              </AsyncButton>
            )}
            {i.state === 'open' && (
              <AsyncButton
                className="ghost world-toggle"
                onClick={() => onSetConclusion(i.number, i.conclusion?.verdict === 'done' ? null : 'done')}
                title={
                  i.conclusion?.verdict === 'done'
                    ? 'Withdraw "finished" — the issue goes back to whatever its agent or plan says'
                    : 'Mark this issue finished, so the harness schedules nothing more for it'
                }
              >
                {i.conclusion?.verdict === 'done' ? 'unfinish' : 'finished'}
              </AsyncButton>
            )}
            {i.state === 'open' && i.conclusion?.verdict !== 'more_work' && (
              <AsyncButton
                className="ghost world-toggle"
                onClick={() => onSetConclusion(i.number, 'more_work')}
                title="Say there is work left here, so the harness picks it up again once no PR is open"
              >
                more work
              </AsyncButton>
            )}
            {/* The bugs already raised from this row, and the way to raise another.
                Deliberately *not* gated on `i.state === 'open'` like the two verdict
                buttons above: "the harness closed this and it does not work" is the
                case the control exists for. Gated instead on there being a tracker
                to file into, off the same flag the finding and work-item filing
                buttons read. */}
            {bugChips(state.bugFilings, i.number, refUrls)}
            {state.config.canFileTickets && (
              <button
                className="btn ghost world-toggle"
                onClick={() => setRaisingBug(i)}
                title="Report that this does not work as you expect — an agent files it as a bug linked to this item, and this item's own state is left alone"
              >
                raise issue
              </button>
            )}
            {/* Only a refusal gets an override. A `workable` verdict blocks
                nothing, so a button on one would offer to change a reading that
                changes no behaviour — and clearing is a *third* option rather
                than the same toggle's other end, because `null` is not
                `workable`: it is the store's one representation of "nobody has
                decided", which is also what a crashed assayer leaves behind.
                The assayer's own words are quoted into the title and never
                rewritten here. */}
            {i.state === 'open' && i.assay?.verdict === 'unclear' && (
              <>
                <AsyncButton
                  className="ghost world-toggle"
                  onClick={() => onSetAssay(i.number, 'workable')}
                  title={`The assay refused this goal: "${i.assay.summary}"\n\nWork it anyway — the harness stops holding pickup and runs a cycle now. ${ASSAY_EXPIRY}`}
                >
                  work anyway
                </AsyncButton>
                <AsyncButton
                  className="ghost world-toggle"
                  onClick={() => onSetAssay(i.number, null)}
                  title={`Clear the verdict, so nobody has decided and an assayer may judge the goal again — not the same as calling it workable. ${ASSAY_EXPIRY}`}
                >
                  clear assay
                </AsyncButton>
                {/* What the harness said on the ticket about this refusal, which
                    is the half of it the operator could not see (#171). It sits
                    beside the overrides and not among them: the two buttons
                    change the verdict, this only opens what was already said —
                    and it draws only when the provider resolved a URL, so an
                    unwritten comment and an unresolvable one are both silent. */}
                {refChip(i.assay.commentRef, 'comment ↗', refUrls, {
                  title: 'The comment the harness is keeping on this ticket, asking for what it needs',
                })}
              </>
            )}
            {/* Last, because it is the one block in this row rather than a chip.
                Drawn here at all because a code blueprint carrying a screenshot
                becomes a *ticket*: the queue card the image was attached to is
                gone by the time the funnel runs, and this row is where the goal
                now lives (issue #249). */}
            <AttachmentStrip
              targetRef={`issue:${i.number}`}
              attachments={state.attachments}
              attachmentUrls={state.attachmentUrls}
            />
          </div>
        );
      })}
      {/* One modal for the whole list, keyed off which row was clicked — the
          pattern `PlanModal` uses, where several surfaces open one dialog. */}
      {raisingBug && (
        <RaiseBugModal
          issueNumber={raisingBug.number}
          issueTitle={raisingBug.title}
          onSubmit={(summary, title) => Promise.resolve(onRaiseBug(raisingBug.number, summary, title))}
          onClose={() => setRaisingBug(null)}
        />
      )}
    </div>
  );
}
