import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { issueConclusionOrigin } from '../../issueConclusion.js';
import { bugTicketFields } from '../../bugFiling.js';
import { trackerCoordinates } from '../../mcp/findings.js';
import { dedupeCandidates, renderCandidates } from '../../tickets/candidates.js';
import { MAX_INSTRUCTION, withdrawGoalInstruction, writeGoalInstruction } from '../../goalInstructions.js';
import { goalFingerprint } from '../../intake/appraisal.js';
import { ShortfallBody } from '../../delivery/shortfall.js';
import { overruleShortfall } from '../../delivery/overrule.js';
import { applyProfilePin } from '../../intake/profilePin.js';
import { settlePlacement } from '../../intake/placementSettle.js';
import { GateReleaseBody } from '../../environments/arrival.js';
import { validationHeadline } from '../../delivery/closeOut.js';
import { goalValidation } from '../../validation/goal.js';
import { clearGoalWork } from '../../floor/endRun.js';
import { applyIssueWatch } from '../../issueWatch.js';
import { watchLabelFor } from '../../watchLabels.js';
import { fleetWorksUpstream, UPSTREAM_REPO } from '../../tickets/upstream.js';
import { checked, IssueNumberParams, optionalText, requiredBoolean, requiredText } from '../validation.js';
import type { RouteContext } from './context.js';
import type { FilingTargetProbe, GoalAgentsPayload, IssueFiled } from '../../wire.js';

/**
 * The operator's own arm of every verdict an agent can cast about an issue — watch,
 * conclusion, appraisal, delivery, shortfall — plus ending its run. Each verdict route
 * writes the harness's own record and never the tracker; `/bug` is the exception.
 */

/** Long enough for a repro with steps; short of pasting a log file in. */
const MAX_BUG_SUMMARY = 4000;

/** A tracker title is a headline; both providers truncate far above this anyway. */
const MAX_ISSUE_TITLE = 200;

/**
 * How long the filing-target probe may take before it is reported as unavailable. A request
 * that never answers leaves the modal spinning with no way out, so the slow answer and the
 * dead one are reported the same way.
 */
const PROBE_TIMEOUT_MS = 8000;

/**
 * The probe's deadline. `finally` clears the timer, so a fast answer leaves nothing
 * pending.
 */
