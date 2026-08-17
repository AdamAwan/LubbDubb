import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { issueConclusionOrigin } from '../../issueConclusion.js';
import { bugTicketFields, bugTrackerCoordinates } from '../../bugFiling.js';
import { MAX_INSTRUCTION } from '../../goalInstructions.js';
import { goalFingerprint } from '../../intake/assay.js';
import { ShortfallBody } from '../../delivery/shortfall.js';
import { validationHeadline } from '../../delivery/closeOut.js';
import { goalValidation } from '../../validation/goal.js';
import { watchLabelsFor } from '../../watchLabels.js';
import { modelLabelsFor } from '../../modelLabels.js';
import { watchCascadeTargets } from '../../issueRelations.js';
import { checked, IssueNumberParams, optionalText, requiredBoolean } from '../validation.js';
import type { RouteContext } from './context.js';

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
 */

/** Long enough for a repro with steps; short of pasting a log file in. */
const MAX_BUG_SUMMARY = 4000;

export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store, connector, harness, config, errors } = system;
  const { watchLabel, ignoreLabel } = watchLabelsFor(config.labelPrefix);

  // Toggle an issue's watch/ignore state from the cockpit. Issues are opt-in, so
  // "watch" adds the watch tag (and clears any ignore tag) and "ignore" adds the
  // ignore tag (and clears the watch tag) — the write pair keeps the two labels
  // mutually exclusive. Provider-agnostic through the same outbound seam.
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
      // An issue the snapshot does not carry still gets its own pair written — the
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
          await connector.setIssueLabel({ number: target, label: ignoreLabel, present: !watched });
        } catch (err) {
          const message = (err as Error).message;
          failed.push({ number: target, message });
          errors.record({
            source: 'server',
            message: `Failed to set watch tags on #${target} while ${watched ? 'watching' : 'dropping'} #${issueNumber}: ${message}`,
          });
        }
      }

      // Whatever landed, landed — the world is now different from the one the
      // cockpit is showing even on a partial failure, so it is republished before
      // the refusal rather than after a success only.
      hub.broadcast({ type: 'world:changed' });
      if (failed.length === targets.length) {
        return reply.code(400).send({ error: failed[0]?.message ?? 'no watch tag could be written' });
      }
      await harness.runCycle('manual');
      if (failed.length > 0) {
        return reply.code(400).send({
          error:
            `Tagged ${targets.length - failed.length} of ${targets.length} items; ` +
            `#${failed.map((f) => f.number).join(', #')} kept the old tags: ${failed[0]?.message ?? ''}`,
        });
      }
      return { ok: true, watched, cascaded: targets.length - 1 };
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
      const conclusion = store.recordIssueConclusion({
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

  // End a run (issues #203, #234). The only thing that ends one — no pulse, poll
  // or ticket close does — and it persists across a restart. Since #234 it stops
  // the dispatcher as well as removing the card: a dismissed run is not unioned
  // back into the issue list, so nothing is scheduled for it again. Idempotent:
  // dismissing an already-dismissed or unrecorded run is a no-op 409, not an error
  // state. One-way; how it ended (`judged` / `abandoned`) is stamped from the row.
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
      hub.broadcast({ type: 'dirty' });
      return { ok: true };
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
      // A desk agent runs in a scratch dir with no remote to infer the target from;
      // without coordinates there is nowhere to file. The cockpit hides the button
      // in this case, so reaching here means a direct call.
      const tracker = bugTrackerCoordinates(config, issueNumber);
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
        // be worded is exactly the sort of house style an override exists for.
        const prompt = system.prompts.render('raise-bug', derived.vars);
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
}
