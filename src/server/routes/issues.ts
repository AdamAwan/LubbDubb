import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { issueConclusionOrigin } from '../../issueConclusion.js';
import { goalFingerprint } from '../../intake/assay.js';
import { ShortfallBody } from '../../delivery/shortfall.js';
import { watchLabelsFor } from '../../watchLabels.js';
import { checked, IssueNumberParams, optionalText, requiredBoolean } from '../validation.js';
import type { RouteContext } from './context.js';

/**
 * The operator's own arm of every verdict an agent can cast about an issue —
 * watch, conclusion, assay, delivery, shortfall — plus ending its run.
 *
 * Each of the five verdict routes writes the *harness's* record and never the
 * tracker: concluding an issue in the harness's own view is what stops the
 * re-pickup, while the tracker transition to a done state stays a human act.
 */
export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store, connector, harness, config } = system;
  const { watchLabel, ignoreLabel } = watchLabelsFor(config.labelPrefix);

  // Toggle an issue's watch/ignore state from the cockpit. Issues are opt-in, so
  // "watch" adds the watch tag (and clears any ignore tag) and "ignore" adds the
  // ignore tag (and clears the watch tag) — the write pair keeps the two labels
  // mutually exclusive. Provider-agnostic through the same outbound seam.
  const WatchBody = z.object({ watched: requiredBoolean('watched must be a boolean') });
  app.post(
    '/api/issues/:number/watch',
    checked({ params: IssueNumberParams, body: WatchBody }, async ({ params, body, reply }) => {
      const { number: issueNumber } = params;
      const { watched } = body;
      try {
        await connector.setIssueLabel({ number: issueNumber, label: watchLabel, present: watched });
        await connector.setIssueLabel({ number: issueNumber, label: ignoreLabel, present: !watched });
        hub.broadcast({ type: 'world:changed' });
        await harness.runCycle('manual');
        return { ok: true, watched };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
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
  app.post(
    '/api/issues/:number/dismiss-run',
    checked({ params: IssueNumberParams }, async ({ params, reply }) => {
      const dismissed = store.dismissIssueRun(issueConclusionOrigin(params.number));
      if (!dismissed) return reply.code(409).send({ error: 'no run to dismiss' });
      hub.broadcast({ type: 'dirty' });
      return { ok: true };
    }),
  );
}
