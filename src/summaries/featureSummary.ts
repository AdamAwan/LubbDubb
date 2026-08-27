/**
 * The feature summary's pure layer — what a summary is, whose it is, and when the
 * one on file has stopped describing the Feature.
 *
 * ## The gap this closes
 *
 * The feature board ships facts: a bar, six counts, three bounded lists of
 * quotations and a row per child. Every one of them is true and none of them
 * answers the question a Feature is actually opened with — *where is this?* A
 * reader assembles that themselves, out of a hatched bar and an assessor's
 * sentence about a bucket mask, and two people reading the same card reach
 * different answers. This is the sentence a developer would say instead.
 *
 * **It is prose, and the board is not.** `buildFeatureBoard` deliberately ships no
 * verdict about a Feature — no "at risk", no percent, no forecast — because each
 * would be a policy no config file states and no module owns. Nothing here changes
 * that: a summary is one agent's account, written in its own voice, stored against
 * the Feature and quoted on the board exactly as a delivery's summary is. The
 * board still composes no sentence of its own.
 *
 * ## Why the trigger is a standing key rather than an event
 *
 * The obvious trigger is "re-summarise when something happened", and the obvious
 * implementation of that is a hook on the thing that happened — which loses the
 * summary to any restart that straddles it, and asks the harness to keep a
 * per-reader "since you last looked" it has no honest source for. So the trigger
 * is a *comparison*: {@link featureStandingKey} digests where every child stands,
 * the summary stores the key it was written against, and rule `feature-summary`
 * dispatches when the two differ. A pulse that finds them equal does nothing, for
 * ever, at the cost of one string comparison.
 *
 * What the key is built from is the whole of the policy, and it is **standings,
 * never text**: the tracker's state, the verdicts standing on each child, the runs
 * in flight and the landings. Not `changedAt` — a title tweak or a comment moves
 * that, and re-writing a Feature's summary because somebody fixed a typo in a
 * child's title is an agent spent on nothing. An item *moving* is what the summary
 * is about.
 *
 * ## Why nothing gates on it
 *
 * `issue-retro`'s answer, one tier up: a Feature is exactly as delivered with no
 * summary as with one. So a missing summary is silence rather than a hold, which
 * is what makes rule `feature-summary`'s fail-open cheap — an agent that crashes,
 * is killed or spends its attempt cap costs the paragraph and nothing else, and no
 * escalation is raised, because there is nothing a human can do about a summary
 * that did not happen that they cannot do by reading the board under it.
 *
 * → `docs/spec/17-cockpit.md#the-feature-summary`
 */

import { createHash } from 'node:crypto';

/** The lede: the two or three sentences a card is read for. Required. */
const MAX_STANDING = 1_200;

/**
 * Each of the three sections below it. Longer than the lede because one may need
 * to name several goals, and short enough that the card stays a card — a summary
 * nobody finishes reading is the board's own failure repeated in prose.
 */
const MAX_SECTION = 2_000;

/**
 * The origin a feature-summary agent is dispatched on.
 *
 * `retroOrigin`'s shape and its reason: the cooldown and attempt cap that throttle
 * summaries must be independent of anything else keyed on the container, or a
 * looping summariser would eat a budget that gets work done. A Feature is a
 * tracker item like any other, so the root is `issue:<n>` and the summary is the
 * arm.
 */
export function featureSummaryOrigin(featureNumber: number): string {
  return `issue:${featureNumber}:summary`;
}

/**
 * Which Feature this caller may summarise, refusing every other origin by name and
 * with the tool it actually wants.
 *
 * Structural identity, as for every other write in the channel: the credential
 * decides the subject, so an agent cannot summarise a Feature it was not sent to —
 * and a working agent, which has an opinion about one goal and no view of the rest,
 * cannot write the Feature's account of itself at all.
 */