function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store, connector, harness, config, errors } = system;
  const watchLabel = watchLabelFor(config.labelPrefix);

  // Toggle an issue's watch state. Issues are opt-in, so this is a single label
  // write, provider-agnostic through the outbound seam.
  //
  // **A container cascades**: watching a Feature tags every descendant
  // (`watchCascadeTargets`), and un-watching walks the same tree. Each is a real
  // write, and a partial failure is *reported* rather than swallowed.
  const WatchBody = z.object({ watched: requiredBoolean('watched must be a boolean') });
  app.post(
    '/api/issues/:number/watch',
    checked({ params: IssueNumberParams, body: WatchBody }, async ({ params, body, reply }) => {
      const { number: issueNumber } = params;
      const { watched } = body;
      // The cascade, mirrors and partial-failure report live in
      // `src/issueWatch.ts`, shared with the back-out and `goal_control`. What stays
      // here is the broadcast, the cycle and the shape of the reply.
      const outcome = await applyIssueWatch(
        {
          store,
          sink: connector,
          errors,
          labelPrefix: config.labelPrefix,
          issueContainerTypes: config.issueContainerTypes,
        },
        issueNumber,
        watched,
        `while ${watched ? 'watching' : 'dropping'} #${issueNumber}`,
      );
      const { targets, failed } = outcome;

      // Whatever landed, landed: republish before the refusal, since even a partial
      // failure changed the world the cockpit is showing.
      hub.broadcast({ type: 'world:changed' });
      // `targets` is empty only with no label prefix configured: the gate is off and
      // there was nothing to write — a success with nothing done.
      if (targets.length > 0 && failed.length === targets.length) {
        return reply.code(400).send({ error: failed[0]?.message ?? 'no watch tag could be written' });
      }
      await harness.runCycle('manual');
      if (failed.length > 0) {
        return reply.code(400).send({
          error:
            `Tagged ${targets.length - failed.length} of ${targets.length} items; ` +
            `#${failed.map((f) => f.number).join(', #')} kept the old tag: ${failed[0]?.message ?? ''}`,
        });
      }
      return { ok: true, watched, cascaded: Math.max(targets.length - 1, 0) };
    }),
  );

  // Move a work item to one of the tracker's own states — the card view's drag.
  //
  // **The state word is not validated here**: the provider owns its process
  // template, and a check against the states the mirror has seen would refuse a
  // legitimate but still-empty column. The capability *is* checked, because
  // `setWorkItemState` throws where nothing implements it.
  const StateBody = z.object({
    state: requiredText('state must name a tracker state', {
      length: 80,
      message: 'state must be at most 80 characters',
    }),
  });
  app.post(
    '/api/issues/:number/state',
    checked({ params: IssueNumberParams, body: StateBody }, async ({ params, body, reply }) => {
      const { number } = params;
      const { state } = body;
      if (!connector.canSetWorkItemState()) {
        return reply
          .code(400)
          .send({ error: 'This tracker cannot write work item states, so nothing here can be moved.' });
      }

      try {
        const result = await connector.setWorkItemState({ number, state });
        if (!result.ok) {
          return reply.code(400).send({ error: `The tracker did not take "${state}" for #${number}.` });
        }
      } catch (err) {
        const message = (err as Error).message;
        errors.record({ source: 'server', message: `Failed to move #${number} to "${state}": ${message}` });
        // The provider's own sentence, quoted whole: it is the only account of why
        // the card is going back where it came from.
        return reply.code(400).send({ error: message });
      }

      // Both mirrors, before the broadcast: `/api/state` serves the baseline, and the
      // Tickets tab reads `tracker_items`, which the sweep may not reach this cycle.
      store.patchWorldState({ number, state });
      store.patchTicketState({ number, state });
      hub.broadcast({ type: 'world:changed' });
      await harness.runCycle('manual');
      return { ok: true, state };
    }),
  );

  // Pin this issue's work to a model profile, or clear the pin. The label sweep,
  // the refusal and the settlement of the appraiser's question are
  // `src/intake/profilePin.ts`'s, shared with `goal_control`; what stays here is the
  // broadcast, the cycle and the shape of the reply.
  //
  // Absent or empty clears the pin — "no profile" is the state a ticket starts in,
  // not a third value.
  const ProfileBody = z.object({ profile: optionalText('profile') });
  app.post(
    '/api/issues/:number/profile',
    checked({ params: IssueNumberParams, body: ProfileBody }, async ({ params, body, reply }) => {
      const { number: issueNumber } = params;
      const outcome = await applyProfilePin(
        { store, sink: connector, errors, labelPrefix: config.labelPrefix, agentModels: config.agentModels },
        issueNumber,
        body.profile ?? null,
      );
      if (!outcome.ok) {
        // Republished before the refusal: a partial sweep already changed the world.
        if (outcome.wrote) hub.broadcast({ type: 'world:changed' });
        return reply.code(400).send({ error: outcome.error });
      }
      hub.broadcast({ type: 'world:changed' });
      await harness.runCycle('manual');
      return { ok: true, profile: outcome.profile, answered: outcome.answered };
    }),
  );

  // Settle one of a goal's two **placement** questions: its container, and its area
  // node. Each takes the three answers the appraisal's proposal has — take it, use
  // another value, or say it does not apply.
  //
  // The write goes through `ActionSink`, never a shell command in a prompt: what an
  // agent proposed is a suggestion, what changes the tracker is a click here.
  //
  // Every answer stamps the row, including the two that also change the work item —
  // the question's visibility is derived from the live item, a pulse behind this
  // write, so a row that came back would read as a click that did not take.
  const PlacementBody = z.object({
    // Absent is the third answer — "this goal wants no parent" — not a missing
    // field: the route settles the question either way.
    parent: z.number().int().positive().optional(),
  });
  app.post(
    '/api/issues/:number/parent',
    checked({ params: IssueNumberParams, body: PlacementBody }, async ({ params, body, reply }) => {
      const outcome = await settlePlacement({ store, connector, errors }, params.number, 'parent', async () => {
        if (body.parent === undefined) return;
        await connector.setWorkItemParent({ number: params.number, parentNumber: body.parent });
      });
      if (!outcome.ok) return reply.code(400).send({ error: outcome.error });
      hub.broadcast({ type: 'world:changed' });
      await harness.runCycle('manual');
      return { ok: true, parent: body.parent ?? null, settled: outcome.settled };
    }),
  );

  const AreaPathBody = z.object({ areaPath: optionalText('areaPath') });
  app.post(
    '/api/issues/:number/area-path',
    checked({ params: IssueNumberParams, body: AreaPathBody }, async ({ params, body, reply }) => {
      const outcome = await settlePlacement({ store, connector, errors }, params.number, 'areaPath', async () => {
        if (body.areaPath === undefined) return;
        await connector.setWorkItemAreaPath({ number: params.number, areaPath: body.areaPath });
      });
      if (!outcome.ok) return reply.code(400).send({ error: outcome.error });
      hub.broadcast({ type: 'world:changed' });
      await harness.runCycle('manual');
      return { ok: true, areaPath: body.areaPath ?? null, settled: outcome.settled };
    }),
  );

  // Mark this goal a priority, or clear it: everything dispatched under it ranks
  // ahead of the natural cross-rule order until cleared.
  //
  // The harness's own record, never a tracker label, unlike the watch and profile
  // routes: this is a statement about **this deployment's queue**, which every other
  // deployment reading the same board would otherwise inherit.
  //
  // A cycle runs immediately, and safely — the flag only re-orders, and never
  // un-holds an item held by a cooldown, a cap, an unapproved plan or an ignore tag.
  const PriorityBody = z.object({ priority: requiredBoolean('priority must be a boolean') });
  app.post(
    '/api/issues/:number/priority',
    checked({ params: IssueNumberParams, body: PriorityBody }, async ({ params, body }) => {
      const { number: issueNumber } = params;
      const { priority } = body;
      store.setGoalPriority(issueConclusionOrigin(issueNumber), priority);
      hub.broadcast({ type: 'world:changed' });
      const report = await harness.runCycle('manual');
      return { ok: true, priority, report };
    }),
  );

  // Set (or clear) an issue's conclusion by hand — the operator's override of the
  // agent's verdict and of what its plan derives.
  //
  // Writes the *harness's* record, never the tracker: concluding in the harness's
  // view is what stops the re-pickup. `more_work` runs a cycle immediately, since
  // rule `work-item-back-to-pickup` reads the verdict there. The cockpit writes
  // `more_work` through `/instruction` instead; this arm stays as the API's way to
  // say it, and as what `null` clears.
  //
  // `null` is a member of the verdict rather than an absence, because it is what
  // clears the row; absence is refused.
  const ConclusionBody = z.object({
    verdict: z.union([z.literal('done'), z.literal('more_work'), z.null()], {
      errorMap: () => ({ message: 'verdict must be "done", "more_work" or null' }),
    }),
    note: optionalText('note'),
  });
  app.post(
    '/api/issues/:number/conclusion',
    checked({ params: IssueNumberParams, body: ConclusionBody }, async ({ params, body }) => {
      const { number: issueNumber } = params;
      const { verdict, note } = body;
      const originRef = issueConclusionOrigin(issueNumber);
      // null clears, returning the issue to whatever its plan derives (or to
      // undeclared) — a delete rather than a third stored verdict, so there is only
      // ever one way to express "nobody has decided this".
      if (verdict === null) {
        store.clearIssueConclusion(originRef);
        hub.broadcast({ type: 'world:changed' });
        return { ok: true, verdict: null };
      }
      const conclusion = store.recordIssueConclusion({
        originRef,
        verdict,
        // The operator has the row as context, so the note is optional and the
        // default says who decided.
        note: note ?? 'Set by the operator from the cockpit.',
        by: 'operator',
      });
      hub.broadcast({ type: 'world:changed' });
      if (verdict === 'more_work') await harness.runCycle('manual');
      return { ok: true, conclusion };
    }),
  );

  // Tell the fleet what to do on a goal, in the operator's own words. The
  // instruction is appended to every dispatch on the goal until one concludes it
  // (see src/goalInstructions.ts).
  //
  // It writes the instruction and then **restarts the goal**, because the two states
  // an operator presses this in are the two the funnel has already stopped in: a
  // standing **delivery**, which holds the goal out of `eligibleIssues` entirely,
  // and a **settled plan**, which `resolvePlanRoute` answers `parts` for whatever its
  // status. Without the restart the words land, the cockpit draws them, and no agent
  // is ever going to read them.
  //
  // The **conclusion** is written on a delivered goal too, clearing the delivery
  // through `VERDICT_EXCLUSIONS.conclusion`: `delivered` and "there is more work
  // here" are opposite answers to one question, and the operator outranks the
  // assessor. `issue-retro`, `validate-check` and the close-out obligation all stop
  // while the goal is back in play; a retrospective already written stays written.
  //
  // The **replan** is one status write — `shortfallArm`'s arm A through this door —
  // so rule `issue-plan` routes the plan back to a planner and rule `issue-assess`
  // skips on `planInFlight`. Nothing is torn down.
  //
  // The words are **not** appended to the plan's reason: they reach the replanning
  // agent through `operatorInstructionsNote`, and one fact rendered twice in one
  // prompt reads as two.
  const InstructionBody = z.object({
    text: z
      .string({ required_error: 'text is required', invalid_type_error: 'text must be a string' })
      .trim()
      .min(1, 'text is required — say what you want done')
      .max(MAX_INSTRUCTION, `text is too long (max ${MAX_INSTRUCTION} characters)`),
  });
  app.post(
    '/api/issues/:number/instruction',
    checked({ params: IssueNumberParams, body: InstructionBody }, async ({ params, body }) => {
      // The row, the `more_work` verdict and the replan are one act —
      // `writeGoalInstruction`'s, shared with `goal_instruct`.
      const { instruction, conclusion, replanned } = writeGoalInstruction(
        store,
        issueConclusionOrigin(params.number),
        body.text,
      );
      hub.broadcast({ type: 'world:changed' });
      await harness.runCycle('manual');
      return { ok: true, instruction, conclusion, replanned };
    }),
  );

  // Take one back — the only way an instruction stops standing other than an agent
  // concluding the goal.
  //
  // Withdrawing the **last** one clears the operator's own `more_work` with it, and
  // only ever that one; an agent's own declaration is left where it was found.
  //
  // It does **not** undo the rest of the restart: a retracted delivery stays
  // retracted and a plan sent back stays `planning`. Neither is recoverable by
  // guessing, and both have their own control.
  const InstructionParams = IssueNumberParams.extend({ id: z.string() });
  app.delete(
    '/api/issues/:number/instruction/:id',
    checked({ params: InstructionParams }, async ({ params, reply }) => {
      const outcome = withdrawGoalInstruction(store, issueConclusionOrigin(params.number), params.id);
      if (!outcome.ok) return reply.code(409).send({ error: 'no standing instruction with that id' });
      hub.broadcast({ type: 'world:changed' });
      return { ok: true, standing: outcome.standing };
    }),
  );

  // Override a goal appraisal — the escape hatch a blocking gate has to have, in
  // both directions.
  //
  // Clearing is a delete rather than a stored third verdict, so the absence of an
  // appraisal keeps one representation — also the state a crashed appraiser leaves
  // behind. The goal fingerprint is taken from the issue as the harness sees it now,
  // so an operator's verdict expires on the next edit exactly as an agent's does.
  const AppraisalBody = z.object({
    verdict: z.union([z.literal('workable'), z.literal('unclear'), z.null()], {
      errorMap: () => ({ message: 'verdict must be "workable", "unclear" or null' }),
    }),
    summary: optionalText('summary'),
  });
  app.post(
    '/api/issues/:number/appraisal',
    checked({ params: IssueNumberParams, body: AppraisalBody }, async ({ params, body, reply }) => {
      const { number: issueNumber } = params;
      const { verdict, summary } = body;
      const originRef = issueConclusionOrigin(issueNumber);
      if (verdict === null) {
        store.clearAppraisal(originRef);
        hub.broadcast({ type: 'world:changed' });
        // Clearing a hold is a request to reconsider the issue now, not next beat.
        await harness.runCycle('manual');
        return { ok: true, appraisal: null };
      }
      // Absent from the last snapshot is refused, not guessed: a verdict
      // fingerprinted against an empty goal expires the instant the issue is next
      // fetched — a silent no-op dressed as an override.
      const issue = store.getWorldBaseline()?.issues.find((i) => i.number === issueNumber);
      if (!issue) return reply.code(404).send({ error: 'issue not in the last world snapshot' });
      const appraisal = store.recordAppraisal({
        originRef,
        verdict,
        // The operator has the item in front of them, so the summary is optional.
        summary: summary ?? 'Set by the operator from the cockpit.',
        goalRef: goalFingerprint(issue.title, issue.body),
        by: 'operator',
      });
      hub.broadcast({ type: 'world:changed' });
      // A `workable` override releases the issue into the funnel — act on it now.
      if (verdict === 'workable') await harness.runCycle('manual');
      return { ok: true, appraisal };
    }),
  );

  // Park an issue as delivered by hand, or release one the assessor parked — the
  // operator's own arm of rule `issue-assess`'s verdict, and its escape hatch.
  // Writes the *harness's* record, never the tracker: `delivered` is deliberately
  // weaker than `closed`. Clearing is a delete, so the absence of a verdict keeps
  // one representation.
  const DeliveredBody = z.object({
    delivered: requiredBoolean('delivered must be a boolean'),
    summary: optionalText('summary'),
  });
  app.post(
    '/api/issues/:number/delivered',
    checked({ params: IssueNumberParams, body: DeliveredBody }, async ({ params, body }) => {
      const { number: issueNumber } = params;
      const { delivered, summary } = body;
      const originRef = issueConclusionOrigin(issueNumber);
      if (!delivered) {
        store.clearDelivery(originRef);
        hub.broadcast({ type: 'world:changed' });
        // Releasing a park is a request to reconsider the issue now, not next beat.
        await harness.runCycle('manual');
        return { ok: true, delivered: false };
      }
      const delivery = store.recordDelivery({
        originRef,
        // The operator has the row in front of them, so the summary is optional.
        summary: summary ?? 'Marked delivered by the operator.',
        by: 'operator',
      });
      hub.broadcast({ type: 'world:changed' });
      return { ok: true, delivery };
    }),
  );

  // Say that this goal is not waiting on an environment, or put it back to waiting
  // — the escape hatch an environment gate has to have. With `arrival.opens`
  // configured, a goal that will never reach an environment would otherwise sit
  // delivered with an empty bench for good.
  //
  // The note is required by {@link GateReleaseBody}, unlike every other operator
  // verdict's summary. Clearing is a delete.
  app.post(
    '/api/issues/:number/environment-gate',
    checked({ params: IssueNumberParams, body: GateReleaseBody }, async ({ params, body }) => {
      const goalRef = issueConclusionOrigin(params.number);
      if (!body.released) {
        store.clearEnvironmentGateRelease(goalRef);
        hub.broadcast({ type: 'world:changed' });
        return { ok: true, released: null };
      }
      // `note` is required by the schema's refine, so this is a narrowing.
      const release = store.releaseEnvironmentGate(goalRef, body.note ?? '');
      hub.broadcast({ type: 'world:changed' });
      // The obligations it opens are filed by desks on the pulse.
      await harness.runCycle('manual');
      return { ok: true, released: release };
    }),
  );

  // Record by hand that an issue was worked and its goal is not reached, or clear a
  // standing shortfall — the operator's arm of the assessor's negative verdict, and
  // its escape hatch: rejecting the proposal deliberately leaves the verdict
  // standing, so without this the row would stand for good.
  //
  // Clearing is a delete. Writing one clears any standing delivery in the store —
  // the two are opposite answers to one question. The body's rules live in
  // {@link ShortfallBody}, beside `shortfallArm`, which routes on the same fact.
  app.post(
    '/api/issues/:number/shortfall',
    checked({ params: IssueNumberParams, body: ShortfallBody }, async ({ params, body }) => {
      const { number: issueNumber } = params;
      const originRef = issueConclusionOrigin(issueNumber);
      if (body.cause === null) {
        store.clearShortfall(originRef);
        hub.broadcast({ type: 'world:changed' });
        // Clearing releases the rule that was about to ask about it — reconsider now.
        await harness.runCycle('manual');
        return { ok: true, shortfall: null };
      }
      const shortfall = store.recordShortfall({
        originRef,
        cause: body.cause ?? null,
        partSlug: body.part ?? null,
        // The operator has the row in front of them, so the summary is optional.
        summary: body.summary ?? 'Marked as not delivered by the operator.',
        by: 'operator',
      });
      hub.broadcast({ type: 'world:changed' });
      return { ok: true, shortfall };
    }),
  );

  // Overrule a standing shortfall: the assessment is wrong, and here is the
  // correction in the operator's own words. Neither accept nor reject says this —
  // rejecting leaves the verdict standing, so a fresh assessor records the same
  // shortfall, and nothing the operator types into that card reaches an agent.
  //
  // It writes two rows, `/instruction`'s arrangement and for its reason. The
  // **delivery** is the verdict: it clears the shortfall through the exclusion
  // matrix rather than a hand-rolled `DELETE`, parks the assessor, and releases the
  // three things gated on `deliveryParked`. The **instruction** gets the correction
  // into the record, in front of the retrospective agent the delivery dispatches.
  // One text in both, so the two cannot drift.
  //
  // The **proposal is not settled here** — `/api/proposals/:id/reject` owns that.
  const OverruleBody = z.object({
    text: z
      .string({ required_error: 'text is required', invalid_type_error: 'text must be a string' })
      .trim()
      .min(1, 'text is required — say why the assessment is wrong')
      .max(MAX_INSTRUCTION, `text is too long (max ${MAX_INSTRUCTION} characters)`),
  });
  app.post(
    '/api/issues/:number/shortfall/overrule',
    checked({ params: IssueNumberParams, body: OverruleBody }, async ({ params, body, reply }) => {
      const outcome = overruleShortfall(store, issueConclusionOrigin(params.number), body.text);
      if (!outcome.ok) return reply.code(409).send({ error: outcome.error });
      const { delivery, instruction } = outcome;
      hub.broadcast({ type: 'world:changed' });
      // The retrospective this releases carries the operator's answer onward, so
      // dispatch it now.
      await harness.runCycle('manual');
      return { ok: true, delivery, instruction };
    }),
  );

  // End a run. The only thing that ends one, and it persists across a restart: a
  // dismissed run is not unioned back into the issue list, so nothing is scheduled
  // for it again. Idempotent — a second dismissal is a 409, not an error state.
  // One-way.
  //
  // **It is destructive, and the destruction is the point**: stopping the dispatcher
  // governs only what is *started*, so `clearGoalWork` also ends the goal's live
  // agents, queued jobs and standing instructions (`src/floor/endRun.ts`).
  //
  // **A flagged validation plan costs a sentence here.** It blocks nothing — the
  // note is the whole requirement, kept on the run so what the goal owed and what
  // was said about it survive together.
  const DismissRunBody = z.object({ note: optionalText('note') });
  app.post(
    '/api/issues/:number/dismiss-run',
    checked({ params: IssueNumberParams, body: DismissRunBody }, async ({ params, body, reply }) => {
      const origin = issueConclusionOrigin(params.number);
      const validation = goalValidation(store, origin);
      if (validation && validation.verdict.state === 'flagged' && body.note === undefined)
        return reply.code(400).send({
          error: `note is required — ${validationHeadline(validation.verdict)} Say what you are doing about them, or waive them first.`,
        });
      const dismissed = store.dismissIssueRun(origin, body.note ?? null);
      if (!dismissed) return reply.code(409).send({ error: 'no run to dismiss' });
      // The other half of ending a run: without it the goal's live agents keep
      // working under a run the cockpit has drawn as over. Below the dismissal, so a
      // 409 clears nothing.
      const cleared = clearGoalWork(store, system.agents, params.number);
      hub.broadcast({ type: 'dirty' });
      return { ok: true, cleared };
    }),
  );

  // Raise a bug against a story: the operator ran the thing and it does not do what
  // they expect. The one route here that files into the **tracker** rather than
  // writing the harness's own record.
  //
  // The story's verdict is deliberately untouched — the bug is its own work item and
  // carries the work, which is the only arrangement handing the fleet the operator's
  // actual words as the goal (see src/bugFiling.ts). `summary` is required, unlike
  // every other body here: their report *is* the feature.
  const RaiseBugBody = z.object({
    summary: z
      .string({ required_error: 'summary is required', invalid_type_error: 'summary must be a string' })
      .trim()
      .min(1, 'summary is required — say what is wrong')
      .max(MAX_BUG_SUMMARY, `summary is too long (max ${MAX_BUG_SUMMARY} characters)`),
    title: optionalText('title'),
  });
  app.post(
    '/api/issues/:number/bug',
    checked({ params: IssueNumberParams }, async ({ params, req, reply }) => {
      const { number: issueNumber } = params;
      // The appraisal route's check: an issue the harness has never seen would be a
      // silent no-op dressed as an action.
      const issue = store.getWorldBaseline()?.issues.find((i) => i.number === issueNumber);
      if (!issue) return reply.code(404).send({ error: 'issue not in the last world snapshot' });
      // With no tracker configured there is nowhere to file — the gate all four
      // filing arms ask. The cockpit hides the button, so this means a direct call.
      const tracker = trackerCoordinates(config);
      if (!tracker)
        return reply
          .code(409)
          .send({ error: 'no issue tracker is configured to file into (the issues provider is fake or unconfigured)' });

      // The body last, after every 404/409 the store answers, so the refusal path
      // stays one.
      return checked({ body: RaiseBugBody }, async ({ body }) => {
        const derived = bugTicketFields(issue, body.summary, tracker);
        const title = body.title ?? derived.title;
        // Rendered from the operator's template book. The duplicate candidates are
        // **appended** rather than given a placeholder, so an override that never
        // learned about them cannot silently drop them.
        const candidates = renderCandidates(dedupeCandidates(store.listTrackerItems(), body.summary));
        const prompt = [system.prompts.render('raise-bug', derived.vars), candidates]
          .filter((part) => part !== null)
          .join('\n\n');
        // Desk, not code: filing touches no repository, and the report rides in this
        // prompt rather than being stored again — see src/store/bugFilings.ts.
        const job = store.createJob({ title, prompt, kind: 'desk' });
        // Job first, then the filing row — a failed create leaves nothing behind.
        const filing = store.createBugFiling({ jobId: job.id, originRef: issueConclusionOrigin(issueNumber) });
        hub.broadcast({ type: 'world:changed' });
        // The report should reach the fleet now, not on the next heartbeat.
        const report = await harness.runCycle('manual');
        return { ok: true, filing, job, report };
      })(req, reply);
    }),
  );

  // -------------------------------------------------------------------------
  // Raising an issue about LubbDubb from the cockpit
  //
  // Two collection-level routes about no issue in particular, and not about the
  // tracker the rest of this file writes to. Both go through `system.upstream`,
  // which files into LubbDubb's own repository through the `gh` CLI. No agent and
  // no model, either way.
  // -------------------------------------------------------------------------

  // The live half of the gate on the compose modal: only `gh` can prove it can
  // answer and as whom, since the harness's `GITHUB_TOKEN` has no bearing on this
  // destination.
  //
  // Every failure arm is a 200 carrying `available: false` and a reason, never a
  // 5xx — a logged-out CLI is an answer to the question asked. The failure is still
  // *recorded*, so a lapsed `gh` login reaches the Errors panel.
  /**
   * Every agent that has worked one goal, with the tasks they were dispatched on — the goal
   * page's "On this goal" card. → `docs/spec/16-http-api.md#bulk-collections` `prs` is
   * supplied by the caller because which pull requests are a goal's is the cockpit's own
   * three-way match (`ownsPr`); resolving them again here would be a second matcher free to
   * disagree with it. No 404 for a goal the world has dropped — a run whose ticket closed
   * still has a page and a history.
   */
  const GoalAgentsQuery = z.object({
    prs: z
      .string()
      .optional()
      .transform((raw, ctx) => {
        if (raw === undefined || raw.trim() === '') return [] as number[];
        const parts = raw.split(',').map((p) => p.trim());
        const numbers = parts.map(Number);
        if (numbers.some((n) => !Number.isInteger(n) || n <= 0)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'prs must be a comma-separated list of PR numbers' });
          return z.NEVER;
        }
        return numbers;
      }),
  });
  app.get(
    '/api/issues/:number/agents',
    checked({ params: IssueNumberParams, query: GoalAgentsQuery }, async ({ params, query }) => {
      const ref = issueConclusionOrigin(params.number);
      const tasks = store.listGoalTasks(
        ref,
        query.prs.map((n) => `pr:${n}`),
      );
      return { ref, agents: store.listAgentsForTasks(tasks.map((t) => t.id)), tasks } satisfies GoalAgentsPayload;
    }),
  );

  app.get('/api/issues/filing-target', async (): Promise<FilingTargetProbe> => {
    try {
      const target = await withDeadline(
        system.upstream.describeTarget(),
        PROBE_TIMEOUT_MS,
        `the GitHub CLI did not answer within ${PROBE_TIMEOUT_MS / 1000}s`,
      );
      return { available: true, reason: null, watchable: fleetWorksUpstream(config), ...target };
    } catch (err) {
      const message = (err as Error).message;
      errors.record({ source: 'provider', message: `the filing-target probe failed: ${message}` });
      return { available: false, target: null, identity: null, reason: message };
    }
  });

  // File the operator's own report about LubbDubb, directly — the one route here
  // that creates a tracker item with no desk agent between the click and the create,
  // since the operator has already written it up.
  //
  // Through `system.upstream` and **not** `system.filing`: `ticketFiler` files into
  // the tracker the fleet is pointed at, and this is a report about the cockpit.
  //
  // **`watch` is opt-in, defaults off, and is only honoured where it can mean
  // anything** — the label is what makes the fleet pick an issue up, and on a
  // deployment whose fleet works some other repo it is dropped.
  const RaiseIssueBody = z.object({
    title: z
      .string({ required_error: 'title is required', invalid_type_error: 'title must be a string' })
      .trim()
      .min(1, 'title is required — say what this is about')
      .max(MAX_ISSUE_TITLE, `title is too long (max ${MAX_ISSUE_TITLE} characters)`),
    body: z
      .string({ required_error: 'body is required', invalid_type_error: 'body must be a string' })
      .trim()
      .min(1, 'body is required — say what should happen')
      .max(MAX_BUG_SUMMARY, `body is too long (max ${MAX_BUG_SUMMARY} characters)`),
    watch: z.boolean({ invalid_type_error: 'watch must be a boolean' }).optional().default(false),
  });
  app.post(
    '/api/issues',
    checked({ body: RaiseIssueBody }, async ({ body, reply }) => {
      // Only where the fleet works this repo itself: elsewhere the label would tag
      // an issue no agent of this deployment ever sweeps.
      const watchable = fleetWorksUpstream(config);
      let filed: { number: number; url: string };
      try {
        filed = await system.upstream.create({
          title: body.title,
          body: body.body,
          labels: body.watch && watchable ? [watchLabel] : [],
        });
      } catch (err) {
        // The CLI refusing is an answer, not an unanticipated fault: a 502 with its
        // own words, and the modal keeps what the operator typed.
        const message = (err as Error).message;
        errors.record({ source: 'provider', message: `filing an issue from the cockpit failed: ${message}` });
        return reply.code(502).send({ error: `${UPSTREAM_REPO} refused the issue: ${message}` });
      }
      // No cycle and no broadcast, unlike every other filing route: what was created
      // is in LubbDubb's tracker, which this harness does not sweep, and the modal's
      // success state is the address rather than a row in the world.
      const answer: IssueFiled = { ok: true, number: filed.number, url: filed.url };
      return answer;
    }),
  );
}
