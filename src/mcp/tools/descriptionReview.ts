import { z } from 'zod';
import { toolSchema } from '../schema.js';
import { describeCheckTargetPr, descriptionStanding } from '../../pr/prDescription.js';
import { DESCRIPTION_FINDINGS, readFindings } from '../desktopDescription.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

// → docs/spec/07-pull-requests.md#every-description-is-checked-without-asking

export const descriptionReview: ToolFactory = ({ deps, task, ok }) => ({
  description:
    'Report what you found checking the operator’s description of the pull request you were dispatched ' +
    'for against its diff. Findings only: `contradicted` where the description says something the diff ' +
    'does not do, `gap` where the diff raises something a reviewer would want to know and the description ' +
    'does not. Do not be picky — an empty list says it stood up, and is the ordinary result. There is no ' +
    'argument for a rewritten description, and that is deliberate.',
  inputSchema: toolSchema(
    z.object({
      id: z.string().describe('The description version’s id, as your prompt names it.'),
      findings: DESCRIPTION_FINDINGS,
    }),
  ),
  handler: (args) => {
    const prNumber = describeCheckTargetPr(task.originRef);
    if (prNumber === null)
      return toolError(
        'description_review is for an agent dispatched to check a pull request’s description, and this run ' +
          `was dispatched for ${task.originRef ?? 'no origin'}. Nothing was recorded.`,
      );
    const findings = readFindings(args.findings);
    if (findings === null)
      return toolError('description_review needs a `findings` list. Pass an empty one if the description stood up.');
    const id = String(args.id);
    const originRef = deps.store.prDescriptions.partOfPullRequest(prNumber);
    const versions = originRef === null ? [] : deps.store.prDescriptions.listDescriptionVersions(originRef);
    if (!versions.some((v) => v.id === id))
      return toolError(
        `description_review rejected: "${id}" is not a description of PR #${prNumber}. Nothing was recorded.`,
      );
    const version = deps.store.prDescriptions.recordCheck({ id, findings });
    if (version === null) return toolError(`description_review rejected: no description version "${id}".`);
    return ok({
      pullRequest: prNumber,
      stood: descriptionStanding(version),
      findings: version.findings.length,
      means: 'recorded. It is drawn under the description on the pull request’s page. Nothing else is needed.',
    });
  },
});
