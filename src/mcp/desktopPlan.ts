import { z } from 'zod';
import { validatePlanDocument } from '../plans/planDocument.js';
import { amendPlanInPlace, proposePlanAmendment } from '../plans/planAmendment.js';
import { issueOrigin, testPartNote } from '../plans/planning.js';
import { acceptanceCriteria, currentPlanSummary, planIssueNumber } from '../plans/parts.js';
import type { Plan } from '../types.js';
import { desktopIssueRef } from '../validation/desktop.js';
import { liveChecks } from '../validation/verdict.js';
import type { DesktopToolDeps, DesktopToolFactory } from './desktopContext.js';
import { PLAN_DOCUMENT_SHAPE } from './planDocumentSchema.js';
import { toolSchema } from './schema.js';
import { toolError, toolJson, type ToolCallResult } from './protocol.js';

// → docs/spec/11-mcp-tools.md

function decompositionFor(
  deps: DesktopToolDeps,
  issue: number,
): { ok: true; originRef: string; plan: Plan } | { ok: false; error: string } {
  const originRef = issueOrigin(issue);
  const plan = deps.store.plans.getPlanByOrigin(originRef);
  if (!plan) {
    return {
      ok: false,
      error:
        `Issue #${issue} has no plan. Nothing has been decomposed for it yet, so there is no verdict to ` +
        `discuss — say so rather than writing one, because a plan the harness never asked for is not a plan ` +
        `anybody is waiting to approve.`,
    };
  }
  return { ok: true, originRef, plan };
}

export const planRead: DesktopToolFactory = (deps) => ({
  description:
    "Read a goal's delivery plan: the planner's diagnosis and approach, the parts it splits the work into, " +
    'what it deliberately left out, what it is least sure about, and the validation checks it declared. Call ' +
    'this first when you are asked to discuss a plan — everything you need to argue with is in here, and the ' +
    'repository is open beside you to check it against.',
  inputSchema: toolSchema(z.object({ issue: z.number().describe('The goal number, e.g. 284.') })),
  handler: (args) => {
    const ref = desktopIssueRef(args);
    if (!ref.ok) return toolError(ref.error);
    const found = decompositionFor(deps, ref.issue);
    if (!found.ok) return toolError(found.error);
    const { plan, originRef } = found;
    if (deps.planWithheld(plan))
      return toolError(
        'This plan has not been revealed yet. It is withheld until the operator opens the goal in the ' +
          'cockpit and presses through the gate there — reading it aloud here would defeat that, which is ' +
          'the whole point of the gate. Ask them to reveal it first.',
      );

    const parts = deps.store.plans.listPlanParts(plan.id);
    const checks = liveChecks(deps.store.validation.listValidationChecks(originRef));
    return toolJson({
      issue: ref.issue,
      title: plan.title,
      status: plan.status,
      revisions: deps.store.plans.listPlanRevisions(plan.id).length,
      reason: plan.reason,
      diagnosis: plan.diagnosis,
      approach: plan.approach,
      risks: plan.risks,
      outOfScope: plan.outOfScope,
      alternatives: plan.alternatives,
      openQuestions: plan.openQuestions,
      verification: plan.verification,
      document: plan.document,
      parts: currentPlanSummary(plan, parts, deps.prRefStyle ?? '#'),
      acceptance: parts.map((p) => ({ slug: p.slug, criteria: acceptanceCriteria(p).map((c) => c.text) })),
      validation: checks.map((c) => ({ letter: c.letter, id: c.id, title: c.title, state: c.state })),
      ...testPartSection(deps),
      next: PLAN_READ_NEXT,
    });
  },
});

/**
 * The test-part bar, on the discuss surface. It is the same string the planning prompts are given,
 * because an agent that was never told a browser suite exists can only leave `coverage` out. What it
 * asks for is prose, so the bar is the whole of what this surface needs.
 * → docs/spec/08-planning.md#discussing-a-plan
 */
function testPartSection(deps: DesktopToolDeps): { testPart?: string } {
  const note = testPartNote(deps.environments).trim();
  return note === '' ? {} : { testPart: note };
}

function submittedPlanDocument(args: Record<string, unknown>): Record<string, unknown> {
  return {
    version: 1,
    reason: args.reason,
    diagnosis: args.diagnosis,
    approach: args.approach,
    risks: args.risks,
    outOfScope: args.outOfScope,
    alternatives: args.alternatives,
    openQuestions: args.openQuestions,
    verification: args.verification,
    evidence: args.evidence ?? [],
    document: args.document,
    parts: args.parts ?? [],
    validation: args.validation,
    watch: args.watch,
  };
}