export function featureSummarySubmitOrigin(
  originRef: string | null,
): { ok: true; featureOrigin: string; featureNumber: number } | { ok: false; error: string } {
  const match = originRef ? /^issue:(\d+):summary$/.exec(originRef) : null;
  if (match) {
    const number = Number(match[1]);
    return { ok: true, featureOrigin: `issue:${number}`, featureNumber: number };
  }
  return {
    ok: false,
    error:
      `feature_summary is only for the agent dispatched to summarise a Feature, and this task's origin ` +
      `is ${originRef ?? '(none)'}. If you were sent to write up a goal that has been delivered, use ` +
      `retro_submit; if you are finishing work on an issue, use conclude_work.`,
  };
}

/** What a submission is allowed to be — the four fields the card draws. */
export interface FeatureSummaryInput {
  standing: string;
  usable: string | null;
  blocked: string | null;
  remaining: string | null;
}

/**
 * What a submission is allowed to be.
 *
 * `standing` is **required and refused when missing** (`validateRetrospective`'s
 * rule): it is the whole of what the card draws before anything is expanded, and a
 * summary whose lede is empty has not been written. The other three are **optional
 * and trimmed rather than refused**: a Feature with nothing usable yet, nothing
 * blocked and nothing left are each ordinary states, and an empty section is the
 * honest reading of one — where a section invented to fill the shape is exactly
 * the sentence this whole feature exists to keep off the board.
 */
export function validateFeatureSummary(
  args: Record<string, unknown>,
): { ok: true; input: FeatureSummaryInput; trimmed: boolean } | { ok: false; error: string } {
  const standing = text(args.standing);
  if (!standing) {
    return {
      ok: false,
      error:
        'standing is required: two or three sentences saying where this Feature actually is — what ' +
        'works, what it is waiting on, and what a reader should take away. It is the whole of what the ' +
        'card shows before anything is opened.',
    };
  }
  if (standing.length > MAX_STANDING) {
    return {
      ok: false,
      error: `standing is too long (${standing.length} chars, max ${MAX_STANDING}). The sections below it carry the detail.`,
    };
  }
  const sections = [text(args.usable), text(args.blocked), text(args.remaining)];
  const trimmed = sections.some((s) => s !== null && s.length > MAX_SECTION);
  const [usable = null, blocked = null, remaining = null] = sections.map((s) =>
    s === null ? null : s.slice(0, MAX_SECTION),
  );
  return { ok: true, input: { standing, usable, blocked, remaining }, trimmed };
}

function text(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value ? value : null;
}

/** Where one child of a Feature stands, as the key is allowed to see it. */
export interface FeatureChildStandingFacts {
  number: number;
  /** The tracker's own two words, and its native state where it has one. */
  state: string;
  workItemState: string | null;
  /** When the standing verdict on this child was cast, either way. Null for neither. */
  deliveredAt: string | null;
  shortfallAt: string | null;
  /** When a run the harness has not finished started, or null for nothing in flight. */
  runningSince: string | null;
  /** When this goal last landed a commit, or null for one that has landed nothing. */
  landedAt: string | null;
}

/**
 * The digest rule `feature-summary` compares against the one on file.
 *
 * Order-independent by construction — the lines are sorted before they are hashed
 * — because the mirror's row order is `number DESC` today and is not a thing this
 * comparison may rest on: a re-ordered read that re-summarised every Feature would
 * look exactly like the whole tracker moving at once.
 *
 * A hash rather than the lines themselves, for one reason: it is stored on every
 * summary row, and a Feature with forty children would otherwise put a few
 * kilobytes of standing in the database per write to answer a question that is
 * only ever "is this the same".
 */
export function featureStandingKey(children: readonly FeatureChildStandingFacts[]): string {
  const lines = children
    .map((c) =>
      [
        c.number,
        c.state,
        c.workItemState ?? '',
        c.deliveredAt ?? '',
        c.shortfallAt ?? '',
        c.runningSince ?? '',
        c.landedAt ?? '',
      ].join(' '),
    )
    .sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 32);
}
