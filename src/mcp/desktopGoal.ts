import { overruleShortfall } from '../delivery/overrule.js';
import { goalFingerprint } from '../intake/appraisal.js';
import { settlePlacement } from '../intake/placementSettle.js';
import { MAX_INSTRUCTION, withdrawGoalInstruction, writeGoalInstruction } from '../goalInstructions.js';
import { issueConclusionOrigin } from '../issueConclusion.js';
import { desktopIssueRef } from '../validation/desktop.js';
import type { DesktopToolFactory } from './desktopContext.js';
import { toolError, toolJson } from './protocol.js';

/**
 * The operator's own answers on one goal, on the channel that can already read it.
 *
 * ## The gap this closes
 *
 * Every tool this channel had could *watch* the fleet work a goal and none could
 * answer a question it was stopped on. The cockpit's goal page has eight controls
 * and the harness holds work on four of them — an appraisal that came back
 * `unclear`, a model profile the appraiser proposed and nobody confirmed, a
 * shortfall standing against a goal that is actually finished, an environment gate
 * on a goal that is never going to deploy — and each of them is a click a browser
 * tab on one machine is the only way to make. An operator away from that machine
 * had a session that could see the hold, name it, and do nothing about it. That is
 * the report this arrived as: a session told to answer a profile question reached
 * for `human_task_settle`, cleared the wrapper task, reported the gate settled, and
 * the gate was still there.
 *
 * ## Why three names and not one
 *
 * `validation_report` living on both channels is the trap this repo has already
 * been caught by, and the answer to it is a name per object rather than a name
 * over several. So the goal's decisions divide by *what they are*, and each tool's
 * arms are arms because they are one row an operator reads in one place:
 *
 * - {@link goalGate} — the three escape hatches. Each of these routes says of
 *   itself that it is "the escape hatch a blocking gate has to have": an appraisal
 *   verdict, a shortfall the assessor got wrong, and a goal waiting on a
 *   deployment that will never come. Nothing runs on the goal until one of them is
 *   answered, which is what makes them one tool.
 * - {@link goalPlacement} — the two placement questions. Where the item hangs and
 *   which node it sits on: one tracker write each, one settlement each, and no
 *   effect on dispatch at all.
 * - {@link goalInstruct} — words in front of the next agent, which is input rather
 *   than a verdict and the one thing here that *restarts* work.
 *
 * What none of them is, is the fleet's surface: nothing here concludes a goal,
 * writes a plan or reports a reading on work the session did itself.
 * → `docs/spec/11-mcp-tools.md#the-escape-hatches-a-gate-has-to-have`
 */
export const goalGate: DesktopToolFactory = (deps) => ({
  description:
    'Release a goal the harness is holding, or put the hold back. Three holds, one arm each: `appraisal` ' +
    'overrides what an appraiser concluded about whether the goal can be started from ("workable" works it ' +
    'anyway, "unclear" stops it, "clear" removes the verdict and lets it be appraised afresh); `overrule` ' +
    'says a standing shortfall is wrong and records why, which delivers the goal and puts your words in front ' +
    'of the next agent; `environmentGate` says a delivered goal is not waiting on a deployment, which is what ' +
    'opens its validation and close-out rows. Read the hold in fleet_status or goal_read first — each names ' +
    'itself as a queue reason.',
  inputSchema: {
    type: 'object',
    properties: {
      issue: { type: 'number', description: 'The goal number, e.g. 284.' },
      appraisal: {
        type: 'string',
        enum: ['workable', 'unclear', 'clear'],
        description:
          '"workable" releases a goal an appraiser called unclear; "unclear" stops one without editing the ' +
          'ticket; "clear" deletes the verdict, so the next cycle appraises it again.',
      },
      summary: {
        type: 'string',
        description: 'Why, for an appraisal verdict. Optional — the record says the operator decided either way.',
      },
      overrule: {
        type: 'string',
        description:
          'Why the standing shortfall is wrong, in your own words. Refused where no shortfall stands — with ' +
          'nothing standing there is no verdict to be wrong.',
      },
      environmentGate: {
        type: 'boolean',
        description:
          'true says this goal is not waiting on an environment, so its bench rows open now; false puts it ' +
          'back to waiting. A release needs `note`.',
      },
      note: {
        type: 'string',
        description: 'Required with `environmentGate: true` — it is the only account of why this goal stopped waiting.',
      },
    },
    required: ['issue'],
  },
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
        // The text the verdict is about, from the world the last pulse read.
        // Absent is refused rather than guessed: a verdict fingerprinted against
        // an empty goal expires the instant the issue is next fetched, which is a
        // silent no-op dressed as an override.
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
        // The route's own refusal, by the same rule: a release with no account of
        // itself is a goal that stopped waiting and nobody can say why.
        if (!note)
          return toolError('A release needs a `note` — it is the only account of why this goal stopped waiting.');
        deps.store.releaseEnvironmentGate(originRef, note);
        out.environmentGate = { released: true, note };
      } else {
        deps.store.clearEnvironmentGateRelease(originRef);
        out.environmentGate = { released: false };
      }
    }

    // Every arm here releases something the harness was holding, and the desks
    // that act on it run on the pulse — so run one rather than leaving the
    // operator's answer to the next heartbeat, exactly as the routes do.
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

