import { validatePlanDocument } from '../plans/planDocument.js';
import { ingestPlanDocument } from '../plans/planIngest.js';
import { issueOrigin } from '../plans/planning.js';
import { acceptanceCriteria, currentPlanSummary } from '../plans/parts.js';
import { planProposalRef } from '../proposals/proposals.js';
import type { ProposalDesk } from '../proposals/proposalDesk.js';
import type { Store } from '../store/store.js';
import type { Plan } from '../types.js';
import {
  claimStaleBefore,
  desktopCheckRef,
  desktopCheckSummary,
  desktopIssueRef,
  findCheckByRef,
} from '../validation/desktop.js';
import { checkBriefing } from '../validation/fleet.js';
import { handbackReason, validateReport } from '../validation/report.js';
import { validationGoalDir } from '../validation/resources.js';
import { liveChecks } from '../validation/verdict.js';
import { DESKTOP_TOOL_NAMES, type DesktopToolName } from './names.js';
import { PLAN_DOCUMENT_SCHEMA } from './planDocumentSchema.js';
import { toolError, toolJson, type McpTool } from './protocol.js';

/**
 * The five tools the operator's own Claude Code gets, and **only** these five.
 *
 * Narrowed by construction rather than by a filter over the fleet's set: there is
 * no code path from a desktop connection to `conclude_work`, `open_pr` or any of
 * the rest, because this module never reaches `buildTools` and the desktop server
 * never reaches anything else. That matters more here than it does for the fleet,
 * because this credential is long-lived, sits in the operator's home directory,
 * and is held by a session nobody dispatched — the blast radius of a filter that
 * stopped filtering would be the whole harness.
 *
 * Read a plan, argue with it, amend it; take one check, report what you saw. That
 * is the entire surface.
 *
 * **`plan_amend` is not `plan_submit`.** They write the same document through the
 * same `ingestPlanDocument`, and they share the schema as one export rather than
 * two literals — but the names differ on purpose, because `validation_report`
 * living on both channels is the trap this repo has already been caught by once:
 * an edit to "the plan tool" that silently reaches only one side. What differs
 * here is who may write and what settles afterwards — the fleet's is fenced by
 * the origin it was dispatched on, and this one by the plan's own status plus the
 * proposal it has to withdraw.
 */
export interface DesktopToolDeps {
  store: Store;
  /** `validation.desktopClaimMinutes`. */
  claimMinutes: number;
  /** `config.validationRoot` — where a goal's fixtures live, which the session has to be told. */
  validationRoot: string;
  /** `planning.requireApproval`, passed to ingestion exactly as `plan_submit` passes it. */
  requirePlanApproval?: boolean;
  /**
   * The proposal desk, lazily — an amendment has to withdraw the card the
   * operator would otherwise approve, and the desk is constructed after this
   * server in `system.ts`. Same thunk the fleet deps use for `filing`.
   */
  proposals(): ProposalDesk;
  /** A manual cycle, lazily and for the same reason: it is what puts the fresh card up. */
  runCycle(): Promise<void>;
  now(): string;
}

/**
 * What one desktop connection holds. Per-connection, not per-credential: two
 * terminals share one token, and a claim that belonged to the credential would
 * let the second report a reading against the first one's check.
 */
export interface DesktopSession {
  /** The label claims are taken under, as it appears in the cockpit. */
  label: string;
  /** The check this connection claimed, or null. Set by `validation_claim`. */
  held: { originRef: string; checkId: string } | null;
}

type DesktopToolFactory = (deps: DesktopToolDeps, session: DesktopSession) => Omit<McpTool, 'name'>;

/** The goal's validation plan, or the reason there isn't one to work from. */
function planFor(
  deps: DesktopToolDeps,
  issue: number,
): { ok: true; originRef: string; root: string } | { ok: false; error: string } {
  const origin = issueOrigin(issue);
  if (deps.store.listValidationChecks(origin).length === 0) {
    return {
      ok: false,
      error:
        `Issue #${issue} has no validation checks. Either nothing has been planned for it yet or the plan ` +
        `declared none — in both cases there is nothing here to run, and saying so is the whole answer.`,
    };
  }
  return { ok: true, originRef: origin, root: validationGoalDir(deps.validationRoot, origin) };
}

