import type { JSX } from 'react';
import type { CiCheck, PullRequest } from '../types.js';
import { Icon } from './icons.js';
import { Tip, useTip } from './tip.js';

/**
 * A pull request's checks, on its row and in its masthead: one chip that says
 * **its own name and what it found** — `CI 4/4`, `CI 1 failed`, `CI 2 running`.
 *
 * **It replaced a run of 6px squares.** Those said everything in hue alone: no
 * word, no shape between passing and failing, and their per-check names only in a
 * native `title` that arrives a second late and never at all on a touch screen. A
 * reader who did not already know what the dots were had nowhere to find out, and
 * a reader who could not tell the red from the green had nothing at all.
 *
 * **Nothing here decides anything.** The tone and the count are folded from
 * `ciVerdict` — the server's own classification, off the same `config.ci` rules
 * the dispatcher reads — and from `ciChecks`, which is the provider's list. A
 * second reading of the policy taken in the browser is the drift that outlives the
 * change introducing it. → docs/spec/17-cockpit.md#the-checks-mark
 */

/**
 * The tone alias, which is the shared family's triple rather than three colours
 * written here: a hue at a use site is a hue no theme can reach.
 * → docs/spec/17-cockpit.md#the-tag
 */
type CiTone = 't-green' | 't-red' | 't-amber' | 't-blue' | 't-grey';

interface CiReading {
  tone: CiTone;
  /**
   * The badge on the glyph's shoulder: **how many**, where a number is the reading,
   * and null where the tint alone is the whole of it.
   *
   * It was the chip's word — `1 muted`, `3 stalled`, `4 running` — and the words
   * cost the mark 96px on a rail where every other verdict is a 22px box. What the
   * badge keeps is the half a glance uses: the hue says which kind of trouble, the
   * number says how much of it, and the sentence is one hover away as it is on the
   * two marks beside it.
   *
   * **One distinction is spent on this**, and it is worth naming: amber is both
   * `for you` and `stalled`, which the words told apart and the badge does not.
   * Both are the same call to the operator — nothing will happen to this on its
   * own — and `said` separates them in the tooltip and in the accessible name.
   */
  badge: string | null;
  /** The same reading as a sentence: the tooltip's heading and the accessible name. */
  said: string;
}

/** Checks the harness itself never counts — advisory ones are display-only. */
function counted(pr: PullRequest): CiCheck[] {
  return (pr.ciChecks ?? []).filter((check) => check.advisory !== true);
}

/**
 * The fold: verdict first, aggregate second.
 *
 * The order is the harness's own. `ciVerdict` classifies the **failing** checks
 * and is the only thing that knows which failure is the fleet's to fix, which is
 * yours, and which the operator has muted — so where it says anything, it says it
 * before `ciStatus`, which is one word for the whole pull request. Null is the
 * pull request whose checks nobody has reported: drawn as nothing, because a grey
 * chip on every row of a provider that reports no checks is furniture.
 */
function reading(pr: PullRequest): CiReading | null {
  const verdict = pr.ciVerdict;
  const dispatch = verdict?.dispatch.length ?? 0;
  const escalate = verdict?.escalate.length ?? 0;
  const ignored = verdict?.ignored.length ?? 0;
  const checks = counted(pr);
  const total = checks.length;

  if (dispatch > 0) {
    return { tone: 't-red', badge: String(dispatch), said: said(dispatch, total, 'failed') };
  }
  // Amber and worded, not red: the policy says this one is **not** the harness's
  // to touch, and a reader who cannot separate the hues still gets the difference.
  if (escalate > 0) {
    return { tone: 't-amber', badge: String(escalate), said: said(escalate, total, 'failed, for you to fix') };
  }
  // Failing, and every failure is one the operator told the harness to leave
  // alone. Grey is the absence of a verdict, which is exactly what a muted check
  // is — but the chip still says a check is red, because it is.
  if (ignored > 0 && pr.ciStatus === 'failing') {
    return {
      tone: 't-grey',
      badge: String(ignored),
      said: said(ignored, total, 'failed, and muted by the CI policy'),
    };
  }

  switch (pr.ciStatus) {
    case 'passing':
      return {
        tone: 't-green',
        badge: null,
        said: total > 0 ? `All ${total} checks passed` : 'The checks passed',
      };
    case 'failing':
      // No per-check detail, or none the policy claimed — the aggregate speaks
      // under its own name rather than drawing nothing, because missing detail is
      // not a clean bill of health.
      return { tone: 't-red', badge: null, said: 'A check failed, and the provider named none of them' };
    case 'pending': {
      const waiting = checks.filter((check) => check.status === 'pending');
      // Pending with nothing in flight: the run is stale against the branch and
      // resolves only when somebody queues another. A different thing to wait for
      // than a build that is running, and the one the row could never say.
      if (waiting.length > 0 && waiting.every((check) => check.expired === true)) {
        return {
          tone: 't-amber',
          badge: String(waiting.length),
          said: `${waiting.length} check${waiting.length === 1 ? '' : 's'} waiting on a run nobody has started`,
        };
      }
      return {
        tone: 't-blue',
        badge: null,
        said:
          waiting.length > 0 ? `${waiting.length} of ${total} checks still running` : 'The checks are still running',
      };
    }
    case 'unknown':
      return null;
  }
}

