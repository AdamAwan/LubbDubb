import { z } from 'zod';
import { overruleShortfall } from '../delivery/overrule.js';
import { toolSchema } from './schema.js';
import { goalFingerprint } from '../intake/appraisal.js';
import { settlePlacement } from '../intake/placementSettle.js';
import { MAX_INSTRUCTION, withdrawGoalInstruction, writeGoalInstruction } from '../goalInstructions.js';
import { issueConclusionOrigin } from '../issueConclusion.js';
import { desktopIssueRef } from '../validation/desktop.js';
import type { DesktopToolFactory } from './desktopContext.js';
import { toolError, toolJson } from './protocol.js';

// → docs/spec/11-mcp-tools.md

export const goalGate: DesktopToolFactory = (deps) => ({
  description:
    'Release a goal the harness is holding, or put the hold back. Three holds, one arm each: `appraisal` ' +
    'overrides what an appraiser concluded about whether the goal can be started from ("workable" works it ' +
    'anyway, "unclear" stops it, "clear" removes the verdict and lets it be appraised afresh); `overrule` ' +
    'says a standing shortfall is wrong and records why, which delivers the goal and puts your words in front ' +
    'of the next agent; `environmentGate` says a delivered goal is not waiting on a deployment, which is what ' +
    'opens its validation and close-out rows. Read the hold in fleet_status or goal_read first — each names ' +
    'itself as a queue reason.',
  inputSchema: toolSchema(
    z.object({
      issue: z.number().describe('The goal number, e.g. 284.'),
      appraisal: z
        .enum(['workable', 'unclear', 'clear'])
        .describe(
          '"workable" releases a goal an appraiser called unclear; "unclear" stops one without editing the ' +
            'ticket; "clear" deletes the verdict, so the next cycle appraises it again.',
        )
        .optional(),
      summary: z
        .string()
        .describe('Why, for an appraisal verdict. Optional — the record says the operator decided either way.')
        .optional(),
      overrule: z
        .string()
        .describe(
          'Why the standing shortfall is wrong, in your own words. Refused where no shortfall stands — with ' +
            'nothing standing there is no verdict to be wrong.',
        )
        .optional(),
      environmentGate: z
        .boolean()
        .describe(
          'true says this goal is not waiting on an environment, so its bench rows open now; false puts it ' +
            'back to waiting. A release needs `note`.',
        )
        .optional(),
      note: z
        .string()
        .describe('Required with `environmentGate: true` — it is the only account of why this goal stopped waiting.')
        .optional(),
    }),
  ),
  handler: async (args) => {
    const ref = desktopIssueRef(args);
    if (!ref.ok) return toolError(ref.error);
    const originRef = issueConclusionOrigin(ref.issue);
    const wantsAppraisal = args.appraisal !== undefined;
    const wantsOverrule = args.overrule !== undefined;
    const wantsGate = args.environmentGate !== undefined;
    if (!wantsAppraisal && !wantsOverrule && !wantsGate)
      return toolError(
        'Nothing to do — give `appraisal`, `overrule` or `environmentGate`. To read what is holding this goal, ' +
          'call goal_read (or fleet_status for the queue reason).',
      );

    const out: Record<string, unknown> = { issue: ref.issue };

    if (wantsAppraisal) {
      const verdict = args.appraisal;
      if (verdict !== 'workable' && verdict !== 'unclear' && verdict !== 'clear')
        return toolError('appraisal must be "workable", "unclear" or "clear".');
      if (verdict === 'clear') {
        deps.store.clearAppraisal(originRef);
        out.appraisal = null;
      } else {
        const issue = deps.store.getWorldBaseline()?.issues.find((i) => i.number === ref.issue);
        if (!issue)
          return toolError(
            `Issue #${ref.issue} is not in the last world snapshot, so there is no goal text to fingerprint a ` +
              'verdict against. Nothing was changed.',
          );
        const summary = typeof args.summary === 'string' && args.summary.trim() ? args.summary.trim() : null;
        const appraisal = deps.store.recordAppraisal({
          originRef,
          verdict,
          summary: summary ?? 'Set by the operator from the desktop channel.',
          goalRef: goalFingerprint(issue.title, issue.body),
          by: 'operator',
        });
        out.appraisal = { verdict: appraisal.verdict, summary: appraisal.summary };
      }
    }

    if (wantsOverrule) {
      if (typeof args.overrule !== 'string' || !args.overrule.trim())
        return toolError('overrule must say why the assessment is wrong — that text is the whole of the record.');
      const text = args.overrule.trim();
      if (text.length > MAX_INSTRUCTION) return toolError(`overrule is too long (max ${MAX_INSTRUCTION} characters).`);
      const outcome = overruleShortfall(deps.store, originRef, text);
      if (!outcome.ok)
        return toolError(
          `${outcome.error} — nothing on #${ref.issue} says the goal was not reached, so there is no assessment ` +
            'to overrule. If you mean the plain thing, that is a delivery in the cockpit.',
        );
      out.overruled = { delivered: true, instruction: outcome.instruction.id };
    }

    if (wantsGate) {
      if (typeof args.environmentGate !== 'boolean') return toolError('environmentGate must be true or false.');
      if (args.environmentGate) {
        const note = typeof args.note === 'string' ? args.note.trim() : '';
        if (!note)
          return toolError('A release needs a `note` — it is the only account of why this goal stopped waiting.');
        deps.store.releaseEnvironmentGate(originRef, note);
        out.environmentGate = { released: true, note };
      } else {
        deps.store.clearEnvironmentGateRelease(originRef);
        out.environmentGate = { released: false };
      }
    }

    await deps.runCycle();
    return toolJson({
      ...out,
      means:
        'the hold is answered and a cycle has run. Nothing running was stopped, and none of this touches the ' +
        'ticket except through what an agent does next: an appraisal verdict and an environment-gate release ' +
        "are the harness's own record, and an overrule delivers the goal and files your words as an instruction.",
    });
  },
});

