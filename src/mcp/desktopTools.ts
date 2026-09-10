import { z } from 'zod';
import { allGoalReach } from '../environments/reach.js';
import { DESKTOP_EJECTION_TOOLS } from './desktopEjection.js';
import { DESKTOP_SEQUENCE_TOOLS } from './desktopSequence.js';
import { validatePlanDocument } from '../plans/planDocument.js';
import { amendPlanInPlace, proposePlanAmendment } from '../plans/planAmendment.js';
import { issueOrigin } from '../plans/planning.js';
import { acceptanceCriteria, currentPlanSummary, planIssueNumber } from '../plans/parts.js';
import { describeLocalRun } from '../localRun/describe.js';
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
  humanTaskSettle,
  queueControl,
} from './desktopOps.js';
import { agentControl, jobCreate } from './desktopWork.js';
import { goalGate, goalInstruct, goalPlacement } from './desktopGoal.js';
import type { DesktopSession, DesktopToolDeps, DesktopToolFactory } from './desktopContext.js';
import { DESKTOP_TOOL_NAMES, type DesktopToolName } from './names.js';
import { PLAN_DOCUMENT_SHAPE } from './planDocumentSchema.js';
import { toolSchema } from './schema.js';
import { toolError, toolJson, type McpTool, type ToolCallResult } from './protocol.js';

// → docs/spec/11-mcp-tools.md

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
  inputSchema: toolSchema(
    z.object({
      issue: z.number().describe('The goal number, e.g. 284.'),
      check: z
        .string()
        .describe(
          'Optional. A letter like "C", or a check id. Given, the reply carries that check\'s full procedure ' +
            'rather than a one-line summary.',
        )
        .optional(),
    }),
  ),
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
  inputSchema: toolSchema(
    z.object({
      issue: z.number().describe('The goal number, e.g. 284.'),
      check: z.string().describe('A letter like "C", or a check id.'),
      as: z
        .string()
        .describe(
          'Optional label for the claim, shown in the cockpit so the operator can see what is holding a check. ' +
            "Defaults to this session's own label.",
        )
        .optional(),
    }),
  ),
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
  inputSchema: toolSchema(
    z.object({
      result: z
        .enum(['passed', 'failed', 'handback'])
        .describe(
          '"passed" — you followed the procedure and saw what it expects. "failed" — you followed it and did ' +
            'not; a real finding about the goal. "handback" — you could not run it, so nothing is recorded.',
        ),
      note: z
        .string()
        .describe(
          'What you actually saw, or what stopped you. This is the whole of what somebody reads later instead ' +
            'of running the check again, so "passed" is not a note.',
        ),
    }),
  ),
  handler: (args) => {
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
        state: next?.state ?? check.state,
        means:
          'no result was recorded, the claim is released and your reason is on the row. The state is unchanged, ' +
          'which is the honest answer — you did not find anything out about the goal.',
      });
    }

    const next = deps.store.recordValidationResult(held.originRef, check.id, {
      state: result,
      note,
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
  inputSchema: toolSchema(z.object({ issue: z.number().describe('The goal number, e.g. 284.') })),
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
      revisions: deps.store.listPlanRevisions(plan.id).length,
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
      next: PLAN_READ_NEXT,
    });
  },
});

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

