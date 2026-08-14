import { issueOrigin } from '../plans/planning.js';
import type { Store } from '../store/store.js';
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
import { toolError, toolJson, type McpTool } from './protocol.js';

/**
 * The three tools the operator's own Claude Code gets, and **only** these three.
 *
 * Narrowed by construction rather than by a filter over the fleet's set: there is
 * no code path from a desktop connection to `conclude_work`, `plan_submit`,
 * `open_pr` or any of the rest, because this module never reaches `buildTools`
 * and the desktop server never reaches anything else. That matters more here than
 * it does for the fleet, because this credential is long-lived, sits in the
 * operator's home directory, and is held by a session nobody dispatched — the
 * blast radius of a filter that stopped filtering would be the whole harness.
 *
 * Read a plan, take one check, report what you saw. That is the entire surface.
 */
export interface DesktopToolDeps {
  store: Store;
  /** `validation.desktopClaimMinutes`. */
  claimMinutes: number;
  /** `config.validationRoot` — where a goal's fixtures live, which the session has to be told. */
  validationRoot: string;
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
};

export function buildDesktopTools(deps: DesktopToolDeps, session: DesktopSession): McpTool[] {
  return DESKTOP_TOOL_NAMES.map((name) => ({ name, ...DESKTOP_TOOLS[name](deps, session) }));
}