const validationRead: DesktopToolFactory = (deps) => ({
  description:
    "Read a goal's validation plan: the checks somebody has to actually carry out before the goal can be " +
    'called done, what each one asks for, and what has already been recorded about it. Call this first — with ' +
    'a check letter to get the full procedure for one, or without to see the whole list.',
  inputSchema: {
    type: 'object',
    properties: {
      issue: { type: 'number', description: 'The goal number, e.g. 284.' },
      check: {
        type: 'string',
        description:
          'Optional. A letter like "C", or a check id. Given, the reply carries that check\'s full procedure ' +
          'rather than a one-line summary.',
      },
    },
    required: ['issue'],
  },
  handler: (args) => {
    const ref = desktopIssueRef(args);
    if (!ref.ok) return toolError(ref.error);
    const plan = planFor(deps, ref.issue);
    if (!plan.ok) return toolError(plan.error);

    const now = deps.now();
    const checks = liveChecks(deps.store.listValidationChecks(plan.originRef));
    const summaries = checks.map((c) => desktopCheckSummary(c, now, deps.claimMinutes));
    if (typeof args.check !== 'string') {
      return toolJson({ issue: ref.issue, resourceRoot: plan.root, checks: summaries, next: READ_NEXT });
    }
    const wanted = findCheckByRef(checks, args.check);
    if (!wanted) {
      return toolError(
        `Issue #${ref.issue} has no live check "${args.check}". Its checks are: ` +
          `${summaries.map((s) => `${s.letter} (${s.id})`).join(', ') || 'none'}.`,
      );
    }
    return toolJson({
      issue: ref.issue,
      resourceRoot: plan.root,
      check: desktopCheckSummary(wanted, now, deps.claimMinutes),
      procedure: checkBriefing(wanted),
      next: READ_NEXT,
    });
  },
});

const validationClaim: DesktopToolFactory = (deps, session) => ({
  description:
    'Take one validation check so nothing else runs it while you do. Call this before you start carrying the ' +
    'procedure out, and report against it when you are done. Only one check can be claimed at a time across ' +
    'the whole harness — that is deliberate: there is one working copy, and two things running checks in it ' +
    'is the thing this prevents. Claiming also stops the fleet dispatching an agent for the same check.',
  inputSchema: {
    type: 'object',
    properties: {
      issue: { type: 'number', description: 'The goal number, e.g. 284.' },
      check: { type: 'string', description: 'A letter like "C", or a check id.' },
      as: {
        type: 'string',
        description:
          'Optional label for the claim, shown in the cockpit so the operator can see what is holding a check. ' +
          "Defaults to this session's own label.",
      },
    },
    required: ['issue', 'check'],
  },
  handler: (args) => {
    const ref = desktopCheckRef(args);
    if (!ref.ok) return toolError(ref.error);
    const plan = planFor(deps, ref.ref.issue);
    if (!plan.ok) return toolError(plan.error);

    const checks = liveChecks(deps.store.listValidationChecks(plan.originRef));
    const wanted = findCheckByRef(checks, ref.ref.check);
    if (!wanted) {
      return toolError(
        `Issue #${ref.ref.issue} has no live check "${ref.ref.check}". Call validation_read on the issue to see ` +
          `what it does have.`,
      );
    }
    // A settled check is somebody's answer. Re-running one is a legitimate thing
    // to want and an illegitimate thing to do by accident, so it goes through the
    // cockpit's reset — the same refusal the hand-over route makes, for the same
    // reason: an agent must not overwrite a reading nobody asked it to re-take.
    if (wanted.state !== 'unrun') {
      return toolError(
        `Check ${wanted.letter} on issue #${ref.ref.issue} already reads "${wanted.state}"${
          wanted.resultNote === null ? '' : ` — ${wanted.resultNote}`
        }. Somebody has recorded an answer for it. If it needs running again, reset it in the cockpit first; ` +
          `taking a reading over the top of one you were not asked to re-take is what this refuses.`,
      );
    }

    const label = typeof args.as === 'string' && args.as.trim() ? args.as.trim() : session.label;
    const staleBefore = claimStaleBefore(deps.now(), deps.claimMinutes);
    const claim = deps.store.claimValidationCheck(plan.originRef, wanted.id, label, staleBefore);
    if (!claim.ok) {
      if (claim.reason === 'gone') {
        return toolError(
          `Check "${wanted.id}" was withdrawn from issue #${ref.ref.issue}'s plan just now. Nothing is claimed.`,
        );
      }
      const held = claim.by;
      return toolError(
        `Check ${held.letter} ("${held.title}") is already claimed by ${held.claimedBy}, and only one check can ` +
          `be claimed at a time — there is one working copy, and this is what stops two things reaching for it. ` +
          `Finish that one and report it, or hand it back with validation_report if it cannot be run. A claim ` +
          `nobody releases expires on its own after ${deps.claimMinutes} minutes.`,
      );
    }

    session.held = { originRef: plan.originRef, checkId: wanted.id };
    return toolJson({
      claimed: `${claim.check.letter}. ${claim.check.id}`,
      as: label,
      tookOverFrom: claim.tookOverFrom,
      resourceRoot: plan.root,
      procedure: checkBriefing(claim.check),
      // Said rather than assumed, because this is the one place a desktop session
      // could quietly do the wrong thing: it has the repository open and every
      // means to make a check pass instead of running it.
      next:
        'Carry the procedure out for real — open the thing, click the thing, look at what happens. Then call ' +
        'validation_report once with what you saw. Do not change code to make a check pass: this check is the ' +
        'reading, not the work, and a goal it should have flagged is the cost of getting that wrong. If you ' +
        'cannot run it — no login, no environment, no browser — report "handback" and say why.',
    });
  },
});

