import { z } from 'zod';
import { remoteValidationOriginParts } from '../../validation/remote/origin.js';
import { toolSchema } from '../schema.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

// → docs/spec/11-mcp-tools.md

/**
 * **It has no field naming a selector and no count**, and that is the whole design of it. A
 * denominator never comes off a report and the agent never asserts one either — what makes taking
 * the listing in the agent's own checkout safe is that the agent hands back a **path** to what the
 * runner printed, exactly as `reportPath` does. A path says where a file is, not what is in it.
 */
const ListingSchema = z
  .object({
    listingPath: z
      .string()
      .trim()
      .min(1)
      .describe(
        'Path to the file the listing command’s output was written to, inside the run’s own directory. The ' +
          'harness parses that file and reads every row’s area against it, so point at the file rather than ' +
          'describing, summarising or counting what is in it.',
      )
      .optional(),
    blocked: z
      .string()
      .trim()
      .min(1)
      .describe(
        'A reason, **instead of** a listing: the runner could not be asked what it offers at all — it would ' +
          'not answer, the install failed, the credentials are not here. Every check row this listing would ' +
          'have answered for blocks with your reason, and the run stays open for whatever else it owes.',
      )
      .optional(),
  })
  .strict(
    'a listing says only where the runner’s own output landed, or why there is none — which selectors it ' +
      'offers, and how many tests any of them holds, are not yours to state',
  );

export const remoteValidationListing: ToolFactory = ({ deps, task, ok }) => ({
  description:
    'Say where the runner’s own selector listing landed, before you invoke anything. **You name no selector ' +
    'and no count**: the harness parses that file, reads every confirmed row’s area against it, and answers ' +
    'with the selectors that survived — which are the ones you then invoke the runner with, and the only ' +
    'ones. A selector the listing did not survive is already blocked here, and nothing you run later can ' +
    'turn it green. If the runner could not be asked at all, give "blocked" and why instead.',
  inputSchema: toolSchema(ListingSchema),
  handler: async (args) => {
    const target = remoteValidationOriginParts(task.originRef);
    if (target === null)
      return toolError(
        'remote_validation_listing takes the selector listing for the one validation run you were dispatched ' +
          `to carry out, and only the agent dispatched for that run may take it. This task's origin is ` +
          `${task.originRef ?? '(none)'}, not issue:<n>:validate-remote:<runId>. Which run a listing belongs ` +
          'to is decided before the listing rather than by it, so there is no run here for you to list ' +
          'against — and a denominator for a run you were not sent on is not a denominator.',
      );
    const parsed = ListingSchema.safeParse(args);
    if (!parsed.success)
      return toolError(`Listing rejected: ${parsed.error.errors[0]?.message ?? 'the listing could not be read'}`);
    const { listingPath, blocked } = parsed.data;

    const desk = deps.remoteListings?.();
    if (desk === undefined)
      return toolError(
        'This harness has no reader wired for validation listings, so there is nowhere for this one to go. ' +
          'Nothing was recorded. Say so in your final message rather than trying again.',
      );

    if (blocked !== undefined) {
      const taken = desk.blocked(target.runId, blocked);
      if (!taken.ok) return toolError(taken.error);
      return ok({
        reported: 'blocked',
        run: taken.run.id,
        selectors: [],
        rows: { blocked: taken.blocked },
        means:
          'no selector can be verified on this run, so every check row it would have answered for carries ' +
          'your reason to the operator. Whatever else this run owes — a one-off script, a screen — is still ' +
          'yours to carry out, and you still settle the run with remote_validation_report.',
      });
    }

    if (listingPath === undefined)
      return toolError(
        'Give either "listingPath" — where the listing command’s output landed — or "blocked" with the reason ' +
          'the runner could not be asked what it offers. A call that gives neither says nothing at all, and ' +
          'there is no third answer here: what the runner offers is that file’s to say, not yours.',
      );

    const taken = await desk.take(target.runId, listingPath);
    if (!taken.ok) return toolError(taken.error);
    return ok({
      reported: 'listing',
      run: taken.run.id,
      listingPath,
      selectors: taken.selectors,
      rows: { blocked: taken.blocked },
      means:
        'the harness read that file and every confirmed row’s area against it. Invoke the runner with the ' +
        'selectors above and with nothing else: the rows they stand for are the rows this run can still ' +
        'answer, and a row blocked here stays blocked whatever a later report says about it.',
    });
  },
});