export const planAmend: DesktopToolFactory = (deps) => ({
  description:
    'Rewrite the delivery plan for a goal after talking it through with the operator, as the whole document ' +
    'rather than a patch — keep every part slug you are not deliberately changing, since the slug is what an ' +
    'amendment merges on. Validated immediately: on rejection you get the reason back and can fix and ' +
    'resubmit in the same turn. This schedules nothing and stops nothing. On a plan still awaiting approval ' +
    'it replaces the plan the operator is about to answer for; on one already running it records a proposed ' +
    'change for them to accept — pass "note" saying why, and the plan keeps running either way until they do.',
  inputSchema: toolSchema(
    z.object({
      issue: z.number().describe('The goal number whose plan you are amending, e.g. 284.'),
      note: z
        .string()
        .describe(
          'Why the plan must change, in a few sentences. **Required on a plan that is already running**, ' +
            'where it is the whole of what the operator reads beside the diff — a change to a plan agents are ' +
            'working with no reason on it is one they cannot answer. Ignored on a plan still awaiting approval, ' +
            'which they read whole anyway.',
        )
        .optional(),
      ...PLAN_DOCUMENT_SHAPE,
    }),
  ),
  handler: async (args) => {
    const ref = desktopIssueRef(args);
    if (!ref.ok) return toolError(ref.error);
    const found = decompositionFor(deps, ref.issue);
    if (!found.ok) return toolError(found.error);
    const { plan } = found;

    if (plan.status === 'active') return amendRunningPlan(deps, plan, args);

    if (plan.status !== 'awaiting_approval') {
      return toolError(
        `The plan for issue #${ref.issue} is "${plan.status}", so it is not yours to amend: it is neither ` +
          `waiting on an approval you could rewrite nor running work a correction could be proposed against. ` +
          `Say that rather than writing over it.`,
      );
    }

    const parsed = validatePlanDocument(submittedPlanDocument(args));
    if (!parsed.ok) return toolError(`Plan rejected: ${parsed.error}`);

    const result = amendPlanInPlace(
      { store: deps.store, proposals: deps.proposals() },
      plan,
      parsed.document,
      'superseded by a discussion at the operator’s own keyboard',
    );
    await deps.runCycle();

    return toolJson({
      amended: true,
      issue: ref.issue,
      status: result.status,
      retired: result.retired,
      means:
        'the amended plan is recorded and the superseded approval card has been withdrawn. Nothing is ' +
        'scheduled and nothing more is yours to do here.',
      next:
        'Tell the operator, in your own words, that the plan is amended and waiting for them: they ' +
        'approve it in the LubbDubb cockpit, on the goal’s plan sheet, where "What changed" now shows ' +
        'this amendment against the version they were reading. Do not carry any of the work out — you ' +
        'were asked to argue about the plan, not to deliver it.',
    });
  },
});

function amendRunningPlan(deps: DesktopToolDeps, plan: Plan, args: Record<string, unknown>): ToolCallResult {
  const note = typeof args.note === 'string' ? args.note : '';
  const proposed = proposePlanAmendment(deps.store, {
    plan,
    document: submittedPlanDocument(args),
    note,
    author: 'operator',
    authorRef: null,
  });
  if (!proposed.ok) return toolError(proposed.error);

  return toolJson({
    proposed: true,
    issue: planIssueNumber(plan.originRef),
    amendmentId: proposed.proposed.amendment.id,
    changes: proposed.proposed.diff?.parts.filter((p) => p.kind !== 'unchanged').map((p) => `${p.kind} ${p.slug}`),
    ...(proposed.proposed.warnings.length > 0 ? { warnings: proposed.proposed.warnings } : {}),
    means:
      'the amendment is recorded and waiting on the operator. **The plan has not changed**: every part that ' +
      'was scheduling still is, no agent has been paused, stopped or re-dispatched, and nothing is ingested ' +
      'until they accept it.',
    next:
      'Tell them, in your own words, that the change is waiting for them in the cockpit — on the goal’s ' +
      'plan sheet, where it is drawn against the version they were reading — and that the plan carries on as ' +
      'it is meanwhile. Do not propose a second amendment; there can only be one pending, and a further ' +
      'change is folded into this one once they have answered.',
  });
}

const PLAN_READ_NEXT =
  'Argue with it. Check the diagnosis against the code, and say plainly where you think the split is wrong ' +
  'rather than agreeing with a plan you have not tested. When you and the operator have settled on a change, ' +
  'call plan_amend once with the whole document — every part you are keeping included, under its existing ' +
  'slug. What that does depends on "status" above, so read it before you tell them anything: on ' +
  '"awaiting_approval" the amended plan replaces the one they were about to answer for, and you send them ' +
  'to the cockpit to approve it; on "active" the plan is already running and your amendment is a proposal ' +
  'against it — pass "note" saying why, tell them it is waiting for them, and say plainly that nothing has ' +
  'stopped and nothing has changed until they accept it.';