const validationReport: DesktopToolFactory = (deps, session) => ({
  description:
    'Record what you saw when you ran the check you claimed. Say "passed" or "failed" only if you actually ' +
    'carried the procedure out; a green build, a merged pull request or code that looks correct are none of ' +
    'them this check, which exists precisely because those had already happened. If you could not run it, say ' +
    '"handback" and why — that records no result and gives the check back, and it is the right answer rather ' +
    'than a last resort.',
  inputSchema: {
    type: 'object',
    properties: {
      result: {
        type: 'string',
        enum: ['passed', 'failed', 'handback'],
        description:
          '"passed" — you followed the procedure and saw what it expects. "failed" — you followed it and did ' +
          'not; a real finding about the goal. "handback" — you could not run it, so nothing is recorded.',
      },
      note: {
        type: 'string',
        description:
          'What you actually saw, or what stopped you. This is the whole of what somebody reads later instead ' +
          'of running the check again, so "passed" is not a note.',
      },
    },
    required: ['result', 'note'],
  },
  handler: (args) => {
    // The check is not an argument here either — it is whatever this session
    // claimed. The fleet's version takes it from the origin it was dispatched on;
    // both are the same rule, that which check a report is about is decided
    // before the report rather than by it.
    const held = session.held;
    if (!held) {
      return toolError(
        'You have not claimed a check in this session, so there is nothing to report on. Call validation_claim ' +
          'with the issue and check first — that is also what stops the fleet running it underneath you. If you ' +
          'claimed one earlier and this connection has since restarted, claim it again; taking a claim you ' +
          'already hold is not a conflict.',
      );
    }
    const check = deps.store.getValidationCheck(held.originRef, held.checkId);
    if (!check) {
      session.held = null;
      return toolError(
        `Check "${held.checkId}" is no longer part of its plan — an amendment withdrew it while you were ` +
          'running it. Nothing was recorded, and nothing more is needed on it.',
      );
    }
    const parsed = validateReport(args);
    if (!parsed.ok) return toolError(`Report rejected: ${parsed.error}`);
    const { result, note } = parsed.report;

    if (result === 'handback') {
      const next = deps.store.recordValidationHandback(held.originRef, check.id, handbackReason(note, 'desktop'));
      session.held = null;
      return toolJson({
        reported: 'handback',
        check: `${check.letter}. ${check.id}`,
        // Stated rather than inferred from a bare "ok": a session told only that
        // the call succeeded would reasonably believe it had settled the check.
        state: next?.state ?? check.state,
        means:
          'no result was recorded, the claim is released and your reason is on the row. The state is unchanged, ' +
          'which is the honest answer — you did not find anything out about the goal.',
      });
    }

    const next = deps.store.recordValidationResult(held.originRef, check.id, {
      state: result,
      note,
      // Neither `operator` nor `agent`: nobody dispatched this, and nobody
      // carried out the steps by hand. The cockpit draws the difference because
      // a reader deciding whether to re-run a check before closing a goal is
      // deciding on exactly this.
      by: 'desktop',
    });
    session.held = null;
    if (!next) {
      return toolError(
        `Check "${check.id}" could not be written — its plan withdrew it. Nothing was recorded, and nothing ` +
          'more is needed on it.',
      );
    }
    return toolJson({
      reported: next.state,
      check: `${check.letter}. ${check.id}`,
      recordedBy: 'desktop',
      means:
        'the operator sees this reading marked as one taken from a desktop session rather than by hand. If you ' +
        'did not actually carry the procedure out, say so now — a pass nobody ran is the one outcome this ' +
        'check exists to prevent.',
    });
  },
});

