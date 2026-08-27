import { dispatchVerdict } from '../dispatchCooldown.js';
import { featureSummaryOrigin } from '../../summaries/featureSummary.js';
import type { RawAction, StageContext } from './context.js';

/**
 * Say where a Feature is, when something under it has moved.
 *
 * The feature board answers every question about a Feature except the one it is
 * opened with. This is the rule that dispatches the sentence — one desk agent per
 * Feature whose standing has changed since anybody last wrote about it.
 *
 * **The gate is a comparison, not an event.** `ctx.featureStandings` carries each
 * Feature's current digest and `ctx.featureSummaryKeys` what the summary on file
 * was written against; equal means nothing to say and no agent, for ever, at the
 * cost of one string comparison a pulse. What goes into the digest is
 * `featureStandingKey`'s to decide and is deliberately standings rather than text
 * — so a Feature is not re-summarised because somebody fixed a typo in a child's
 * title.
 *
 * **It reads no lens.** The digest arrives on the context already made; nothing
 * here touches `buildFeatureBoard`, and a rule that did would be a second opinion
 * about a Feature formed from a view built for a card.
 *
 * Ranked **last of every rule** — below even `validate-check`, which is otherwise
 * the bottom and says so — because it is the only rule in the book that produces
 * no work at all: validation is a reading somebody asked for, and this is a
 * paragraph about readings already taken. Nothing may wait behind it.
 *
 * Fails open and *silent*, `issue-retro`'s rule: nothing is gated on a summary, so
 * a spent cap costs the paragraph and nothing else. No escalation — there is
 * nothing a human can do about a summary that did not happen that they cannot do
 * by reading the board under it.
 */
export function featureSummary(s: StageContext): void {
  const { ctx } = s;
  const written = new Map((ctx.featureSummaryKeys ?? []).map((k) => [k.originRef, k.standingKey]));
  for (const feature of ctx.featureStandings ?? []) {
    const origin = featureSummaryOrigin(feature.number);
    if (written.get(`issue:${feature.number}`) === feature.key) continue;
    // A summariser already on this Feature is writing against the standing it will
    // read at submission, so a second one dispatched for the same movement would
    // write the same paragraph twice and pay for it twice.
    if (s.activeOrigins.has(origin)) continue;

    const verdict = dispatchVerdict(origin, s.now, ctx.recentDecisions, s.cooldown);
    if (verdict.kind === 'escalate' || verdict.kind === 'hold') continue;

    const title = `Summarise feature #${feature.number}`;
    const reason = `Work under feature #${feature.number} has moved since it was last summarised.`;
    s.candidates.push({
      origin,
      rule: 'feature-summary',
      title,
      kind: 'desk',
      // No branch and no worktree, `issue-retro`'s reason: it writes no files, and
      // a checkout would only be a temptation to start work on somebody's story.
      branch: null,
      reason,
      held: verdict.kind === 'cooldown' ? 'cooldown' : undefined,
      action: {
        type: 'dispatch_desk_agent',
        title,
        prompt: s.templates.render('feature-summary', { number: feature.number, title: feature.title }),
        originRef: origin,
        originTitle: feature.title,
        rule: 'feature-summary',
        reason,
      } satisfies RawAction,
    });
  }
}