/**
 * `1 of 4 checks failed`, and the same sentence where the total is unknown.
 *
 * The plural agrees with whichever number the noun follows — `1 of 2 checks` and
 * `1 check`, never `1 of 2 check` — because the sentence is the tooltip's heading
 * and the mark's accessible name both, and a screen reader reads it as prose.
 */
function said(n: number, total: number, what: string): string {
  const count = total > 0 ? total : n;
  const checks = `check${count === 1 ? '' : 's'}`;
  return total > 0 ? `${n} of ${total} ${checks} ${what}` : `${n} ${checks} ${what}`;
}

/**
 * What the policy made of each **failing** check, keyed by name, so the tooltip
 * can say why a red check is not being worked rather than only that it is red.
 * Every name comes off the verdict — no check name is written in this repository.
 */
function verdictWords(pr: PullRequest): Map<string, string> {
  const words = new Map<string, string>();
  for (const match of pr.ciVerdict?.dispatch ?? []) words.set(match.name, 'the fleet will fix it');
  for (const match of pr.ciVerdict?.escalate ?? []) words.set(match.name, 'yours — the policy says the fleet must not');
  for (const match of pr.ciVerdict?.ignored ?? []) words.set(match.name, 'muted by the CI policy');
  return words;
}

/**
 * How many checks the tooltip names before it stops counting. A rack row's whole
 * list is the pull request's page; this is enough to see which one went red.
 */
const TIP_CHECKS = 6;

/** A check's own word, or the policy's where the policy has one. */
function checkWord(check: CiCheck, words: Map<string, string>): string {
  return words.get(check.name) ?? check.status;
}

/**
 * The chip's box with nothing in it, at the width the chip would have had.
 *
 * Exported because the rack needs one for a reading it is *withholding* rather
 * than lacking: while an agent is on the branch the checks describe a commit that
 * is being replaced, so the row does not draw them — and if the box went with
 * them, the two marks beside it would slide left on exactly the rows that are
 * moving.
 *
 * Deliberately **not** the chip's own class: this is a gap the width of a chip,
 * not a chip with nothing in it. `test/panelRows.test.ts` reads the rack's markup
 * for a checks chip beside a live agent, and a placeholder wearing `ck` would
 * answer that question wrongly — which is the same confusion one layer down.
 * → docs/spec/17-cockpit.md#the-strip
 */
export function CiSlot(): JSX.Element {
  return <span className="ck-slot" aria-hidden="true" />;
}

/**
 * The chip. Null where nothing has reported — the same silence `CiLadder` kept,
 * for the same reason: a deployment whose provider reports no checks must not
 * grow a column of grey chips claiming it has some.
 */
export function CiMark({
  pr,
  reserve,
  onOpen,
}: {
  pr: PullRequest;
  /**
   * Keep the chip's box where this pull request has no reading but its neighbours
   * do — the marks beside it are what an eye runs down, and a row that closes the
   * slot moves every one of them. Off by default, so a surface whose pull requests
   * never report checks pays no gutter for them.
   */
  reserve?: boolean;
  onOpen?: () => void;
}): JSX.Element | null {
  const tip = useTip();
  const read = reading(pr);
  if (read === null) return reserve === true ? <CiSlot /> : null;

  const checks = counted(pr);
  const words = verdictWords(pr);
  const shown = checks.slice(0, TIP_CHECKS);
  const rest = checks.length - shown.length;
  // A button where there is somewhere to go, a span where there is not — rather
  // than a span with a click handler, which is a control no keyboard reaches and
  // no screen reader announces. Both carry the same tooltip and the same name.
  const Tag = onOpen === undefined ? 'span' : 'button';
  return (
    <Tag
      ref={tip.anchor as never}
      className={`ck ${read.tone}${onOpen === undefined ? '' : ' ck-open'}`}
      {...(onOpen === undefined ? { tabIndex: 0 } : { type: 'button' as const, onClick: onOpen })}
      aria-label={`Checks: ${read.said}${onOpen === undefined ? '' : ' — open the pull request'}`}
      onMouseEnter={tip.open}
      onFocus={tip.open}
      onMouseLeave={tip.close}
      onBlur={tip.close}
    >
      <Icon name="flask" size={14} />
      {read.badge !== null && <span className="ck-badge">{read.badge}</span>}
      {tip.at !== null && (
        <Tip at={tip.at}>
          <b>{read.said}</b>
          {shown.length > 0 && (
            <ul className="ck-list">
              {shown.map((check) => (
                <li key={check.name}>
                  <i className={`ck-dot ck-${check.status}`} />
                  <span>{check.name}</span>
                  <em>{checkWord(check, words)}</em>
                </li>
              ))}
            </ul>
          )}
          {rest > 0 && <span className="ck-more">{`and ${rest} more`}</span>}
          {checks.length === 0 && (
            <span className="ck-more">
              {pr.ciChecksWithheld === true
                ? 'The provider had the per-check detail and the policy withheld it.'
                : 'The provider reported no per-check detail, so this is the aggregate.'}
            </span>
          )}
          <span className="ck-foot">
            {pr.headSha !== undefined && `at ${pr.headSha.slice(0, 7)}`}
            {pr.headSha !== undefined && onOpen !== undefined && ' · '}
            {onOpen !== undefined && 'click for the whole reading'}
          </span>
        </Tip>
      )}
    </Tag>
  );
}
