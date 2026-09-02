import { allGoalReach } from '../environments/reach.js';
import { validatePlanDocument } from '../plans/planDocument.js';
import { ingestPlanDocument } from '../plans/planIngest.js';
import { proposePlanAmendment } from '../plans/planAmendment.js';
import { issueOrigin } from '../plans/planning.js';
import { acceptanceCriteria, currentPlanSummary, planIssueNumber } from '../plans/parts.js';
import { planProposalRef } from '../proposals/proposals.js';
import type { LocalRunner } from '../localRun/runner.js';
import type { LocalRunWatch } from '../localRun/watch.js';
import { localRunIsLive } from '../store/localRuns.js';
import { retroDossier } from '../retro/dossier.js';
import { goalRecord } from '../retro/record.js';
import type { Plan } from '../types.js';
import {
  claimStaleBefore,
  desktopCheckRef,
  desktopCheckSummary,
  desktopIssueRef,
  findCheckByRef,
} from '../validation/desktop.js';
import { checkBriefing } from '../validation/fleet.js';
import { amendedReportReason, amendedSinceRunBegan, handbackReason, validateReport } from '../validation/report.js';
import { validationGoalDir } from '../validation/resources.js';
import { liveChecks } from '../validation/verdict.js';
import { proposalDecide, proposalRead, recoveryDecide } from './desktopInbox.js';
import {
  agentRead,
  attentionRead,
  escalationAnswer,
  fleetControl,
  fleetStatus,
  goalControl,
  queueControl,
} from './desktopOps.js';
import { agentControl, jobCreate } from './desktopWork.js';
import type { DesktopSession, DesktopToolDeps, DesktopToolFactory } from './desktopContext.js';
import { DESKTOP_TOOL_NAMES, type DesktopToolName } from './names.js';
import { PLAN_DOCUMENT_SCHEMA } from './planDocumentSchema.js';
import { toolError, toolJson, type McpTool, type ToolCallResult } from './protocol.js';

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

    session.held = { originRef: plan.originRef, checkId: wanted.id, claimedAt: claim.check.claimedAt };
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

    if (result !== 'handback' && amendedSinceRunBegan(check, held.claimedAt)) {
      session.held = null;
      return toolError(amendedReportReason(check));
    }

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
      parts: currentPlanSummary(plan, parts, deps.prRefStyle ?? '#'),
      acceptance: parts.map((p) => ({ slug: p.slug, criteria: acceptanceCriteria(p).map((c) => c.text) })),
      validation: checks.map((c) => ({ letter: c.letter, id: c.id, title: c.title, state: c.state })),
      next: PLAN_READ_NEXT,
    });
  },
});

/**
 * The document as the two paths both submit it — one object, built once.
 *
 * The awaiting-approval path validates it here and ingests it; the active path
 * hands it to {@link proposePlanAmendment}, which validates it before it writes.
 * Written out twice they would drift by a field — a `watch` block accepted on one
 * route and dropped on the other, with the schema advertising it on both and
 * nothing red — which is the same trap `PLAN_DOCUMENT_SCHEMA` exists to close on
 * the description side.
 */
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
    // Absent means "leave the existing checks alone"; `{checks: []}` would read
    // as withdrawing every one somebody is halfway through running.
    validation: args.validation,
    watch: args.watch,
  };
}

/**
 * Amend a plan — and **which of the two amendments this is depends on the plan's
 * status**, because the same conversation reaches both.
 *
 * `awaiting_approval` is a rewrite in place: nothing is scheduled off the plan
 * yet, the operator is about to answer for it, and the change belongs in the plan
 * they read. `active` is a proposal: parts are scheduling off a decision that has
 * already been taken, so the amended document waits in `plan_amendments` while the
 * plan carries on, and only the operator applies it
 * (`src/plans/planAmendment.ts` states why).
 *
 * The old refusal on anything but `awaiting_approval` sent the session to the
 * cockpit to replan, which was the wrong answer to the commonest case: a plan
 * whose split turned out wrong is not a plan whose *shape* needs re-deriving, and
 * a replan stops the whole goal to find that out.
 */