/** The plan for a goal, or the reason there is not one to talk about. */
function decompositionFor(
  deps: DesktopToolDeps,
  issue: number,
): { ok: true; originRef: string; plan: Plan } | { ok: false; error: string } {
  const originRef = issueOrigin(issue);
  const plan = deps.store.getPlanByOrigin(originRef);
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

const planRead: DesktopToolFactory = (deps) => ({
  description:
    "Read a goal's delivery plan: the planner's diagnosis and approach, the parts it splits the work into, " +
    'what it deliberately left out, what it is least sure about, and the validation checks it declared. Call ' +
    'this first when you are asked to discuss a plan — everything you need to argue with is in here, and the ' +
    'repository is open beside you to check it against.',
  inputSchema: {
    type: 'object',
    properties: { issue: { type: 'number', description: 'The goal number, e.g. 284.' } },
    required: ['issue'],
  },
  handler: (args) => {
    const ref = desktopIssueRef(args);
    if (!ref.ok) return toolError(ref.error);
    const found = decompositionFor(deps, ref.issue);
    if (!found.ok) return toolError(found.error);
    const { plan, originRef } = found;

    const parts = deps.store.listPlanParts(plan.id);
    const checks = liveChecks(deps.store.listValidationChecks(originRef));
    return toolJson({
      issue: ref.issue,
      title: plan.title,
      status: plan.status,
      // The count rather than the revisions themselves: a plan replanned three
      // times carries three write-ups, and a session that has to read all of them
      // before it can say anything is the friction this whole surface removes.
      revisions: deps.store.listPlanRevisions(plan.id).length,
      reason: plan.reason,
      diagnosis: plan.diagnosis,
      approach: plan.approach,
      risks: plan.risks,
      outOfScope: plan.outOfScope,
      alternatives: plan.alternatives,
      // The planner's own nomination of what to argue about. Named as such in the
      // reply because it is the agenda the operator opened this conversation on.
      openQuestions: plan.openQuestions,
      verification: plan.verification,
      document: plan.document,
      // The same rendering a replanning agent is given, rather than a second one:
      // it carries each part's slug, which is the merge key an amendment turns on.
      parts: currentPlanSummary(plan, parts),
      acceptance: parts.map((p) => ({ slug: p.slug, criteria: acceptanceCriteria(p).map((c) => c.text) })),
      validation: checks.map((c) => ({ letter: c.letter, id: c.id, title: c.title, state: c.state })),
      next: PLAN_READ_NEXT,
    });
  },
});

const planAmend: DesktopToolFactory = (deps) => ({
  description:
    'Rewrite the delivery plan for a goal after talking it through with the operator, as the whole document ' +
    'rather than a patch — keep every part slug you are not deliberately changing, since the slug is what an ' +
    'amendment merges on. Validated immediately: on rejection you get the reason back and can fix and ' +
    'resubmit in the same turn. This schedules nothing; it puts the amended plan back in front of the ' +
    'operator to approve.',
  inputSchema: {
    ...PLAN_DOCUMENT_SCHEMA,
    properties: {
      issue: { type: 'number', description: 'The goal number whose plan you are amending, e.g. 284.' },
      ...((PLAN_DOCUMENT_SCHEMA.properties ?? {}) as Record<string, unknown>),
    },
    required: ['issue', ...((PLAN_DOCUMENT_SCHEMA.required ?? []) as string[])],
  },
  handler: async (args) => {
    const ref = desktopIssueRef(args);
    if (!ref.ok) return toolError(ref.error);
    const found = decompositionFor(deps, ref.issue);
    if (!found.ok) return toolError(found.error);
    const { plan, originRef } = found;

    // The gate the `/discuss` route used to make, kept where the write is. A
    // *released* plan has been through approval and its parts are scheduling;
    // writing `awaiting_approval` back over it reopens a gate `plan-part` had
    // cleared, and stops the rest of the work for a conversation nobody asked to
    // be a hold. The cockpit only offers Discuss on an awaiting plan, so this
    // agrees with the button rather than surprising it.
    if (plan.status !== 'awaiting_approval') {
      return toolError(
        `The plan for issue #${ref.issue} is "${plan.status}", not awaiting approval, so it is not yours to ` +
          `amend: an operator has already decided about it and its parts schedule off that decision. If it ` +
          `needs to change, they replan it from the cockpit — say that rather than writing over it.`,
      );
    }

    // Validated before anything is written, so a rejection leaves the plan graph
    // exactly as it was and the retry is against an unchanged plan.
    const parsed = validatePlanDocument({
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
      // Absent means "leave the existing checks alone"; `{checks: []}` would read
      // as withdrawing every one somebody is halfway through running.
      validation: args.validation,
    });
    if (!parsed.ok) return toolError(`Plan rejected: ${parsed.error}`);

    // The card the operator would otherwise walk back to is now about a plan that
    // no longer exists, and `plan-approval` is held off this plan for as long as a
    // pending one sits there — so an amendment that left it up would send them to
    // approve the *pre-discussion* decomposition, and release parts its reader
    // never saw.
    //
    // **The status write comes first, exactly as it does in the replan route.**
    // `refusePlan` settles a plan that is still `awaiting_approval`: it would
    // retire every unstarted part and send the plan back to a planner, which is
    // the opposite of what withdrawing a superseded card means. Out of that
    // status it is a no-op, and the rejection is only the inbox item closing.
    // Ingestion writes `awaiting_approval` back a few lines below, and store
    // writes are synchronous, so no pulse can observe the gap.
    const pending = deps.store
      .listProposals()
      .find((p) => p.kind === 'plan' && p.ref === planProposalRef(originRef) && p.status === 'pending');
    if (pending) {
      deps.store.setPlanStatus(plan.id, 'planning');
      deps.proposals().reject(pending.id, 'superseded by a discussion at the operator’s own keyboard');
    }

    const result = ingestPlanDocument(deps.store, {
      doc: parsed.document,
      originRef,
      title: plan.title,
      requireApproval: deps.requirePlanApproval,
    });
    // The card goes back up on a pulse, and an operator told to go and approve
    // something wants it there when they look rather than at the next heartbeat.
    await deps.runCycle();

    return toolJson({
      amended: true,
      issue: ref.issue,
      status: result.status,
      retired: result.retired,
      // Stated rather than left to be read off the status, for `validation_report`'s
      // reason: a session told only that the call succeeded would reasonably
      // believe it had finished the job.
      means:
        result.status === 'awaiting_approval'
          ? 'the amended plan is recorded and the superseded approval card has been withdrawn. Nothing is ' +
            'scheduled and nothing more is yours to do here.'
          : 'the amended plan is recorded and released — this deployment does not require approval, so its ' +
            'parts schedule from the next pulse.',
      next:
        result.status === 'awaiting_approval'
          ? 'Tell the operator, in your own words, that the plan is amended and waiting for them: they ' +
            'approve it in the LubbDubb cockpit, on the goal’s plan sheet, where "What changed" now shows ' +
            'this amendment against the version they were reading. Do not carry any of the work out — you ' +
            'were asked to argue about the plan, not to deliver it.'
          : 'Tell the operator the plan is amended and already released. Do not carry any of the work out ' +
            'yourself — the fleet schedules it from here.',
    });
  },
});

const PLAN_READ_NEXT =
  'Argue with it. Check the diagnosis against the code, and say plainly where you think the split is wrong ' +
  'rather than agreeing with a plan you have not tested. When you and the operator have settled on a change, ' +
  'call plan_amend once with the whole document — every part you are keeping included, under its existing ' +
  'slug — and then stop and send them back to the cockpit to approve it.';

const READ_NEXT =
  'Claim the one you are going to run with validation_claim before you start, then report it with ' +
  'validation_report. Checks marked actor "fleet" were handed to the harness\'s own agents — claiming one is ' +
  'still fine and takes it off them for as long as you hold it.';

/**
 * The registry, a `Record` over {@link DESKTOP_TOOL_NAMES} for the fleet
 * registry's reason: a name with no factory fails to build, and a factory cannot
 * name itself something the list never declared.
 */
const DESKTOP_TOOLS: Record<DesktopToolName, DesktopToolFactory> = {
  validation_read: validationRead,
  validation_claim: validationClaim,
  validation_report: validationReport,
  plan_read: planRead,
  plan_amend: planAmend,
};

export function buildDesktopTools(deps: DesktopToolDeps, session: DesktopSession): McpTool[] {
  return DESKTOP_TOOL_NAMES.map((name) => ({ name, ...DESKTOP_TOOLS[name](deps, session) }));
}
