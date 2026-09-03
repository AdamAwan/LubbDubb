import { localValidationBriefing } from '../../localValidation/briefing.js';
import {
  localValidationKey,
  localValidationOrigin,
  localValidationOutputDir,
  localValidationProfileDir,
} from '../../localValidation/origin.js';
import { substituteBrowserArgs } from '../../localValidation/policy.js';
import { validationRunStale } from '../../localValidation/stale.js';
import { issueWatchGateReason } from '../issuePickup.js';
import { liveChecks } from '../../validation/verdict.js';
import { readOnlyDispatch } from './readOnlyDispatch.js';
import { partBase } from '../../plans/parts.js';
import type { RawAction, StageContext } from './context.js';

/**
 * Send an agent to drive the machine's dev environment and say whether a goal's
 * changes actually work.
 *
 * **The operator's press is the whole gate.** There is no world signal here and no
 * standing condition: a row exists because somebody clicked, and this rule turns it
 * into an agent. Everything it checks is either that the click is still meaningful
 * or that the harness has not already acted on it.
 *
 * **It fires while the environment is still coming up**, which is the one thing
 * about its timing worth stating. A bring-up is minutes inside a single turn, and
 * the most useful work an agent can do in that window is read the diff and write a
 * test plan — so it is dispatched at the start of the wait rather than at the end of
 * it, and the prompt tells it to plan first and watch for the environment second.
 * Waiting for `running` would spend those minutes on nothing.
 *
 * **High in the pipeline, where `validate-check` is last.** That rule is a standing
 * obligation with no clock on it, and validation's promise that it blocks nothing
 * means it must never take the last slot from real work. This one is a person
 * waiting at a screen for something they asked for, with an environment already
 * burning on their machine — the same argument that puts `manual-job` at the front,
 * and it sits directly behind it.
 */
export function localValidation(s: StageContext): void {
  const { ctx } = s;
  for (const row of s.localValidations) {
    if (row.status !== 'pending') continue;

    // The environment the plan will be written against has to be the one that is
    // up. The desk asks this too, against the live store, and abandons the row —
    // this arm is what stops a dispatch racing that: between the operator swapping
    // the environment and the sweep noticing, nothing new is sent.
    if (validationRunStale(row, s.liveLocalRun) !== null) continue;
    const run = s.liveLocalRun;
    if (run === null) continue;
    // `stopping` is caught by the staleness check; what is left is a run that is on
    // its way up or already up, and both are worth dispatching into.
    if (run.status !== 'starting' && run.status !== 'running') continue;

    const parts = /^issue:(\d+)$/.exec(row.originRef);
    if (parts === null) continue;
    const issueNumber = Number(parts[1]);
    // `liveIssue` rather than the world's own list, so a retained run — a goal the
    // tracker has forgotten because a delivering PR closed it — is skipped. There
    // is nothing wrong with validating one, but every fact this rule appends comes
    // off a live ticket, and a stub carries none of them.
    const issue = s.liveIssue(issueNumber);
    if (issue === null) continue;
    if (issueWatchGateReason(issue, s.pickup) !== null) continue;

    const origin = localValidationOrigin(issueNumber, row.id);
    // One agent per row, and this is the near-side half of it: the far side is the
    // store's `WHERE status = 'pending'` on the dispatched flip, which is what makes
    // it true across a restart. There is deliberately **no cooldown budget** — a row
    // is one press of a button rather than a standing signal, and a press that could
    // not be dispatched this pulse is re-proposed next pulse until the operator
    // calls it off or the environment goes away. Both of those settle the row.
    if (s.activeOrigins.has(origin)) continue;

    const outputDir = localValidationOutputDir(s.validationRoot, row.originRef, row.id);
    const browser =
      s.localValidation.browser === null
        ? null
        : substituteBrowserArgs(s.localValidation.browser, {
            outputDir,
            profileDir: localValidationProfileDir(s.validationRoot),
          });

    const title = `Validate #${String(issueNumber)} locally`;
    const reason = `The operator asked for #${String(issueNumber)} to be validated against the local environment, which is running ${row.ref}.`;
    const plan = s.plansByOrigin.get(row.originRef) ?? null;
    s.candidates.push({
      origin,
      rule: 'local-validation',
      title,
      kind: 'code',
      branch: localValidationKey(issueNumber, row.id),
      reason,
      action: {
        type: 'dispatch_code_agent',
        // Read-only, and pinned to the **commit the environment stands at** rather
        // than to its branch. The branch moves — an agent could push to it while
        // this validation is running — and a plan written against a different tree
        // from the one being driven is the quiet version of the failure this whole
        // feature is built to avoid.
        ...readOnlyDispatch(localValidationKey(issueNumber, row.id), row.commit ?? row.ref),
        title,
        // Appended, never interpolated: the environment's URL, the operator's own
        // instruction and the rules of the run are the half the agent cannot act
        // without, and an override that predates any of them would drop it silently.
        prompt:
          s.templates.render('local-validation', { number: issueNumber, title: issue.title }) +
          localValidationBriefing({
            issue: { number: issueNumber, title: issue.title, body: issue.body },
            plan,
            parts: plan === null ? [] : (ctx.planParts ?? []).filter((part) => part.planId === plan.id),
            checks: liveChecks(s.validationChecks.get(row.originRef) ?? []),
            run,
            // What this branch was cut from, where the plan can say — so an agent
            // reading the diff knows which range is the change and which is
            // everything the branch inherited. Null on a goal with no plan, and on
            // one running from the integration branch, which is cut from nothing.
            base: partBaseOf(s, row.ref, issueNumber),
            instruction: s.localValidation.instruction,
            outputDir,
            browserKey: browser?.key ?? null,
          }),
        mcpServers: browser === null ? [] : [browser],
        localValidation: { id: row.id, as: 'validation' },
        originRef: origin,
        originTitle: issue.title,
        originSummary: issue.body,
        rule: 'local-validation',
        reason,
      } satisfies RawAction,
    });
  }
}

/**
 * The branch `ref` was cut from, as the plan sees it, or null.
 *
 * Asked through `partBase` rather than by reading a column, because "what is this
 * part stacked on" is a question about the plan's dependency graph and there is one
 * answer to it — the same one `plan-part` dispatches against. A ref that is not one
 * of this plan's parts is the integration branch or a goal's own branch, and
 * neither has a base worth stating.
 */
function partBaseOf(s: StageContext, ref: string, issueNumber: number): string | null {
  const all = s.ctx.planParts ?? [];
  const parts = all.filter((part) => part.branch === ref);
  const part = parts[0];
  if (part === undefined) return null;
  const index = new Map(all.filter((p) => p.planId === part.planId).map((p) => [p.slug, p]));
  const base = partBase(part, index, issueNumber, s.defaultBranch);
  return base === ref ? null : base;
}
