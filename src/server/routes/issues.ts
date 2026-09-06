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

// → docs/spec/16-http-api.md

const MAX_BUG_SUMMARY = 4000;

const MAX_ISSUE_TITLE = 200;

const PROBE_TIMEOUT_MS = 8000;

function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store, connector, harness, config, errors } = system;
  const watchLabel = watchLabelFor(config.labelPrefix);

  const WatchBody = z.object({ watched: requiredBoolean('watched must be a boolean') });
  app.post(
    '/api/issues/:number/watch',
    checked({ params: IssueNumberParams, body: WatchBody }, async ({ params, body, reply }) => {
      const { number: issueNumber } = params;
      const { watched } = body;
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

      hub.broadcast({ type: 'world:changed' });
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
        return reply.code(400).send({ error: message });
      }

      store.patchWorldState({ number, state });
      store.patchTicketState({ number, state });
      hub.broadcast({ type: 'world:changed' });
      await harness.runCycle('manual');
      return { ok: true, state };
    }),
  );

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
        if (outcome.wrote) hub.broadcast({ type: 'world:changed' });
        return reply.code(400).send({ error: outcome.error });
      }
      hub.broadcast({ type: 'world:changed' });
      await harness.runCycle('manual');
      return { ok: true, profile: outcome.profile, answered: outcome.answered };
    }),
  );

  const PlacementBody = z.object({
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
      if (verdict === null) {
        store.clearIssueConclusion(originRef);
        hub.broadcast({ type: 'world:changed' });
        return { ok: true, verdict: null };
      }
      const conclusion = store.recordIssueConclusion({
        originRef,
        verdict,
        note: note ?? 'Set by the operator from the cockpit.',
        by: 'operator',
      });
      hub.broadcast({ type: 'world:changed' });
      if (verdict === 'more_work') await harness.runCycle('manual');
      return { ok: true, conclusion };
    }),
  );

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
        await harness.runCycle('manual');
        return { ok: true, appraisal: null };
      }
      const issue = store.getWorldBaseline()?.issues.find((i) => i.number === issueNumber);
      if (!issue) return reply.code(404).send({ error: 'issue not in the last world snapshot' });
      const appraisal = store.recordAppraisal({
        originRef,
        verdict,
        summary: summary ?? 'Set by the operator from the cockpit.',
        goalRef: goalFingerprint(issue.title, issue.body),
        by: 'operator',
      });
      hub.broadcast({ type: 'world:changed' });
      if (verdict === 'workable') await harness.runCycle('manual');
      return { ok: true, appraisal };
    }),
  );

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
        await harness.runCycle('manual');
        return { ok: true, delivered: false };
      }
      const delivery = store.recordDelivery({
        originRef,
        summary: summary ?? 'Marked delivered by the operator.',
        by: 'operator',
      });
      hub.broadcast({ type: 'world:changed' });
      return { ok: true, delivery };
    }),
  );

  app.post(
    '/api/issues/:number/environment-gate',
    checked({ params: IssueNumberParams, body: GateReleaseBody }, async ({ params, body }) => {
      const goalRef = issueConclusionOrigin(params.number);
      if (!body.released) {
        store.clearEnvironmentGateRelease(goalRef);
        hub.broadcast({ type: 'world:changed' });
        return { ok: true, released: null };
      }
      const release = store.releaseEnvironmentGate(goalRef, body.note ?? '');
      hub.broadcast({ type: 'world:changed' });
      await harness.runCycle('manual');
      return { ok: true, released: release };
    }),
  );

  app.post(
    '/api/issues/:number/shortfall',
    checked({ params: IssueNumberParams, body: ShortfallBody }, async ({ params, body }) => {
      const { number: issueNumber } = params;
      const originRef = issueConclusionOrigin(issueNumber);
      if (body.cause === null) {
        store.clearShortfall(originRef);
        hub.broadcast({ type: 'world:changed' });
        await harness.runCycle('manual');
        return { ok: true, shortfall: null };
      }
      const shortfall = store.recordShortfall({
        originRef,
        cause: body.cause ?? null,
        partSlug: body.part ?? null,
        summary: body.summary ?? 'Marked as not delivered by the operator.',
        by: 'operator',
      });
      hub.broadcast({ type: 'world:changed' });
      return { ok: true, shortfall };
    }),
  );

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
      await harness.runCycle('manual');
      return { ok: true, delivery, instruction };
    }),
  );

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
      const cleared = clearGoalWork(store, system.agents, params.number);
      hub.broadcast({ type: 'dirty' });
      return { ok: true, cleared };
    }),
  );

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
      const issue = store.getWorldBaseline()?.issues.find((i) => i.number === issueNumber);
      if (!issue) return reply.code(404).send({ error: 'issue not in the last world snapshot' });
      const tracker = trackerCoordinates(config);
      if (!tracker)
        return reply
          .code(409)
          .send({ error: 'no issue tracker is configured to file into (the issues provider is fake or unconfigured)' });

      return checked({ body: RaiseBugBody }, async ({ body }) => {
        const derived = bugTicketFields(issue, body.summary, tracker);
        const title = body.title ?? derived.title;
        const candidates = renderCandidates(dedupeCandidates(store.listTrackerItems(), body.summary));
        const prompt = [system.prompts.render('raise-bug', derived.vars), candidates]
          .filter((part) => part !== null)
          .join('\n\n');
        const job = store.createJob({ title, prompt, kind: 'desk' });
        const filing = store.createBugFiling({ jobId: job.id, originRef: issueConclusionOrigin(issueNumber) });
        hub.broadcast({ type: 'world:changed' });
        const report = await harness.runCycle('manual');
        return { ok: true, filing, job, report };
      })(req, reply);
    }),
  );

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
      const watchable = fleetWorksUpstream(config);
      let filed: { number: number; url: string };
      try {
        filed = await system.upstream.create({
          title: body.title,
          body: body.body,
          labels: body.watch && watchable ? [watchLabel] : [],
        });
      } catch (err) {
        const message = (err as Error).message;
        errors.record({ source: 'provider', message: `filing an issue from the cockpit failed: ${message}` });
        return reply.code(502).send({ error: `${UPSTREAM_REPO} refused the issue: ${message}` });
      }
      const answer: IssueFiled = { ok: true, number: filed.number, url: filed.url };
      return answer;
    }),
  );
}
