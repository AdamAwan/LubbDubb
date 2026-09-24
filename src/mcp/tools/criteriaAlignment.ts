import { z } from 'zod';
import { issueOriginRef, parseIssueOrigin } from '../../issueOrigins.js';
import { toolError } from '../protocol.js';
import { enumOf, toolSchema } from '../schema.js';
import { CRITERIA_ALIGNMENT_VERDICTS, CRITERIA_POINT_TAGS } from '../../criteria/alignment.js';
import type { CriteriaAlignmentPoint, CriteriaAlignmentVerdict } from '../../types.js';
import type { ToolFactory } from './context.js';

// → docs/spec/08-planning.md#the-alignment-check

export const criteriaAlignment: ToolFactory = ({ deps, agent, task, ok }) => ({
  description:
    "Record how the operator's acceptance criteria for the GOAL you were dispatched for line up with the " +
    "ticket's own. Tag every point on either side, then give one verdict. You are judging the gist: the two " +
    'will be worded differently and will not cover the same ground, and that is ordinary. Say "conflicting" ' +
    'only where a point contradicts. The operator reads this before planning starts; it holds nothing up.',
  inputSchema: toolSchema(
    z.object({
      version: z
        .number()
        .int()
        .describe('The version of the operator’s criteria you were handed, as your prompt names it.'),
      verdict: enumOf(CRITERIA_ALIGNMENT_VERDICTS).describe(
        'aligned: the two say the same thing in substance. partial: they overlap, with points only one side ' +
          'makes and nothing contradicting. conflicting: at least one point contradicts.',
      ),
      summary: z.string().describe('One or two sentences for the operator: what lines up and what does not.'),
      points: z
        .array(
          z.object({
            tag: enumOf(CRITERIA_POINT_TAGS).describe(
              'matches: both say it. extra: only the operator says it. uncovered: only the ticket says it. ' +
                'contradicts: the two disagree.',
            ),
            point: z.string().describe('The point, in a short sentence.'),
            note: z.string().describe('Why you tagged it so, where that is not obvious.').optional(),
          }),
        )
        .describe('Every point on either side, each tagged once.'),
    }),
  ),
  handler: (args) => {
    const parsed = parseIssueOrigin(task.originRef);
    if (parsed === null || parsed.family !== 'criteriaAlignment')
      return toolError(
        'criteria_alignment is for an agent dispatched to compare a goal’s criteria with its ticket, and this ' +
          `run was dispatched for ${task.originRef ?? 'no origin'}. Nothing was recorded.`,
      );
    const input = args as { version?: unknown; verdict?: unknown; summary?: unknown; points?: unknown };
    const version = typeof input.version === 'number' && Number.isInteger(input.version) ? input.version : null;
    if (version === null) return toolError('Rejected: name the version of the criteria you were handed.');
    if (!(CRITERIA_ALIGNMENT_VERDICTS as readonly unknown[]).includes(input.verdict))
      return toolError(`Rejected: the verdict must be one of ${CRITERIA_ALIGNMENT_VERDICTS.join(', ')}.`);
    const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
    if (summary === '') return toolError('Rejected: the summary is what the operator reads first.');
    const points = readPoints(input.points);
    if (points.length === 0) return toolError('Rejected: tag at least one point.');
    const verdict = input.verdict as CriteriaAlignmentVerdict;
    const mismatch = verdictMismatch(verdict, points);
    if (mismatch !== null) return toolError(mismatch);

    const recorded = deps.store.goalCriteria.recordAlignment({
      originRef: issueOriginRef('root', parsed.issueNumber),
      version,
      verdict,
      summary,
      points,
      agentId: agent.id,
    });
    if (recorded === null)
      return toolError(`Rejected: issue #${parsed.issueNumber} has no criteria version ${version}.`);
    return ok({
      recorded: true,
      verdict: recorded.verdict,
      version: recorded.version,
      note:
        recorded.agentId === agent.id
          ? 'Recorded. The operator sees it beside their criteria before planning starts. Nothing else is needed.'
          : 'This version already had a reading, which stands. Nothing else is needed.',
    });
  },
});

function verdictMismatch(verdict: CriteriaAlignmentVerdict, points: CriteriaAlignmentPoint[]): string | null {
  if (verdict === 'conflicting' && !points.some((p) => p.tag === 'contradicts'))
    return 'Rejected: "conflicting" needs at least one point tagged "contradicts".';
  if (verdict !== 'conflicting' && points.some((p) => p.tag === 'contradicts'))
    return 'Rejected: a point tagged "contradicts" makes the verdict "conflicting".';
  return null;
}

function readPoints(value: unknown): CriteriaAlignmentPoint[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((p: unknown): CriteriaAlignmentPoint[] => {
    if (typeof p !== 'object' || p === null) return [];
    const { tag, point, note } = p as { tag?: unknown; point?: unknown; note?: unknown };
    if (!(CRITERIA_POINT_TAGS as readonly unknown[]).includes(tag)) return [];
    if (typeof point !== 'string' || point.trim() === '') return [];
    return [
      {
        tag: tag as CriteriaAlignmentPoint['tag'],
        point: point.trim(),
        note: typeof note === 'string' && note.trim() !== '' ? note.trim() : null,
      },
    ];
  });
}
