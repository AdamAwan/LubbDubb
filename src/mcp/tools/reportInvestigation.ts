import { z } from 'zod';
import { goalFingerprint } from '../../intake/appraisal.js';
import { issueOriginNumber } from '../../issueOrigins.js';
import { issueOrigin } from '../../plans/planning.js';
import { INVESTIGATION_RESOLUTIONS, withdrawnPickup } from '../../intake/investigationResolutions.js';
import type { InvestigationConfidence } from '../../types.js';
import { toolSchema } from '../schema.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

// → docs/spec/11-mcp-tools.md

const CONFIDENCES = ['high', 'medium', 'low'] as const satisfies readonly InvestigationConfidence[];
const MAX_FIELD = 4000;

const finding = (what: string) => z.string().trim().min(1).max(MAX_FIELD).describe(what);

const InvestigationInput = z.object({
  reproduction: finding('The smallest steps or inputs that show the bug — or what you tried and what it ruled out.'),
  root_cause: finding('Why it happens, not where the symptom surfaces.'),
  confidence: z.enum(CONFIDENCES).describe('How sure you are of the root cause.'),
  locations: finding('The files, functions and lines involved.'),
  blast_radius: finding('What else shares the cause or would be touched by fixing it.'),
  recommendation: z
    .preprocess((v) => (typeof v === 'string' ? withdrawnPickup(v) : v), z.enum(INVESTIGATION_RESOLUTIONS))
    .describe(
      'plan: there is a fix to make — a planner decomposes it, however small. close: not a bug, or already ' +
        'fixed. ask: only the reporter can say what is missing.',
    ),
});

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
    const parsed = InvestigationInput.safeParse(args);
    if (!parsed.success) return toolError(`Investigation rejected: ${parsed.error.message}`);
    const { reproduction, root_cause, confidence, locations, blast_radius, recommendation } = parsed.data;
    const recorded = deps.store.investigations.record({
      originRef: issueOrigin(issueNumber),
      goalRef: goalFingerprint(task.originTitle, task.originSummary),
      by: agent.id,
      reproduction,
      rootCause: root_cause,
      confidence,
      locations,
      blastRadius: blast_radius,
      recommendation,
    });
    return ok({
      recorded: true,
      issue: recorded.originRef,
      recommendation: recorded.recommendation,
      note:
        'Recorded. The findings wait on an operator, who resolves them to plan, close or ask. ' +
        'There is nothing further for you to do.',
    });
  },
});