export const goalPlacement: DesktopToolFactory = (deps) => ({
  description:
    'Answer where a goal belongs on the tracker: `parent` hangs it off a container, `areaPath` moves it onto a ' +
    'classification node. Send the field with no value to say the goal wants no such thing — that settles the ' +
    'question without writing anything. Only Azure DevOps has either; on a tracker without them this refuses ' +
    'rather than pretending. Neither answer starts, stops or re-orders any work.',
  inputSchema: toolSchema(
    z.object({
      issue: z.number().describe('The goal number, e.g. 284.'),
      parent: z
        .number()
        .nullable()
        .describe(
          'The container to hang this item off, e.g. 240. null answers "no container" — the question is ' +
            'settled and the tracker is untouched.',
        )
        .optional(),
      areaPath: z
        .string()
        .nullable()
        .describe(
          'The classification node to move it to. null (or "") answers "leave it where it is" and settles the ' +
            'question.',
        )
        .optional(),
    }),
  ),
  handler: async (args) => {
    const ref = desktopIssueRef(args);
    if (!ref.ok) return toolError(ref.error);
    const wantsParent = args.parent !== undefined;
    const wantsArea = args.areaPath !== undefined;
    if (!wantsParent && !wantsArea)
      return toolError('Nothing to do — give `parent` or `areaPath`. To read the goal, call goal_read.');

    const ctx = { store: deps.store, connector: deps.connector, errors: deps.errors };
    const out: Record<string, unknown> = { issue: ref.issue };

    if (wantsParent) {
      const parent = args.parent;
      if (parent !== null && (typeof parent !== 'number' || !Number.isInteger(parent) || parent <= 0))
        return toolError('parent must be a positive whole issue number, or null for "no container".');
      const outcome = await settlePlacement(ctx, ref.issue, 'parent', async () => {
        if (parent === null) return;
        await deps.connector.setWorkItemParent({ number: ref.issue, parentNumber: parent });
      });
      if (!outcome.ok) return toolError(outcome.error);
      out.parent = { set: parent, settled: outcome.settled };
    }

    if (wantsArea) {
      const areaPath = args.areaPath;
      if (areaPath !== null && typeof areaPath !== 'string')
        return toolError('areaPath must be a string, or null to leave the item where it is.');
      const wanted = typeof areaPath === 'string' && areaPath.trim() ? areaPath.trim() : null;
      const outcome = await settlePlacement(ctx, ref.issue, 'areaPath', async () => {
        if (wanted === null) return;
        await deps.connector.setWorkItemAreaPath({ number: ref.issue, areaPath: wanted });
      });
      if (!outcome.ok) return toolError(outcome.error);
      out.areaPath = { set: wanted, settled: outcome.settled };
    }

    await deps.runCycle();
    return toolJson({
      ...out,
      means:
        'the question is settled and the cockpit stops asking it. `settled: false` means there was no ' +
        'appraisal row to stamp — the write, if there was one, still landed. Nothing about what the harness ' +
        'dispatches has changed.',
    });
  },
});

