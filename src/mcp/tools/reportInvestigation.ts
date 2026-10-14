import { z } from 'zod';
import { goalFingerprint } from '../../intake/appraisal.js';
import { issueOriginNumber, issueOriginRef } from '../../issueOrigins.js';
import type { InvestigationConfidence, InvestigationResolution } from '../../types.js';
import { toolSchema } from '../schema.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

// → docs/spec/11-mcp-tools.md

const CONFIDENCES = ['high', 'medium', 'low'] as const satisfies readonly InvestigationConfidence[];
const RECOMMENDATIONS = ['plan', 'pickup', 'close', 'ask'] as const satisfies readonly InvestigationResolution[];
const MAX_FIELD = 4000;

const InvestigationInput = z.object({
  reproduction: z
    .string()
    .describe('The smallest steps or inputs that show the bug — or what you tried and what it ruled out.'),
  root_cause: z.string().describe('Why it happens, not where the symptom surfaces.'),
  confidence: z.enum(CONFIDENCES).describe('How sure you are of the root cause.'),
  locations: z.string().describe('The files, functions and lines involved.'),
  blast_radius: z.string().describe('What else shares the cause or would be touched by fixing it.'),
  recommendation: z
    .enum(RECOMMENDATIONS)
    .describe(
      'plan: the fix needs a planner to decompose it. pickup: one contained change an agent can make ' +
        'directly. close: not a bug, or already fixed. ask: only the reporter can say what is missing.',
    ),
});

type Parsed = {
  reproduction: string;
  rootCause: string;
  confidence: InvestigationConfidence;
  locations: string;
  blastRadius: string;
  recommendation: InvestigationResolution;
};

function parse(args: Record<string, unknown>): { ok: true; value: Parsed } | { ok: false; error: string } {
  const text: Record<string, string> = {};
  for (const key of ['reproduction', 'root_cause', 'locations', 'blast_radius'] as const) {
    const value = typeof args[key] === 'string' ? args[key].trim() : '';
    if (value === '') return { ok: false, error: `${key} is required — say what you found, or what you could not.` };
    if (value.length > MAX_FIELD) return { ok: false, error: `${key} is too long (max ${MAX_FIELD} chars).` };
    text[key] = value;
  }
  const confidence = CONFIDENCES.find((c) => c === args.confidence);
  if (confidence === undefined) return { ok: false, error: `confidence must be one of ${CONFIDENCES.join(', ')}.` };
  const recommendation = RECOMMENDATIONS.find((r) => r === args.recommendation);
  if (recommendation === undefined)
    return { ok: false, error: `recommendation must be one of ${RECOMMENDATIONS.join(', ')}.` };
  return {
    ok: true,
    value: {
      reproduction: text.reproduction!,
      rootCause: text.root_cause!,
      confidence,
      locations: text.locations!,
      blastRadius: text.blast_radius!,
      recommendation,
    },
  };
}

export const reportInvestigation: ToolFactory = ({ deps, agent, task, ok }) => ({
  description:
    'Record what you found investigating the ISSUE you were dispatched to investigate: a reproduction, the ' +
    'root cause, how sure you are, where it lives, what else it touches, and what should happen next. An ' +
    'operator reads it and decides; nothing is planned or dispatched for this issue until they do. Do not ' +
    'implement anything and do not open a pull request.',
  inputSchema: toolSchema(InvestigationInput),
  handler: (args) => {
    const issueNumber = issueOriginNumber('investigate', task.originRef);
    if (issueNumber === null) {
      return toolError(
        'report_investigation is for an agent dispatched to investigate an issue before it is planned, and this ' +
          `run was dispatched for ${task.originRef ?? 'no origin'}. Nothing was recorded.`,
      );
    }
    const parsed = parse(args);
    if (!parsed.ok) return toolError(`Investigation rejected: ${parsed.error}`);
    const recorded = deps.store.investigations.record({
      originRef: issueOriginRef('root', issueNumber),
      goalRef: goalFingerprint(task.originTitle, task.originSummary),
      by: agent.id,
      ...parsed.value,
    });
    return ok({
      recorded: true,
      issue: recorded.originRef,
      recommendation: recorded.recommendation,
      note:
        'Recorded. The findings wait on an operator, who resolves them to plan, pickup, close or ask. ' +
        'There is nothing further for you to do.',
    });
  },
});
