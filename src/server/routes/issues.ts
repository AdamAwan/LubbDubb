import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { issueConclusionOrigin } from '../../issueConclusion.js';
import { bugTicketFields } from '../../bugFiling.js';
import { trackerCoordinates } from '../../mcp/findings.js';
import { dedupeCandidates, renderCandidates } from '../../tickets/candidates.js';
import { MAX_INSTRUCTION } from '../../goalInstructions.js';
import { goalFingerprint } from '../../intake/assay.js';
import { ShortfallBody } from '../../delivery/shortfall.js';
import { GateReleaseBody } from '../../environments/arrival.js';
import { validationHeadline } from '../../delivery/closeOut.js';
import { goalValidation } from '../../validation/goal.js';
import { clearGoalWork } from '../../floor/endRun.js';
import { watchLabelFor } from '../../watchLabels.js';
import { fleetWorksUpstream, UPSTREAM_REPO } from '../../tickets/upstream.js';
import { modelLabelsFor } from '../../modelLabels.js';
import { watchCascadeTargets } from '../../issueRelations.js';
import { checked, IssueNumberParams, optionalText, requiredBoolean, requiredText } from '../validation.js';
import type { RouteContext } from './context.js';
import type { FilingTargetProbe, IssueFiled } from '../../wire.js';

/**
 * The operator's own arm of every verdict an agent can cast about an issue —
 * watch, conclusion, assay, delivery, shortfall — plus ending its run.
 *
 * Each of the five verdict routes writes the *harness's* record and never the
 * tracker: concluding an issue in the harness's own view is what stops the
 * re-pickup, while the tracker transition to a done state stays a human act.
 *
 * `/bug` is the exception that proves it. Raising a bug is not a verdict about
 * this issue at all — it is new work, filed into the tracker by a desk agent, and
 * it leaves the story's own record exactly where it found it.
 *
 * The two collection-level routes at the foot — `GET /api/issues/filing-target`
 * and `POST /api/issues` — are the same exception without the agent (issue #413):
 * they are about no issue in particular, which is why they carry no `:number`, and
 * they file what the operator already typed rather than dispatching somebody to
 * write it. They are also the only two on this surface that do not go near the
 * configured tracker at all: what they file is a report about **LubbDubb**, and it
 * belongs on LubbDubb's tracker whatever repo the fleet is pointed at (issue #449).
 */

/** Long enough for a repro with steps; short of pasting a log file in. */
const MAX_BUG_SUMMARY = 4000;

/** A tracker title is a headline; both providers truncate far above this anyway. */
const MAX_ISSUE_TITLE = 200;

/**
 * How long the filing-target probe may take before it is reported as unavailable.
 *
 * A live provider call is the point of the probe, and a rate-limited or wedged
 * GitHub is exactly the case it exists to catch — but a request that never answers
 * leaves the modal that fired it spinning with no way out, which is worse than the
 * failure it was checking for. So the slow answer and the dead one are reported the
 * same way, and the cockpit's fallback (the external new-issue form) is reachable
 * either way.
 */
const PROBE_TIMEOUT_MS = 8000;

