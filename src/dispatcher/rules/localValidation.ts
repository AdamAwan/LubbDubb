import { issueOriginNumber } from '../../issueOrigins.js';
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

// → docs/spec/05-dispatcher.md (rule `local-validation`)

export function localValidation(s: StageContext): void {
  const { ctx } = s;
  for (const row of s.localValidations) {
    if (row.status !== 'pending') continue;

    if (validationRunStale(row, s.liveLocalRun) !== null) continue;
    const run = s.liveLocalRun;
    if (run === null) continue;
    if (run.status !== 'starting' && run.status !== 'running') continue;

    const issueNumber = issueOriginNumber('root', row.originRef);
    if (issueNumber === null) continue;
    const issue = s.liveIssue(issueNumber);
    if (issue === null) continue;
    if (issueWatchGateReason(issue, s.pickup) !== null) continue;

    const origin = localValidationOrigin(issueNumber, row.id);
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
        ...readOnlyDispatch(localValidationKey(issueNumber, row.id), row.commit ?? row.ref),
        title,
        prompt:
          s.templates.render('local-validation', { number: issueNumber, title: issue.title }) +
          localValidationBriefing({
            issue: { number: issueNumber, title: issue.title, body: issue.body },
            plan,
            parts: plan === null ? [] : (ctx.planParts ?? []).filter((part) => part.planId === plan.id),
            checks: liveChecks(s.validationChecks.get(row.originRef) ?? []),
            run,
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

function partBaseOf(s: StageContext, ref: string, issueNumber: number): string | null {
  const all = s.ctx.planParts ?? [];
  const parts = all.filter((part) => part.branch === ref);
  const part = parts[0];
  if (part === undefined) return null;
  const index = new Map(all.filter((p) => p.planId === part.planId).map((p) => [p.slug, p]));
  const base = partBase(part, index, issueNumber, s.defaultBranch);
  return base === ref ? null : base;
}
