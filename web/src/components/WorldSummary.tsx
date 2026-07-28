/*
 * Shared, not skin-owned — the one panel that moved back across the line when a
 * second skin arrived.
 *
 * It looks like drawing, and most of it is; but the watch/ignore toggles and the
 * conclusion verdict are operator controls with refusal rules behind them, and
 * those are what the shared/skinned split is drawn on. A skin that reimplemented
 * this would sooner or later ship a world view missing a toggle, and flipping
 * skins would silently take a capability away. Tinting it through the tokens is
 * the cost of not having that happen.
 */
import { useState } from 'react';
import type { AppState, Issue, PullRequest } from '../types.js';
import { watchBucket, type WatchBucket } from '../worldBuckets.js';
import { statusDot, refLink } from './util.js';
import { AsyncButton } from './AsyncButton.js';

/**
 * The per-issue pickup chip (mirrors the PR health chip): what the harness is
 * doing with the item, or the first reason it's leaving it alone — full reasons
 * in the title. `done`/`has_pr` stay silent: the state chip and the "→ PR" chip
 * already say it. No verdict (older server) renders nothing.
 */
function pickupChip(pickup: Issue['pickup']) {
  if (!pickup || pickup.status === 'done' || pickup.status === 'has_pr') return null;
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
  const calm = pickup.status === 'active' || pickup.status === 'delivered';
  return (
    <span className={`chip small${calm ? '' : ' warn'}`} title={pickup.reasons.join(', ')}>
      {pickup.reasons[0] ?? pickup.status}
      {pickup.reasons.length > 1 ? ` +${pickup.reasons.length - 1}` : ''}
    </span>
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
  onToggleExclude,
  onToggleIssueWatch,
  onToggleStoryWatch,
  onSetConclusion,
}: {
  state: AppState;
  onToggleExclude: (prNumber: number, excluded: boolean) => Promise<unknown> | unknown;
  onToggleIssueWatch: (issueNumber: number, watched: boolean) => Promise<unknown> | unknown;
  onToggleStoryWatch: (storyId: string, watched: boolean) => Promise<unknown> | unknown;
  onSetConclusion: (issueNumber: number, verdict: 'done' | 'more_work' | null) => Promise<unknown> | unknown;
}) {
  const [tab, setTab] = useState<WatchBucket>('watched');
  const { pullRequests, issues, stories } = state.world;
  // Newest first: a PR you were watching disappears mid-session otherwise, with
  // nothing to say whether it landed or was abandoned.
  const recentlyClosed = [...(state.world.closedPullRequests ?? [])].sort((a, b) =>
    (b.closedAt ?? '').localeCompare(a.closedAt ?? ''),
  );
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
  for (const pr of pullRequests) counts[prBucket(pr.labels)]++;
  for (const i of issues) counts[itemBucket(i.labels)]++;
  for (const s of stories) counts[itemBucket(s.labels)]++;

  const visiblePrs = pullRequests.filter((pr) => inTab(prBucket(pr.labels)));
  const visibleIssues = issues.filter((i) => inTab(itemBucket(i.labels)));
  const visibleStories = stories.filter((s) => inTab(itemBucket(s.labels)));
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
        <div className="world-empty">no {TAB_LABEL[tab].toLowerCase()} PRs, issues or stories</div>
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
            {showPickupChip && pickupChip(i.pickup)}
            {conclusionChip(i.conclusion)}
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
          </div>
        );
      })}
      {visibleStories.length > 0 && (
        <div className="world-row">
          <span>Stories</span>
          <b>{visibleStories.length}</b>
        </div>
      )}
      {visibleStories.map((s) => {
        const isIgnored = (s.labels ?? []).includes(ignoreLabel);
        const watched = itemBucket(s.labels) === 'watched';
        return (
          <div key={s.id} className={`world-item${isIgnored ? ' excluded' : ''}`}>
            {s.title} <span className="chip small">{s.state}</span>
            {isIgnored && showPickupChip && (
              <span className="chip small" title={`Tagged "${ignoreLabel}" — the harness is leaving this story alone`}>
                ignored
              </span>
            )}
            {!isIgnored && !watched && showPickupChip && (
              <span className="chip small" title={`No "${watchLabel}" tag — the harness isn't picking this story up`}>
                unwatched
              </span>
            )}
            {(!s.description || !s.acceptanceCriteria) && <span className="chip small warn">needs grooming</span>}
            {s.wafPillars.length === 0 && <span className="chip small warn">no WAF</span>}
            <AsyncButton
              className="ghost world-toggle"
              onClick={() => onToggleStoryWatch(s.id, !watched)}
              title={
                watched
                  ? `Remove "${watchLabel}" so the harness leaves this story alone`
                  : `Tag this story "${watchLabel}" so the harness picks it up`
              }
            >
              {watched ? 'ignore' : 'watch'}
            </AsyncButton>
          </div>
        );
      })}
    </div>
  );
}