/**
 * The probe's deadline. `finally` clears the timer on both arms, so a fast answer
 * leaves nothing pending behind it.
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

  // Toggle an issue's watch state from the cockpit. Issues are opt-in, so "watch"
  // adds the one tag and un-watching takes it off again — a single write, because
  // there is no second label to keep it exclusive with. Provider-agnostic through
  // the same outbound seam.
  //
  // **A container cascades.** Watching a Feature tags every descendant beneath it
  // (`watchCascadeTargets`), because a container is never worked itself: a tag on
  // one alone would be a click that changed nothing. Un-watching walks the same
  // tree, or a dropped feature would leave its stories tagged and still worked.
  //
  // The cascade is a real write per item and a partial failure is *reported*, not
  // swallowed — an operator who is told "watched" while three of eight children
  // kept the old tag has been lied to about what the harness will pick up.
  const WatchBody = z.object({ watched: requiredBoolean('watched must be a boolean') });
  app.post(
    '/api/issues/:number/watch',
    checked({ params: IssueNumberParams, body: WatchBody }, async ({ params, body, reply }) => {
      const { number: issueNumber } = params;
      const { watched } = body;
      const world = store.getWorldBaseline();
      const issue = world?.issues.find((i) => i.number === issueNumber);
      // An issue the snapshot does not carry still gets its own tag written — the
      // toggle must keep working for a world that has aged out — it simply has no
      // hierarchy to walk.
      const targets =
        issue === undefined
          ? [issueNumber]
          : watchCascadeTargets(issue, world?.issues ?? [], config.issueContainerTypes);

      const failed: { number: number; message: string }[] = [];
      for (const target of targets) {
        try {
          await connector.setIssueLabel({ number: target, label: watchLabel, present: watched });
        } catch (err) {
          const message = (err as Error).message;
          failed.push({ number: target, message });
          errors.record({
            source: 'server',
            message: `Failed to set the watch tag on #${target} while ${watched ? 'watching' : 'dropping'} #${issueNumber}: ${message}`,
          });
        }
      }

      // Whatever landed, landed — the world is now different from the one the
      // cockpit is showing even on a partial failure, so it is republished before
      // the refusal rather than after a success only.
      //
      // Folded onto the baseline first, and that ordering is the whole of why the
      // toggle changes under the click: `/api/state` serves the baseline, so a
      // broadcast ahead of the write just makes the cockpit redraw the old state.
      // The cycle below cannot be relied on for it either — it coalesces away to
      // nothing while another is in flight, which is most clicks on a busy fleet.
      // Only the targets whose write the provider took.
      const landed = targets.filter((t) => !failed.some((f) => f.number === t));
      store.patchWorldLabels({ issues: landed, label: watchLabel, present: watched });
      // And the mirror, which is a *second* reading of the same tag rather than a
      // copy of the first: the Tickets tab — the one surface with an explicit
      // Unwatch — draws the toggle and its watch filter from `/api/tickets`, which
      // is built from `tracker_items` and never from the baseline. Patched here
      // for the reason the baseline is, and the same one twice over: the sweep
      // that would otherwise carry it runs last in a cycle, and the cycle below
      // coalesces away to nothing while another is in flight (issue #417).
      store.patchTicketLabels({ numbers: landed, label: watchLabel, present: watched });
      hub.broadcast({ type: 'world:changed' });
      if (failed.length === targets.length) {
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
      return { ok: true, watched, cascaded: targets.length - 1 };
    }),
  );

  // Move a work item to one of the tracker's own states — the card view's drag, and
  // the first thing in the cockpit that writes one.
  //
  // **The state word is not validated here.** The provider owns its process
  // template: a check against the states the mirror has seen would refuse a
  // legitimately configured but still-empty column, and a check against nothing at
  // all is what lets the provider's own refusal reach the operator intact. The schema
  // asks only that a state was named.
  //
  // The capability *is* checked, because `setWorkItemState` throws where no
  // integration implements it — an exception the operator would read as this write
  // failing rather than as the deployment not having the operation at all.
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
        // The provider's own sentence, quoted whole: it is the only account of why the
        // card is going back where it came from, and a paraphrase would be the only
        // account there is.
        return reply.code(400).send({ error: message });
      }

      // Both readings, in this order, for the watch route's reasons: `/api/state`
      // serves the baseline, so a broadcast ahead of the write only makes the cockpit
      // redraw the old column; and the Tickets tab's own list is built from
      // `tracker_items`, which the sweep would carry only at the end of a cycle that
      // coalesces away while another is in flight.
      store.patchWorldState({ number, state });
      store.patchTicketState({ number, state });
      hub.broadcast({ type: 'world:changed' });
      await harness.runCycle('manual');
      return { ok: true, state };
    }),
  );

  // Pin this issue's work to a model profile, or clear the pin (issue #342).
  //
  // The write is a **label on the ticket**, through the same seam and for the same
  // reasons as the watch toggle above: it is visible where a human already looks,
  // it survives the harness's database, and Azure DevOps needs no separate answer.
  // Writing one profile clears the others, exactly as watch clears ignore — with
  // more than two names the pair-write becomes a sweep, but the property is the
  // same one, that the ticket carries at most one answer.
  //
  // It also **settles any standing proposal**, whichever way the operator went.
  // That is the click the gate is waiting for, and it is why "keep mine" works:
  // the tag deliberately goes on disagreeing with the assayer, so a gate that
  // re-read the disagreement would ask the same question for ever. What is stored
  // is that the question was answered, never what it was answered with — that is
  // the tag, and a second copy of it here would be free to drift.
  //
  // Unlike a hand-typed label, this cannot name a profile the deployment does not
  // have: config is refused at boot by name, and this is refused at the boundary
  // by name, which are the two halves of the same rule.
  // Absent or empty clears the pin, which is the same shape every other optional
  // text body in this file uses — and the right one here: "no profile" is the
  // state a ticket starts in, not a third value.
  const ProfileBody = z.object({ profile: optionalText('profile') });
  app.post(
    '/api/issues/:number/profile',
    checked({ params: IssueNumberParams, body: ProfileBody }, async ({ params, body, reply }) => {
      const { number: issueNumber } = params;
      const wanted = body.profile ?? null;
      const labels = modelLabelsFor(config.labelPrefix, config.agentModels);
      if (labels.length === 0)
        return reply
          .code(400)
          .send({ error: 'This deployment configures no agentModels.profiles, so there is nothing to pin to.' });
      if (wanted !== null && !labels.some((l) => l.profile === wanted))
        return reply.code(400).send({
          error: `"${wanted}" is not one of this deployment's profiles: ${labels.map((l) => l.profile).join(', ')}.`,
        });

      try {
        for (const { profile, label } of labels)
          await connector.setIssueLabel({ number: issueNumber, label, present: profile === wanted });
      } catch (err) {
        const message = (err as Error).message;
        errors.record({ source: 'server', message: `Failed to set the model tag on #${issueNumber}: ${message}` });
        // Republished before the refusal for the watch route's reason: a partial
        // sweep has already changed the world the cockpit is showing.
        hub.broadcast({ type: 'world:changed' });
        return reply.code(400).send({ error: message });
      }

      // The answer, if a proposal was waiting on one. Keyed on the row's own
      // fingerprint so it settles the question the operator was actually shown.
      const origin = issueConclusionOrigin(issueNumber);
      const assay = store.getAssay(origin);
      const answered = assay !== null && store.answerAssayProfile(origin, assay.goalRef);

      hub.broadcast({ type: 'world:changed' });
      await harness.runCycle('manual');
      return { ok: true, profile: wanted, answered };
    }),
  );

  // Settle one of a goal's two **placement** questions: which container it hangs
  // off, and which area node it sits on. One route each, and each takes the three
  // answers the assay's proposal has — take it, use a different value, or say it
  // does not apply.
  //
  // The write is the harness's, never an agent's, and never a shell command in a
  // prompt: it goes through `ActionSink` exactly as the watch toggle and the
  // profile pin do, for `src/tickets/filing.ts`'s reason. What an agent proposed
  // is a suggestion; what changes the tracker is a click here.
  //
  // Every answer stamps the row, including the two that also change the work item.
  // The question's visibility is derived from the live item, and that read is a
  // pulse behind this write — a row that came back for one refresh would read as a
  // click that did not take.
  //
  // Nothing here holds anything up, so nothing here runs a cycle for urgency's
  // sake — the manual cycle is only what refreshes the world the cockpit is
  // showing, the way the profile route's does.
  const PlacementBody = z.object({
    // Absent is the third answer — "this goal wants no parent" — rather than a
    // missing field: the route settles the question either way, and a separate
    // `/dismiss` route would be a second place the goal-ref scoping is written.
    parent: z.number().int().positive().optional(),
  });
  app.post(
    '/api/issues/:number/parent',
    checked({ params: IssueNumberParams, body: PlacementBody }, async ({ params, body, reply }) => {
      const outcome = await settlePlacement(params.number, 'parent', async () => {
        if (body.parent === undefined) return;
        await connector.setWorkItemParent({ number: params.number, parentNumber: body.parent });
      });
      if (!outcome.ok) return reply.code(400).send({ error: outcome.error });
      return { ok: true, parent: body.parent ?? null, settled: outcome.settled };
    }),
  );

  const AreaPathBody = z.object({ areaPath: optionalText('areaPath') });
  app.post(
    '/api/issues/:number/area-path',
    checked({ params: IssueNumberParams, body: AreaPathBody }, async ({ params, body, reply }) => {
      const outcome = await settlePlacement(params.number, 'areaPath', async () => {
        if (body.areaPath === undefined) return;
        await connector.setWorkItemAreaPath({ number: params.number, areaPath: body.areaPath });
      });
      if (!outcome.ok) return reply.code(400).send({ error: outcome.error });
      return { ok: true, areaPath: body.areaPath ?? null, settled: outcome.settled };
    }),
  );

  /**
   * The half both placement routes share: refuse where nothing can write one, make
   * the write, stamp the row the operator was looking at, and republish.
   *
   * The refusal is asked of the **connector** rather than inferred from the
   * provider name, exactly as the work-item-state route asks: the one place that
   * decides is the one the route asks. It is drawn nowhere either — the question
   * is only ever raised where a proposal exists, and a proposal only exists on a
   * tracker that has these fields — so this is the floor under that rather than a
   * case anybody meets.
   *
   * The row is stamped **after** a successful write and not before: a stamp on a
   * write that then failed would settle a question nobody answered, and the
   * operator would be left with a tracker unchanged and a cockpit that had stopped
   * asking.
   */
  async function settlePlacement(
    issueNumber: number,
    field: 'parent' | 'areaPath',
    write: () => Promise<void>,
  ): Promise<{ ok: true; settled: boolean } | { ok: false; error: string }> {
    if (!connector.canPlaceWorkItem())
      return {
        ok: false,
        error: "This deployment's tracker has no parent or area path to set.",
      };
    try {
      await write();
    } catch (err) {
      const message = (err as Error).message;
      errors.record({ source: 'server', message: `Failed to place #${issueNumber}: ${message}` });
      return { ok: false, error: message };
    }
    const origin = issueConclusionOrigin(issueNumber);
    const assay = store.getAssay(origin);
    const settled = assay !== null && store.settleAssayPlacement(origin, assay.goalRef, field);
    hub.broadcast({ type: 'world:changed' });
    await harness.runCycle('manual');
    return { ok: true, settled };
  }

  // Mark this goal a priority, or clear the mark: everything the harness dispatches
  // under it ranks ahead of the natural cross-rule order until it is cleared.
  //
  // The harness's own record and not a tracker label, unlike the watch and profile
  // routes above. Those two are statements about the *goal* that a human reading
  // the ticket needs; this is a statement about **this deployment's queue** — what
  // its fleet works next while it is short of slots — and a label saying so would
  // claim something the tracker cannot honour and every other deployment reading
  // the same board would inherit.
  //
  // A cycle is run immediately for the reason `/api/upnext/order` runs one: the
  // ranking is what changed, so the operator should see the new queue rather than
  // wait a heartbeat to find out whether the click did anything. It is safe to run
  // for the same reason too — the flag only re-orders, and never un-holds an item
  // held by a cooldown, a cap, an unapproved plan or an ignore tag.
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

  // Set (or clear) an issue's conclusion by hand — the operator's override of what
  // the agent that worked it said, and of what its plan derives.
  //
  // It writes the *harness's* record, not the tracker: nothing here moves the work
  // item, because concluding an issue in the harness's own view is what stops the
  // re-pickup, while the tracker transition to a done state stays a human act (in
  // the workflow this was built for, a finished item is still waiting on test).
  // Rule `work-item-back-to-pickup` then reads the verdict on the next cycle, which is why `more_work`
  // runs one immediately — the operator's "no, there's more here" should bounce
  // the item back to pickup now rather than on the next heartbeat.
  // The cockpit writes `more_work` through `/instruction` rather than here, since a
  // bounce-back carrying none of what the operator wants is the weaker half of what
  // they were doing. This arm stays: it is the API's way to say it, and it is what
  // `null` clears.
  // `null` is a member of the verdict rather than an absence, because it is what
  // clears the row — and absence is refused, since a body that names no verdict
  // asks for nothing.
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
        // An operator toggling from the cockpit has the row itself as context, so
        // unlike the tool a note is optional here; the default says who decided.
        note: note ?? 'Set by the operator from the cockpit.',
        by: 'operator',
      });
      hub.broadcast({ type: 'world:changed' });
      if (verdict === 'more_work') await harness.runCycle('manual');
      return { ok: true, conclusion };
    }),
  );

  // Tell the fleet what to do on a goal, in the operator's own words — "change the
  // button to primary", "the permission is wrong", "the loading icon is broken".
  //
  // This is what the bare `more_work` toggle became. That toggle bounced the item
  // back to pickup carrying a fixed note, so the next agent re-read the ticket that
  // had already produced the thing the operator was unhappy with; the words are the
  // whole feature (see src/goalInstructions.ts).
  //
  // It writes **two** rows, and both are load-bearing. The instruction is what
  // reaches the agent — appended to every dispatch on the goal until one concludes
  // it — and the conclusion is what makes there *be* a next dispatch: rule
  // `work-item-back-to-pickup` acts on an explicit `more_work` and on nothing else,
  // so an instruction without one would sit unread on a parked item. The verdict's
  // note deliberately does not repeat the instruction: one fact rendered twice in a
  // prompt reads as two, and the briefing renders a conclusion's note.
  //
  // The cycle runs for the toggle's reason, sharpened — an operator who has just
  // said what they want should not wait a heartbeat to be listened to.
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
      const originRef = issueConclusionOrigin(params.number);
      const instruction = store.addIssueInstruction({ originRef, text: body.text });
      // The conclusion is a *means* — it is what makes there be a next dispatch to
      // read the words — and on a delivered goal there already is one: rule
      // `issue-retro` fires on the delivery, and `instructionsFor` deliberately
      // includes the retro origin. Writing it anyway would clear the delivery
      // (`VERDICT_EXCLUSIONS.conclusion`), which un-parks the assessor and re-blocks
      // the retrospective and every handed-over validation check — all three gate on
      // `deliveryParked`. Nothing errors and the instruction still lands, so the
      // whole cost is silent: a goal that was finished goes back round for pickup
      // because somebody wrote a note on it.
      const conclusion = store.getDelivery(originRef)
        ? null
        : store.recordIssueConclusion({
            originRef,
            verdict: 'more_work',
            note: 'The operator wrote an instruction for this goal — it is in front of the next agent.',
            by: 'operator',
          });
      hub.broadcast({ type: 'world:changed' });
      await harness.runCycle('manual');
      return { ok: true, instruction, conclusion };
    }),
  );

  // Take one back. The escape hatch every write on this surface has, and the only
  // way an instruction stops standing other than an agent concluding the goal.
  //
  // Withdrawing the **last** one clears the operator's `more_work` with it, and
  // only ever that one: the two rows were written together, so leaving the verdict
  // behind would keep bouncing the item back to pickup for words nobody is going to
  // read. An agent's own declaration is left exactly where it was found — it is
  // about the work, not about the instruction.
  const InstructionParams = IssueNumberParams.extend({ id: z.string() });
  app.delete(
    '/api/issues/:number/instruction/:id',
    checked({ params: InstructionParams }, async ({ params, reply }) => {
      if (!store.withdrawInstruction(params.id))
        return reply.code(409).send({ error: 'no standing instruction with that id' });
      const originRef = issueConclusionOrigin(params.number);
      const standing = store.listStandingInstructions(originRef);
      const conclusion = store.getIssueConclusion(originRef);
      if (standing.length === 0 && conclusion?.by === 'operator' && conclusion.verdict === 'more_work')
        store.clearIssueConclusion(originRef);
      hub.broadcast({ type: 'world:changed' });
      return { ok: true, standing: standing.length };
    }),
  );

  // Override a goal assay — the escape hatch a blocking gate has to have.
  //
  // `unclear` is the only verdict that stops anything, and it stops it for an issue
  // the operator has explicitly tagged for the harness. So the operator must be able
  // to say "work it anyway" without editing the ticket to say something they do not
  // mean, and must be able to say "no, this really is unworkable" without waiting for
  // an agent to agree. Both arms are here.
  //
  // Clearing is a delete rather than a stored third verdict, for `clearDelivery`'s
  // reason: the absence of an assay keeps exactly one representation, and it is
  // also the state a crashed assayer leaves behind — the fail-open. The goal
  // fingerprint of an operator's verdict is taken from the issue as the harness
  // currently sees it, so it expires on the next edit exactly as an agent's does.
  const AssayBody = z.object({
    verdict: z.union([z.literal('workable'), z.literal('unclear'), z.null()], {
      errorMap: () => ({ message: 'verdict must be "workable", "unclear" or null' }),
    }),
    summary: optionalText('summary'),
  });
  app.post(
    '/api/issues/:number/assay',
    checked({ params: IssueNumberParams, body: AssayBody }, async ({ params, body, reply }) => {
      const { number: issueNumber } = params;
      const { verdict, summary } = body;
      const originRef = issueConclusionOrigin(issueNumber);
      if (verdict === null) {
        store.clearAssay(originRef);
        hub.broadcast({ type: 'world:changed' });
        // Clearing a hold is a request to reconsider the issue now, not next beat.
        await harness.runCycle('manual');
        return { ok: true, assay: null };
      }
      // The text the verdict is about, from the world the cockpit is showing. Absent
      // (an issue the last snapshot did not carry) is refused rather than guessed: a
      // verdict fingerprinted against an empty goal would expire the instant the
      // issue was next fetched, which is a silent no-op dressed as an override.
      const issue = store.getWorldBaseline()?.issues.find((i) => i.number === issueNumber);
      if (!issue) return reply.code(404).send({ error: 'issue not in the last world snapshot' });
      const assay = store.recordAssay({
        originRef,
        verdict,
        // As on the conclusion and delivery routes, an operator has the item in front
        // of them, so the summary is optional and the default says who decided.
        summary: summary ?? 'Set by the operator from the cockpit.',
        goalRef: goalFingerprint(issue.title, issue.body),
        by: 'operator',
      });
      hub.broadcast({ type: 'world:changed' });
      // A `workable` override releases the issue into the funnel — act on it now.
      if (verdict === 'workable') await harness.runCycle('manual');
      return { ok: true, assay };
    }),
  );

  // Park an issue as delivered by hand, or release one the assessor parked.
  //
  // The operator's own arm of the same verdict rule `issue-assess`'s agent casts, and the
  // escape hatch for it — an operator looking at a finished issue must not have to
  // wait for an agent to agree, and one looking at a wrongly-parked issue must be
  // able to say so without moving the ticket. It writes the *harness's* record and
  // never the tracker: `delivered` is deliberately weaker than `closed`, and
  // closing the ticket stays a human act performed in the tracker itself.
  //
  // Clearing is a delete rather than a stored "not delivered", so the absence of a
  // verdict keeps exactly one representation — `clearIssueConclusion`'s reason.
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
        // As on the conclusion route, an operator has the row in front of them, so
        // the summary is optional and the default says who decided.
        summary: summary ?? 'Marked delivered by the operator.',
        by: 'operator',
      });
      hub.broadcast({ type: 'world:changed' });
      return { ok: true, delivery };
    }),
  );

  // Say that this goal is not waiting on an environment, or put it back to
  // waiting.
  //
  // The escape hatch an environment gate has to have. With `arrival.opens`
  // configured, a delivered goal's `validate` and `close_out` rows are withheld
  // until its work reaches the environment that opens them — and a goal that is
  // never going to reach one (a docs change, a config change, work whose
  // deployment nothing here can see) would otherwise sit delivered with an empty
  // bench for good, which is the harness losing an obligation rather than holding
  // it.
  //
  // The note is required by {@link GateReleaseBody}, unlike every other operator
  // verdict's summary — the rule and its reasoning live beside the release itself.
  // Clearing is a delete, for `clearIssueConclusion`'s reason.
  app.post(
    '/api/issues/:number/environment-gate',
    checked({ params: IssueNumberParams, body: GateReleaseBody }, async ({ params, body }) => {
      const goalRef = issueConclusionOrigin(params.number);
      if (!body.released) {
        store.clearEnvironmentGateRelease(goalRef);
        hub.broadcast({ type: 'world:changed' });
        return { ok: true, released: null };
      }
      // `note` is required alongside `released` by the schema's own refine, so
      // this is a narrowing rather than a check.
      const release = store.releaseEnvironmentGate(goalRef, body.note ?? '');
      hub.broadcast({ type: 'world:changed' });
      // The obligations it opens are filed by desks on the pulse, so the row an
      // operator just asked for arrives now rather than on the next beat.
      await harness.runCycle('manual');
      return { ok: true, released: release };
    }),
  );

  // Record by hand that an issue was worked and its goal is not reached, or clear
  // a standing shortfall.
  //
  // The operator's own arm of the assessor's negative verdict, and — more
  // importantly — the escape hatch it has to have. A shortfall lives until the arm
  // it named is performed, and *rejecting* the proposal deliberately leaves it
  // standing (the verdict is still true; you simply declined to act on it). So
  // without this the row and its chip would stand for good, with no way to say
  // "no, that is settled now" short of marking the issue delivered, which claims
  // something different.
  //
  // Clearing is a delete rather than a stored "no shortfall", for
  // `clearIssueConclusion`'s reason. Writing one clears any standing delivery, in
  // the store — the two are opposite answers to one question.
  //
  // The body's own rules — the absent / explicit-`null` / named-cause tri-state
  // and the one cross-field refinement on this surface — live in
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
        // As on the conclusion and delivery routes, an operator has the row in front
        // of them, so the summary is optional and the default says who decided.
        summary: body.summary ?? 'Marked as not delivered by the operator.',
        by: 'operator',
      });
      hub.broadcast({ type: 'world:changed' });
      return { ok: true, shortfall };
    }),
  );

  // Overrule a standing shortfall: the assessment is wrong, and here is the
  // correction in the operator's own words.
  //
  // ## The gap this closes
  //
  // The shortfall card offers accept and reject, and neither says this. Accepting
  // spends an agent on a follow-up part for work that is already done; rejecting
  // means "do not act on it", which deliberately leaves the verdict standing — so
  // rule `issue-assess` dispatches again, the fresh assessor reads the same
  // repository, and records the same shortfall. Nothing the operator can type into
  // that card survives the loop either: `shortfallRef` is nobody's dispatch origin,
  // so `rejectionGuidance` reaches no agent with the note (see
  // {@link file://../../delivery/shortfall.ts}). An operator who knew exactly why
  // the assessment was wrong had no way to say it that anything would read.
  //
  // ## Why it writes two rows
  //
  // `/instruction`'s arrangement, for its reason — half of this does nothing.
  //
  // The **delivery** is the verdict: it clears the shortfall through the exclusion
  // matrix rather than by a hand-rolled `DELETE`, parks the assessor that would
  // otherwise re-derive it, and releases the three things gated on `deliveryParked`
  // — `issue-retro`, `validate-check` and the close-out obligation. Those are the
  // steps that come after delivery, and while a shortfall stands none of them can
  // run at all.
  //
  // The **instruction** is what gets the correction into the record. The harness
  // never edits the ticket itself — only an agent can tell "this changes the goal"
  // from "this is a note about how to do the work" — so the instruction block is
  // the one mechanism there is, and it already carries the tracker's own read/amend
  // commands. On a delivered goal it lands in front of the retrospective agent,
  // which is dispatched by the delivery this same call writes.
  //
  // One text, in both: the operator's words are the summary of *why* it is
  // delivered and the correction to be written down, and quoting them twice from
  // one field is what keeps the two from drifting.
  //
  // The **proposal is not settled here.** Rejecting it is the cockpit's existing
  // call and the honest verb for "no follow-up part" — folding it in would give
  // this route a second opinion about a settlement `/api/proposals/:id/reject`
  // already owns.
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
      const originRef = issueConclusionOrigin(params.number);
      // Refused rather than degraded into a plain "mark it delivered": this route
      // says one specific thing — *that* verdict is wrong — and with nothing
      // standing there is no verdict to be wrong. An operator who means the plain
      // thing has `/delivered` for it.
      if (!store.getShortfall(originRef)) return reply.code(409).send({ error: 'no standing shortfall to overrule' });
      const delivery = store.recordDelivery({ originRef, summary: body.text, by: 'operator' });
      const instruction = store.addIssueInstruction({ originRef, text: body.text });
      hub.broadcast({ type: 'world:changed' });
      // The retrospective this releases should be dispatched now rather than on the
      // next heartbeat — the operator has just answered the question that was
      // holding the goal, and the write-up is what carries their answer onward.
      await harness.runCycle('manual');
      return { ok: true, delivery, instruction };
    }),
  );

  // End a run (issues #203, #234). The only thing that ends one — no pulse, poll
  // or ticket close does — and it persists across a restart. Since #234 it stops
  // the dispatcher as well as removing the card: a dismissed run is not unioned
  // back into the issue list, so nothing is scheduled for it again. Idempotent:
  // dismissing an already-dismissed or unrecorded run is a no-op 409, not an error
  // state. One-way; how it ended (`judged` / `abandoned`) is stamped from the row.
  //
  // **It is destructive, and the destruction is the point.** Stopping the
  // dispatcher only governs what is *started*, so it left the goal's live agents,
  // its queued jobs and its standing instructions running on under a run the
  // cockpit had already drawn as over. `clearGoalWork` ends those too, and the
  // counts come back so the cockpit can say what it just did rather than a bare
  // `ok` (`src/floor/endRun.ts`).
  //
  // **A flagged validation plan costs a sentence here**, and this is the sharper
  // of the two places it does: the close-out obligation is an ask an operator may
  // never open, but this is the button that ends the harness's run at a goal, it
  // is one-way, and it is exactly the "close the goal and move on" it is named
  // after. It still blocks nothing — the note is the whole of the requirement,
  // and it is kept on the run so what the goal owed and what was said about it
  // survive together.
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
      // The other half of ending a run, and the half the dismissal alone never did:
      // stopping the dispatcher says what will not be *started*, so without this the
      // goal's live agents kept working, its queued job took the next slot and its
      // standing instructions waited for whoever picked it up — all under a run the
      // cockpit had already drawn as over. Below the dismissal, so a 409 clears
      // nothing.
      const cleared = clearGoalWork(store, system.agents, params.number);
      hub.broadcast({ type: 'dirty' });
      return { ok: true, cleared };
    }),
  );

  // Raise a bug against a story: the operator ran the thing and it does not do what
  // they expect. The one route on this surface that files into the **tracker**
  // rather than writing the harness's own record — and the only one carrying a fact
  // no agent can derive, since none of them ran the feature.
  //
  // The story's verdict is deliberately untouched. The bug is its own work item and
  // carries the work, which is also the only arrangement where the fleet is handed
  // the operator's actual words as the goal — a `more_work` verdict here would give
  // the next agent the weaker of the two briefs (see src/bugFiling.ts).
  //
  // `summary` is required where every other body on this surface takes an optional
  // one: elsewhere the operator has the row in front of them and the default says
  // who decided, but here their report *is* the feature, and an empty one asks for
  // nothing.
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
      // The assay route's check, for its reason: an override on an issue the harness
      // has never seen would be a silent no-op dressed as an action.
      const issue = store.getWorldBaseline()?.issues.find((i) => i.number === issueNumber);
      if (!issue) return reply.code(404).send({ error: 'issue not in the last world snapshot' });
      // With no tracker configured there is nowhere to file — the same gate all four
      // filing arms ask. The cockpit hides the button in this case, so reaching here
      // means a direct call.
      const tracker = trackerCoordinates(config);
      if (!tracker)
        return reply
          .code(409)
          .send({ error: 'no issue tracker is configured to file into (the issues provider is fake or unconfigured)' });

      // The body last, after every 404/409 the store answers — the order both other
      // filing routes use, and `checked` applied by hand is what keeps the refusal
      // path one.
      return checked({ body: RaiseBugBody }, async ({ body }) => {
        const derived = bugTicketFields(issue, body.summary, tracker);
        const title = body.title ?? derived.title;
        // Rendered from the operator's template book, not built here: how a bug should
        // be worded is exactly the sort of house style an override exists for. The
        // duplicate candidates are **appended** rather than given a placeholder, so an
        // override that never learned about them cannot silently drop them.
        const candidates = renderCandidates(dedupeCandidates(store.listTrackerItems(), body.summary));
        const prompt = [system.prompts.render('raise-bug', derived.vars), candidates]
          .filter((part) => part !== null)
          .join('\n\n');
        // Desk, not code: filing touches no repository. The operator's report rides in
        // this prompt and is not stored again — see src/store/bugFilings.ts.
        const job = store.createJob({ title, prompt, kind: 'desk' });
        // Job first, then the filing row — a failed create leaves nothing behind.
        const filing = store.createBugFiling({ jobId: job.id, originRef: issueConclusionOrigin(issueNumber) });
        hub.broadcast({ type: 'world:changed' });
        // The operator's report should reach the fleet now, not on the next heartbeat.
        const report = await harness.runCycle('manual');
        return { ok: true, filing, job, report };
      })(req, reply);
    }),
  );

  // -------------------------------------------------------------------------
  // Raising an issue about LubbDubb from the cockpit (issues #413, #449)
  //
  // Two collection-level routes, and neither is about an issue that exists — nor
  // about the tracker the rest of this file writes to. Both go through
  // `system.upstream`, which files into LubbDubb's own repository through the `gh`
  // CLI: the probe answers "can I file, where, and as whom" from a live call, and
  // the create files what the operator typed. No agent and no model, either way.
  // -------------------------------------------------------------------------

  // The live half of the gate on the top bar's compose modal. `gh` is asked
  // whether it can answer at all, and as whom, because that is the one thing about
  // filing here that nothing else can prove: the harness's own `GITHUB_TOKEN` is
  // scoped to the repo the fleet works on and has no bearing on this destination.
  //
  // Every failure arm is a 200 carrying `available: false` and a reason, never a
  // 5xx: a logged-out CLI is an answer to the question that was asked, and the
  // caller is a modal that wants to say why it is falling back rather than one that
  // wants an exception. The failure is still *recorded* — an operator whose `gh`
  // login has lapsed should find that in the Errors panel and not only in a modal
  // they closed.
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

  // File the operator's own report about LubbDubb, directly. The one route on this
  // surface that creates a tracker item without a desk agent between the click and
  // the create: the operator has already written the thing up, and dispatching
  // somebody to re-type it would cost a model call to add nothing (see `/bug`
  // above, where the dedupe and the write-up are the point).
  //
  // It goes through `system.upstream` and **not** `system.filing`, which is the
  // whole of issue #449: `ticketFiler` files into the tracker the fleet is pointed
  // at, and this is a bug report about the cockpit. The type/assignee resolution
  // the other filing arms need does not arise — one repository, no work item types,
  // and the byline is the operator's own `gh` login rather than the harness's
  // credential.
  //
  // **`watch` is opt-in, defaults off, and is only honoured where it can mean
  // anything.** The label is what makes the fleet pick an issue up, so defaulting
  // it on would mean an operator's half-formed thought is being worked before they
  // have finished reading it back — and on a deployment whose fleet works some
  // other repo it is dropped, because the report lands where those agents never
  // look. The probe says which, so the modal does not draw a box that does nothing.
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
        // `/api/work/:ref/file`'s arm: the CLI refusing is an answer, not an
        // unanticipated fault, so it is a 502 with its own words and the modal keeps
        // what the operator typed.
        const message = (err as Error).message;
        errors.record({ source: 'provider', message: `filing an issue from the cockpit failed: ${message}` });
        return reply.code(502).send({ error: `${UPSTREAM_REPO} refused the issue: ${message}` });
      }
      // No cycle and no broadcast, unlike every other filing route. What was created
      // is in LubbDubb's tracker, which on all but the dogfooding deployment this
      // harness does not sweep at all — and on that one the next pulse finds it. The
      // modal's success state is the address of the thing, not a row in the world
      // the cockpit draws, so there is nothing here for a refresh to reveal.
      const answer: IssueFiled = { ok: true, number: filed.number, url: filed.url };
      return answer;
    }),
  );
}