export const goalInstruct: DesktopToolFactory = (deps) => ({
  description:
    'Tell the fleet what you want on a goal, in your own words. The text stands in front of every agent ' +
    'dispatched on it until one concludes the goal, and writing it restarts the goal: a delivery is retracted ' +
    'and a finished plan goes back to a planner. Use it when the thing built is not the thing you wanted and ' +
    'the ticket does not say why. `withdraw` takes one back by id — which stops the words standing, but does ' +
    'not un-retract the delivery or re-finish the plan.',
  inputSchema: toolSchema(
    z.object({
      issue: z.number().describe('The goal number, e.g. 284.'),
      text: z
        .string()
        .describe(`What you want done, in your own words. At most ${MAX_INSTRUCTION} characters.`)
        .optional(),
      withdraw: z.string().describe('The id of a standing instruction to take back, from goal_read.').optional(),
    }),
  ),
  handler: async (args) => {
    const ref = desktopIssueRef(args);
    if (!ref.ok) return toolError(ref.error);
    const originRef = issueConclusionOrigin(ref.issue);
    const withdraw = typeof args.withdraw === 'string' ? args.withdraw.trim() : '';
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    if (!text && !withdraw)
      return toolError('Nothing to do — give `text` to write an instruction, or `withdraw` to take one back.');
    if (text && withdraw)
      return toolError(
        'Give `text` or `withdraw`, not both — writing an instruction restarts the goal and withdrawing one ' +
          'does not undo that, so doing both in one call would leave a restart nobody asked for.',
      );

    if (withdraw) {
      const outcome = withdrawGoalInstruction(deps.store, originRef, withdraw);
      if (!outcome.ok)
        return toolError(`No standing instruction "${withdraw}" — call goal_read for what is actually standing.`);
      return toolJson({
        issue: ref.issue,
        withdrawn: withdraw,
        standing: outcome.standing,
        means:
          outcome.standing === 0
            ? 'nothing of yours stands on this goal now, and the operator `more_work` verdict the write left ' +
              'went with it. A delivery it retracted stays retracted and a plan it sent back stays in planning.'
            : 'the rest of your instructions still stand and still reach the next agent.',
      });
    }

    if (text.length > MAX_INSTRUCTION) return toolError(`text is too long (max ${MAX_INSTRUCTION} characters).`);
    const { instruction, conclusion, replanned } = writeGoalInstruction(deps.store, originRef, text);
    await deps.runCycle();
    return toolJson({
      issue: ref.issue,
      instruction: { id: instruction.id, at: instruction.createdAt },
      conclusion: conclusion.verdict,
      replanned: replanned === null ? null : { plan: replanned.id, status: replanned.status },
      means:
        'the goal is back in front of the fleet and your words go with every dispatch on it until an agent ' +
        'concludes it. The ticket is not edited from here — an agent decides whether what you asked for ' +
        'changes the goal itself, and amends it if it does.' +
        (replanned === null ? '' : ' Its finished plan has gone back to a planner, which will amend it.'),
    });
  },
});
