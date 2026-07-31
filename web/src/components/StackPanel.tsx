import type { PullRequest, Stack, StackRung } from '../types.js';
import { refLink } from './util.js';

/**
 * Chains of stacked pull requests, drawn as one column each.
 *
 * Until now a stack was visible only as a plan's parts, which meant a chain
 * someone opened by hand was not visible as a chain at all — even though the
 * harness has always been able to see it (`basePrOf` walks exactly that edge).
 * A plan *adopts* a stack here and never owns one, so both are drawn the same.
 *
 * The health and attention chips are the ones the PR list already uses rather
 * than new ones: a rung is a pull request, and an operator reading it twice must
 * not get two different accounts of it.
 */
export function StackPanel({
  stacks,
  prs,
  refUrls,
}: {
  stacks: Stack[];
  /** The open PRs, for each rung's health — joined by number. */
  prs: PullRequest[];
  refUrls: Record<string, string>;
}) {
  if (stacks.length === 0) {
    return <p className="empty">No stacks — no open pull request is based on another.</p>;
  }
  const byNumber = new Map(prs.map((p) => [p.number, p]));
  return (
    <div className="stacks">
      {stacks.map((stack) => (
        <StackCard key={stack.ref} stack={stack} byNumber={byNumber} refUrls={refUrls} />
      ))}
    </div>
  );
}

function StackCard({
  stack,
  byNumber,
  refUrls,
}: {
  stack: Stack;
  byNumber: Map<number, PullRequest>;
  refUrls: Record<string, string>;
}) {
  // Top-first on screen: a stack reads like a stack of things, with the one that
  // merges next at the bottom. `rungs` is bottom-first, which is the order the
  // dispatcher and the reconciler think in, so the reversal happens here only.
  const topFirst = [...stack.rungs].reverse();
  return (
    <div className="stack-card">
      <div className="stack-head">
        {stack.issueNumber !== null && refLink(`#${stack.issueNumber}`, refUrls)}
        <span className="stack-title">{stack.issueTitle ?? 'Stacked pull requests'}</span>
        <span
          className="chip small"
          title={stack.planId ? 'A plan produced this stack' : 'Read off the pull requests themselves'}
        >
          {stack.planId ? 'from plan' : 'observed'}
        </span>
        <span className="stack-ref">
          {stack.ref} · {stack.rungs.length} PRs
        </span>
      </div>
      <div className="stack-rungs">
        {topFirst.map((rung) => (
          <Rung key={rung.prNumber} rung={rung} pr={byNumber.get(rung.prNumber)} refUrls={refUrls} />
        ))}
      </div>
    </div>
  );
}

function Rung({
  rung,
  pr,
  refUrls,
}: {
  rung: StackRung;
  pr: PullRequest | undefined;
  refUrls: Record<string, string>;
}) {
  const bottom = rung.position === 1;
  return (
    <div className={`stack-rung${bottom ? ' bottom' : ''}`}>
      <span className="stack-pos">{rung.position}</span>
      {refLink(`#${rung.prNumber}`, refUrls)}
      <span className="stack-rung-title">{rung.title}</span>
      {rung.partSlug !== null && <span className="chip small">{rung.partSlug}</span>}
      {/* The same verdict the PR list shows. A rung with no matching PR in the
          open list is one the world dropped between the fold and this render —
          draw nothing rather than assert health we do not have. */}
      {pr?.health?.blocked === true && (
        <span className="chip small warn" title={pr.health.reasons.join(' · ')}>
          {pr.health.reasons[0]}
        </span>
      )}
      {bottom && pr?.health?.blocked !== true && (
        <span className="chip small ok" title="Nothing is stacked beneath this one">
          ready · bottom of stack
        </span>
      )}
      <span className="stack-base">→ {rung.base}</span>
    </div>
  );
}