const planAmend: DesktopToolFactory = (deps) => ({
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

    const parsed = validatePlanDocument(submittedPlanDocument(args), deps.store.listOfferedAreas());
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

const READ_NEXT =
  'Claim the one you are going to run with validation_claim before you start, then report it with ' +
  'validation_report. Checks marked actor "fleet" were handed to the harness\'s own agents — claiming one is ' +
  'still fine and takes it off them for as long as you hold it.';

const localRun: DesktopToolFactory = (deps) => ({
  description:
    "The machine's one dev environment: what is running in it, and — given a goal — start it on that " +
    "goal's code. Only one goal can be running locally at a time, so starting one stops whatever was " +
    'there. Given a message instead, it is typed into the session holding the environment — to run a ' +
    'migration, restart a service, or pick something up. Call it when somebody wants to look at a goal, ' +
    'or when a validation check cannot be carried out until the application is up.',
  inputSchema: toolSchema(
    z.object({
      issue: z
        .number()
        .describe(
          'Optional. The goal to start, e.g. 284 — **this stops whatever is running now**. Left out, ' +
            'nothing is started and the reply is just the state of the environment.',
        )
        .optional(),
      message: z
        .string()
        .describe(
          'Optional. Text for the session holding the running environment, e.g. "run the database ' +
            'migrations". Refused while nothing is running, while it is starting or stopping, or while ' +
            'the session is mid-turn. Not combined with `issue`.',
        )
        .optional(),
    }),
  ),
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
      return toolJson(describeLocalRun(runner, watch));
    }
    if (args.issue === undefined) return toolJson(describeLocalRun(runner, watch));
    const ref = desktopIssueRef(args);
    if (!ref.ok) return toolError(ref.error);
    const started = await runner.start(issueOrigin(ref.issue));
    if (!started.ok) return toolError(started.error);
    return toolJson(describeLocalRun(runner, watch));
  },
});

const MAX_PAD_ENTRIES = 40;

const goalRead: DesktopToolFactory = (deps) => ({
  description:
    'Answer a question about a goal from what the harness actually recorded: the plan and its parts, every ' +
    'pull request opened for it and what became of each, what the dispatcher decided and when, what was ' +
    'escalated to a person, what agents concluded and what it cost, the validation checks and their ' +
    'readings, which environments the work has reached, the retrospective if one was written, and the notes ' +
    "agents left each other. Call this before answering anything about a goal's history or its state — the " +
    'repository shows what the code says now, and this is the only account of how it got there.',
  inputSchema: toolSchema(z.object({ issue: z.number().describe('The goal number, e.g. 284.') })),
  handler: (args) => {
    const ref = desktopIssueRef(args);
    if (!ref.ok) return toolError(ref.error);
    const originRef = issueOrigin(ref.issue);
    const record = goalRecord(deps.store, originRef);
    const world = deps.store.getWorldBaseline();
    const issue = world?.issues.find((i) => i.number === ref.issue) ?? null;
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
    const appraisal = deps.store.getAppraisal(originRef);
    return toolJson({
      issue: {
        number: ref.issue,
        ref: originRef,
        title: issue?.title ?? record.issueTitle,
        body: issue?.body ?? null,
        state: issue?.state ?? null,
        workItemState: issue?.workItemState ?? null,
        labels: issue?.labels ?? [],
        url: issue?.url ?? null,
      },
      observedAt: world?.takenAt ?? null,
      appraisal:
        appraisal === null
          ? null
          : {
              verdict: appraisal.verdict,
              summary: appraisal.summary,
              missing: appraisal.missing,
              by: appraisal.by,
              decidedAt: appraisal.decidedAt,
            },
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
    status: e.status,
    landed: e.landed,
    total: e.total,
    at: e.at,
  }));
}

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
  human_task_settle: humanTaskSettle,
  agent_read: agentRead,
  queue_control: queueControl,
  goal_control: goalControl,
  goal_gate: goalGate,
  goal_placement: goalPlacement,
  goal_instruct: goalInstruct,
  proposal_read: proposalRead,
  proposal_decide: proposalDecide,
  recovery_decide: recoveryDecide,
  job_create: jobCreate,
  agent_control: agentControl,
  ...DESKTOP_EJECTION_TOOLS,
  validation_read: validationRead,
  validation_claim: validationClaim,
  validation_report: validationReport,
  plan_read: planRead,
  plan_amend: planAmend,
  ...DESKTOP_SEQUENCE_TOOLS,
  local_run: localRun,
};

export function buildDesktopTools(deps: DesktopToolDeps, session: DesktopSession): McpTool[] {
  return DESKTOP_TOOL_NAMES.map((name) => ({ name, ...DESKTOP_TOOLS[name](deps, session) }));
}
