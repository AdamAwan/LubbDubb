import { z } from 'zod';
import { remoteValidationOriginParts } from '../../remoteValidation/origin.js';
import { toolSchema } from '../schema.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

// → docs/spec/11-mcp-tools.md

/**
 * **It has no field an agent could state an outcome in**, and that is the whole design of it. The
 * runner's machine-readable report is the only source of row outcomes, and a tool with a `result`
 * field — or a "reason", or an `artefacts` widened into a summary — is a tool through which a
 * model's opinion becomes a reading. The model in this loop has every reason to believe the goal
 * works and no way to have watched a spec run.
 */
const ReportSchema = z
  .object({
    reportPath: z
      .string()
      .trim()
      .min(1)
      .describe(
        'Path to the runner’s machine-readable report, inside the run’s own report directory. The harness ' +
          'parses that file and folds every row’s outcome out of it, so point at the file rather than ' +
          'describing what is in it.',
      )
      .optional(),
    artefacts: z
      .string()
      .trim()
      .min(1)
      .describe(
        'The URL the publish command printed, verbatim, if it ran. It is what turns a red row somebody ' +
          'clicks into and understands in thirty seconds into the difference from a red row somebody ' +
          'reproduces by hand.',
      )
      .optional(),
    handback: z
      .string()
      .trim()
      .min(1)
      .describe(
        'A reason, **instead of** a report: the run could not be carried out at all — the environment would ' +
          'not answer, the credentials are not here, the install failed. It records nothing, leaves every row ' +
          'exactly as it was, and carries your reason to the operator. It is a right answer rather than a ' +
          'last resort: an agent that could not reach the environment has learned nothing about the goal.',
      )
      .optional(),
  })
  .strict(
    'a remote validation report says only where the report and the artefacts landed, or why there is ' +
      'neither — which rows it concerns, and what each of them came back as, are not yours to state',
  );

export const remoteValidationReport: ToolFactory = ({ deps, task, ok }) => ({
  description:
    'Say where the runner’s report landed once you have carried the run out — once, at the end. **You state ' +
    'no outcome**: the report file is the only source of row outcomes and the harness reads it, so give ' +
    '"reportPath" (and "artefacts", where a publish command printed a URL) and nothing else. The exit code ' +
    'decides nothing — one invocation carries many rows and one code — so a non-zero exit with a report ' +
    'beside it is still a run that answered. If you could not carry the run out at all, give "handback" and ' +
    'why instead: that records nothing, leaves every row as it was, and is the right answer rather than a ' +
    'last resort.',
  inputSchema: toolSchema(ReportSchema),
  handler: (args) => {
    const target = remoteValidationOriginParts(task.originRef);
    if (target === null)
      return toolError(
        'remote_validation_report settles the one validation run you were dispatched to carry out, and only ' +
          `the agent dispatched for that run may settle it. This task's origin is ${task.originRef ?? '(none)'}, ` +
          'not issue:<n>:validate-remote:<runId>. Which run a report concerns is decided before the report ' +
          'rather than by it, so there is no run here for you to report against — and a reading of a run you ' +
          'were not sent on is not a reading.',
      );
    const parsed = ReportSchema.safeParse(args);
    if (!parsed.success)
      return toolError(`Report rejected: ${parsed.error.errors[0]?.message ?? 'the report could not be read'}`);
    const { reportPath, artefacts, handback } = parsed.data;

    const run = deps.store.getRemoteRun(target.runId);
    if (run === null)
      return toolError(
        `Run "${target.runId}" is no longer on issue #${String(target.issueNumber)}'s sheet. Nothing was ` +
          'recorded, and nothing more is needed from you on it.',
      );
    if (run.status !== 'pending' && run.status !== 'dispatched')
      return toolError(
        `Run "${target.runId}" was already settled as ${run.status}${run.note === null ? '' : ` — ${run.note}`}. ` +
          'Nothing was recorded a second time.',
      );

    if (handback !== undefined) {
      const ended = deps.store.endRemoteRun(run.id, {
        status: 'abandoned',
        note: `The agent could not carry this run out: ${handback}`,
      });
      return ok({
        reported: 'handback',
        run: run.id,
        state: ended?.status ?? run.status,
        means:
          'no reading was recorded and every row on the sheet is exactly as it was, with your reason on it ' +
          'for the operator. Your run is over.',
      });
    }

    if (reportPath === undefined)
      return toolError(
        'Give either "reportPath" — where the runner’s machine-readable report landed — or "handback" with ' +
          'the reason the run could not be carried out. A call that gives neither says nothing at all, and ' +
          'there is no third answer here: what each row came back as is the report’s to say, not yours.',
      );

    const ended = deps.store.endRemoteRun(run.id, {
      status: 'ended',
      reportPath,
      artefacts: artefacts ?? null,
    });
    return ok({
      reported: 'report',
      run: run.id,
      reportPath,
      artefacts: artefacts ?? null,
      state: ended?.status ?? run.status,
      means:
        'the run is settled and the harness has where the report landed. What each row came back as is read ' +
        'out of that file — you are not asked, and an opinion from here would be a guess wearing a reading’s ' +
        'clothes. Your run is over.',
    });
  },
});