const planAmend: DesktopToolFactory = (deps) => ({
  description:
    'Rewrite the delivery plan for a goal after talking it through with the operator, as the whole document ' +
    'rather than a patch — keep every part slug you are not deliberately changing, since the slug is what an ' +
    'amendment merges on. Validated immediately: on rejection you get the reason back and can fix and ' +
    'resubmit in the same turn. This schedules nothing and stops nothing. On a plan still awaiting approval ' +
    'it replaces the plan the operator is about to answer for; on one already running it records a proposed ' +
    'change for them to accept — pass "note" saying why, and the plan keeps running either way until they do.',
  inputSchema: {
    ...PLAN_DOCUMENT_SCHEMA,
    properties: {
      issue: { type: 'number', description: 'The goal number whose plan you are amending, e.g. 284.' },
      note: {
        type: 'string',
        description:
          'Why the plan must change, in a few sentences. **Required on a plan that is already running**, ' +
          'where it is the whole of what the operator reads beside the diff — a change to a plan agents are ' +
          'working with no reason on it is one they cannot answer. Ignored on a plan still awaiting approval, ' +
          'which they read whole anyway.',
      },
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

    if (plan.status === 'active') return amendRunningPlan(deps, plan, args);

    // The gate the `/discuss` route used to make, kept where the write is. Every
    // other status is one where writing `awaiting_approval` back is wrong for a
    // reason of its own — a planner already holds a `planning` plan, and a
    // `complete` or `abandoned` one schedules nothing an amendment could keep
    // running — so the refusal names the status rather than pretending there is a
    // route.
    if (plan.status !== 'awaiting_approval') {
      return toolError(
        `The plan for issue #${ref.issue} is "${plan.status}", so it is not yours to amend: it is neither ` +
          `waiting on an approval you could rewrite nor running work a correction could be proposed against. ` +
          `Say that rather than writing over it.`,
      );
    }

    // Validated before anything is written, so a rejection leaves the plan graph
    // exactly as it was and the retry is against an unchanged plan.
    const parsed = validatePlanDocument(submittedPlanDocument(args));
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

/**
 * The running-plan half: a proposal, and **nothing else happens**.
 *
 * No cycle is run here, unlike the rewrite above. That one has to put a fresh
 * approval card up in place of the one it withdrew; this one adds a card the
 * `plan-amendment` rule raises on the next ordinary pulse, and nothing waits on
 * it — the plan is still scheduling, which is the point.
 */
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
    // Handed back so the session can tell the operator the change it actually
    // described rather than the one it meant to.
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

/**
 * What to do with what `plan_read` just returned — and it turns on `status`,
 * because `plan_amend` settles two different ways and a session that does not know
 * which one it is doing will describe the wrong one to the operator.
 *
 * Said here rather than left to the tool's own reply: by the time that is read the
 * write has happened, and "the plan is amended" told about a plan that is actually
 * still running unchanged is the one sentence this surface must not produce.
 */
const PLAN_READ_NEXT =
  'Argue with it. Check the diagnosis against the code, and say plainly where you think the split is wrong ' +
  'rather than agreeing with a plan you have not tested. When you and the operator have settled on a change, ' +
  'call plan_amend once with the whole document — every part you are keeping included, under its existing ' +
  'slug. What that does depends on "status" above, so read it before you tell them anything: on ' +
  '"awaiting_approval" the amended plan replaces the one they were about to answer for, and you send them ' +
  'to the cockpit to approve it; on "active" the plan is already running and your amendment is a proposal ' +
  'against it — pass "note" saying why, tell them it is waiting for them, and say plainly that nothing has ' +
  'stopped and nothing has changed until they accept it.';

const READ_NEXT =
  'Claim the one you are going to run with validation_claim before you start, then report it with ' +
  'validation_report. Checks marked actor "fleet" were handed to the harness\'s own agents — claiming one is ' +
  'still fine and takes it off them for as long as you hold it.';

/**
 * How this project starts on this machine.
 *
 * The instruction is the `local-run` prompt, rendered — so a deployment that has
 * written its own command down answers with it, and one that has not answers with
 * "work it out from the repository". Either way the session is told something
 * rather than left to guess in silence, which is the whole complaint this tool
 * exists for: a check that says "open the page and click the thing" is unrunnable
 * until somebody knows how to get the page up.
 *
 * **Not a field on `validation_read`.** That tool refuses a goal with no checks,
 * deliberately and with a reason worth keeping — and a goal with no checks is
 * exactly the goal somebody hits *run it locally* on. Two callers, one rendering,
 * no second copy of the text.
 *
 * The caution is *beside* the instruction rather than inside it, because the
 * template is operator-overridable and an override that never learned about the
 * worktree pool would drop the one sentence here that prevents a silent and
 * permanent failure: a process left holding a leased slot open stops that slot
 * ever being cleaned or handed on, and on Windows every later dispatch onto its
 * branch then fails `EBUSY` forever.
 */
const localRun: DesktopToolFactory = (deps) => ({
  description:
    "The machine's one dev environment: what is running in it, and — given a goal — start it on that " +
    "goal's code. Only one goal can be running locally at a time, so starting one stops whatever was " +
    'there. Given a message instead, it is typed into the session holding the environment — to run a ' +
    'migration, restart a service, or pick something up. Call it when somebody wants to look at a goal, ' +
    'or when a validation check cannot be carried out until the application is up.',
  inputSchema: {
    type: 'object',
    properties: {
      issue: {
        type: 'number',
        description:
          'Optional. The goal to start, e.g. 284 — **this stops whatever is running now**. Left out, ' +
          'nothing is started and the reply is just the state of the environment.',
      },
      message: {
        type: 'string',
        description:
          'Optional. Text for the session holding the running environment, e.g. "run the database ' +
          'migrations". Refused while nothing is running, while it is starting or stopping, or while ' +
          'the session is mid-turn. Not combined with `issue`.',
      },
    },
  },
  handler: async (args) => {
    const runner = deps.localRun();
    const watch = deps.localRunWatch();
    const message = typeof args.message === 'string' ? args.message : undefined;
    if (args.issue !== undefined && message !== undefined)
      return toolError(
        'Give one of `issue` or `message`: starting a goal and talking to the running one are two calls.',
      );
    if (message !== undefined) {
      const sent = runner.send(message);
      if (!sent.ok) return toolError(sent.error);
      return toolJson(describeRun(runner, watch));
    }
    if (args.issue === undefined) return toolJson(describeRun(runner, watch));
    const ref = desktopIssueRef(args);
    if (!ref.ok) return toolError(ref.error);
    const started = await runner.start(issueOrigin(ref.issue));
    // A refusal is the reason handed back rather than a throw: both are read by a
    // person, and "nothing is configured to start" is an answer.
    if (!started.ok) return toolError(started.error);
    return toolJson(describeRun(runner, watch));
  },
});

/**
 * The environment as a session reads it.
 *
 * **`running` is presumed, not probed** — and it says so, because the one thing a
 * session must not do is report a check passed against a page it never saw. The
 * watch's readings ride along: the declared port answering is a reading, and a
 * different claim from the application working. The output tail comes too, for the
 * same reason it is in the panel: the case worth explaining is the start that did
 * not work.
 */
function describeRun(runner: LocalRunner, watch: LocalRunWatch): Record<string, unknown> {
  const run = runner.current();
  if (run === null)
    return {
      running: false,
      note: 'Nothing has been started locally on this machine.',
    };
  const running = localRunIsLive(run);
  const readings = watch.reading();
  return {
    // Through `localRunIsLive`, not a fifth hand-written copy of which statuses count
    // — and `stopping` is one of them, so a session asking during a teardown is told
    // the environment is still up rather than that it is free to start another.
    running,
    goal: run.originRef,
    ref: run.ref,
    commit: run.commit,
    dir: run.dir,
    status: run.status,
    turn: runner.turn(),
    holdsSession: runner.holdsSession(),
    url: run.url,
    startedAt: run.startedAt,
    note: run.note,
    ports: running ? readings.ports : null,
    freshness: running ? readings.freshness : null,
    // The port may be probed; the application is not. The status means the session
    // that was told to bring it up finished without failing, and `ports.declared.answering`
    // means something accepted a TCP connection — neither is the page working, and
    // reporting a check passed on the strength of either would be the one outcome the
    // whole validation channel exists to prevent.
    caveat:
      'The harness probes the port but does not exercise the application: `running` means the session that ' +
      'brought it up did not fail, and `ports.declared.answering` means something accepted a connection. ' +
      'Open the URL and see for yourself before you report anything about it.',
    output: runner.output().slice(-40),
  };
}

/**
 * The registry, a `Record` over {@link DESKTOP_TOOL_NAMES} for the fleet
 * registry's reason: a name with no factory fails to build, and a factory cannot
 * name itself something the list never declared.
 */
/**
 * How far a question may reach back before the answer stops being about this run.
 *
 * The scratchpad and the retrospective are the two lists here with no cap of their
 * own — a pad is a conversation and a write-up is a document — and both are read
 * whole everywhere else because their readers were dispatched on the goal they
 * belong to. This reader was not: it is a session the operator opened to ask one
 * question, and a goal worked over three weeks by nine agents can carry a pad
 * longer than the answer. The tail is what is kept, for `retroDossier`'s reason:
 * the end of a run is what somebody is usually asking about.
 */
const MAX_PAD_ENTRIES = 40;

/**
 * The answer to "what happened here" — the whole record of one goal, for a
 * session that has to answer a question about it rather than act on it.
 *
 * **It is a read and only a read.** Every other tool on this channel is a step in
 * a job: claim this, report that, amend the plan, bring the application up. This
 * one settles nothing and schedules nothing, which is what lets it be the widest
 * read on the channel — an operator asking "why did this take four goes" or "is
 * it on hallway yet" is asking about rows the harness already holds, and the
 * failure worth preventing is not a write but an answer assembled from the
 * repository instead of the record.
 *
 * **The history comes back as the dossier the retrospective agent gets**, through
 * the same {@link goalRecord} read and the same {@link retroDossier} rendering
 * rather than a second account beside it. That is the point of the shared
 * assembly: a retrospective and an operator asking about the same run cannot be
 * given two different histories, and a prose account of a run is what a session
 * answering a question in prose actually needs.
 *
 * **What rides beside it is what the dossier does not carry**, and only that —
 * the issue's own text, the validation checks, where the work has reached, the
 * write-up if one exists, and the pad. The dossier already holds the plan, the
 * parts, the pull requests, the decisions, the escalations, the claims and the
 * verdicts; repeating any of them here would be two renderings of one row in one
 * reply, free to disagree by the next change to either.
 *
 * **An environment verdict is passed through three-valued.** `unknown` is not
 * folded into `absent` anywhere below: an expired credential, a probe that could
 * not run and work that genuinely has not shipped are different answers, and a
 * session told `absent` will say in the operator's own words that the work is not
 * deployed for a reason that has nothing to do with deployment.
 * → `docs/spec/24-environments.md#the-three-verdicts`
 */
const goalRead: DesktopToolFactory = (deps) => ({
  description:
    'Answer a question about a goal from what the harness actually recorded: the plan and its parts, every ' +
    'pull request opened for it and what became of each, what the dispatcher decided and when, what was ' +
    'escalated to a person, what agents concluded and what it cost, the validation checks and their ' +
    'readings, which environments the work has reached, the retrospective if one was written, and the notes ' +
    "agents left each other. Call this before answering anything about a goal's history or its state — the " +
    'repository shows what the code says now, and this is the only account of how it got there.',
  inputSchema: {
    type: 'object',
    properties: { issue: { type: 'number', description: 'The goal number, e.g. 284.' } },
    required: ['issue'],
  },
  handler: (args) => {
    const ref = desktopIssueRef(args);
    if (!ref.ok) return toolError(ref.error);
    const originRef = issueOrigin(ref.issue);
    const record = goalRecord(deps.store, originRef);
    const world = deps.store.getWorldBaseline();
    const issue = world?.issues.find((i) => i.number === ref.issue) ?? null;
    // Nothing recorded *and* nothing in the world is the one case worth refusing:
    // a number nobody has ever tracked is a typo far more often than it is a goal,
    // and an empty account of it reads as a goal nothing has happened on yet.
    if (issue === null && record.plan === null && record.decisions.length === 0) {
      return toolError(
        `The harness holds nothing about issue #${ref.issue} — no plan, no decisions, and the last world ` +
          `snapshot does not list it. Check the number: this is what an untracked issue looks like, not a ` +
          `goal nothing has happened on.`,
      );
    }

    const checks = liveChecks(deps.store.listValidationChecks(originRef));
    const retro = deps.store.getRetrospective(originRef);
    const pad = deps.store.listScratchEntries(originRef);
    return toolJson({
      issue: {
        number: ref.issue,
        ref: originRef,
        title: issue?.title ?? record.issueTitle,
        // The ticket's own words. A question about a goal is very often a question
        // about whether what was built is what was asked for, and the answer needs
        // both halves — the record below is only ever the second one.
        body: issue?.body ?? null,
        state: issue?.state ?? null,
        workItemState: issue?.workItemState ?? null,
        labels: issue?.labels ?? [],
        url: issue?.url ?? null,
      },
      // Said rather than implied: everything below the issue is a pulse-old
      // reading, and a session answering "has it shipped" needs to know it is
      // reading a snapshot rather than asking the provider.
      observedAt: world?.takenAt ?? null,
      record: retroDossier(record),
      validation: checks.map((c) => ({
        letter: c.letter,
        id: c.id,
        title: c.title,
        state: c.state,
        resultNote: c.resultNote,
        resultBy: c.resultBy,
        resultAt: c.resultAt,
      })),
      environments: goalEnvironments(deps, originRef),
      retrospective: retro === null ? null : { summary: retro.summary, document: retro.document },
      scratchpad: pad
        .slice(-MAX_PAD_ENTRIES)
        .map((e) => ({ at: e.createdAt, by: e.authorOriginRef, topic: e.topic, note: e.note })),
      next: GOAL_READ_NEXT,
    });
  },
});

/**
 * Where this goal's work has got to, in each environment the operator declared.
 *
 * The cockpit's own fold ({@link allGoalReach}), not a reading of the arrivals
 * table: the denominator is the goal's *work* rather than its merges, and a count
 * taken here would call a four-part plan arrived on the day its first part landed
 * — which is the mistake that fold exists to have already made once.
 * → `docs/spec/24-environments.md#the-lens`
 */
function goalEnvironments(deps: DesktopToolDeps, originRef: string): Record<string, unknown>[] {
  if (deps.environments.length === 0) return [];
  const reach = allGoalReach({
    landings: deps.store.listGoalLandings(),
    readings: deps.store.listEnvironmentReach(),
    nodes: deps.store.listWorkNodes(),
    landed: deps.store.landedPrs(),
    plans: deps.store.listPlans(),
    parts: deps.store.listAllPlanParts(),
    environments: deps.environments,
  }).find((g) => g.goalRef === originRef);
  return (reach?.environments ?? []).map((e) => ({
    environment: e.environment,
    // Verbatim, all three values. → the note on `goalRead`.
    status: e.status,
    landed: e.landed,
    total: e.total,
    at: e.at,
  }));
}

/**
 * What the reply says to do with itself.
 *
 * Two sentences and both are about honesty rather than procedure, because this is
 * the one tool on the channel whose output is read straight back to a person: the
 * record is what the harness saw, and the gap between that and what happened is
 * the thing a session is most likely to paper over when it is asked a question it
 * can nearly answer.
 */
const GOAL_READ_NEXT =
  'Answer from this. Where the record does not say — a decision nobody wrote down, a pull request the ' +
  'snapshot has aged out, an environment whose status is "unknown" — say that it does not say, rather than ' +
  'inferring it from the repository: the operator is asking what happened, and a plausible reconstruction ' +
  'is the one answer they cannot tell apart from the real one. "unknown" for an environment means the ' +
  'harness could not get an answer, which is not the same as the work not being there.';

const DESKTOP_TOOLS: Record<DesktopToolName, DesktopToolFactory> = {
  goal_read: goalRead,
  fleet_status: fleetStatus,
  fleet_control: fleetControl,
  attention_read: attentionRead,
  escalation_answer: escalationAnswer,
  agent_read: agentRead,
  queue_control: queueControl,
  goal_control: goalControl,
  proposal_read: proposalRead,
  proposal_decide: proposalDecide,
  recovery_decide: recoveryDecide,
  job_create: jobCreate,
  agent_control: agentControl,
  validation_read: validationRead,
  validation_claim: validationClaim,
  validation_report: validationReport,
  plan_read: planRead,
  plan_amend: planAmend,
  local_run: localRun,
};

export function buildDesktopTools(deps: DesktopToolDeps, session: DesktopSession): McpTool[] {
  return DESKTOP_TOOL_NAMES.map((name) => ({ name, ...DESKTOP_TOOLS[name](deps, session) }));
}