/**
 * Where the goal hangs, and which node it sits on.
 *
 * Its own name rather than an arm on {@link goalGate} because it is a different
 * kind of act: these two are the only decisions on this channel that **write to
 * the tracker** — a container relation and a classification node, which is why
 * the connector on the desktop deps had to widen for them at all — and neither
 * holds any work. A goal nobody has placed is dispatched exactly as one that has
 * been; the questions exist because an item filed under nothing rolls up to
 * nothing, and a board nobody can filter is the cost.
 *
 * Both answers are the appraiser's proposal, a value of the operator's own, or
 * "this goal wants no such thing" — and all three settle the question, because a
 * row that came back for one refresh reads as a click that did not take.
 * → `src/intake/placement.ts`, `docs/spec/06-issue-pickup.md`
 */
export const goalPlacement: DesktopToolFactory = (deps) => ({
  description:
    'Answer where a goal belongs on the tracker: `parent` hangs it off a container, `areaPath` moves it onto a ' +
    'classification node. Send the field with no value to say the goal wants no such thing — that settles the ' +
    'question without writing anything. Only Azure DevOps has either; on a tracker without them this refuses ' +
    'rather than pretending. Neither answer starts, stops or re-orders any work.',
  inputSchema: {
    type: 'object',
    properties: {
      issue: { type: 'number', description: 'The goal number, e.g. 284.' },
      parent: {
        type: ['number', 'null'],
        description:
          'The container to hang this item off, e.g. 240. null answers "no container" — the question is ' +
          'settled and the tracker is untouched.',
      },
      areaPath: {
        type: ['string', 'null'],
        description:
          'The classification node to move it to. null (or "") answers "leave it where it is" and settles the ' +
          'question.',
      },
    },
    required: ['issue'],
  },
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

/**
 * The operator saying, mid-run, what they actually want.
 *
 * Not a verdict and not a question answered: an instruction is **input**. It
 * accumulates, it is appended to every later dispatch on the goal, and writing one
 * *restarts* the goal — a `more_work` verdict that retracts a delivery, and a
 * settled plan sent back to a planner. That last part is why this is not a store
 * write a session could have made through some other tool: half of it is the row,
 * and half of it is the restart that gets the row read.
 * → `src/goalInstructions.ts`
 *
 * `withdraw` is here rather than in a second tool because it is the same object
 * seen from the other end, and because the asymmetry needs saying somewhere a
 * session will read it: taking the words back does not take the restart back.
 */
export const goalInstruct: DesktopToolFactory = (deps) => ({
  description:
    'Tell the fleet what you want on a goal, in your own words. The text stands in front of every agent ' +
    'dispatched on it until one concludes the goal, and writing it restarts the goal: a delivery is retracted ' +
    'and a finished plan goes back to a planner. Use it when the thing built is not the thing you wanted and ' +
    'the ticket does not say why. `withdraw` takes one back by id — which stops the words standing, but does ' +
    'not un-retract the delivery or re-finish the plan.',
  inputSchema: {
    type: 'object',
    properties: {
      issue: { type: 'number', description: 'The goal number, e.g. 284.' },
      text: {
        type: 'string',
        description: `What you want done, in your own words. At most ${MAX_INSTRUCTION} characters.`,
      },
      withdraw: { type: 'string', description: 'The id of a standing instruction to take back, from goal_read.' },
    },
    required: ['issue'],
  },
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
    // The restart is what makes this urgent: an instruction nothing is dispatched
    // for is an operator being ignored until the next heartbeat.
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
