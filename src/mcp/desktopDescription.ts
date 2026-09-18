import { z } from 'zod';
import { issueOriginRef } from '../issueOrigins.js';
import { DESCRIPTION_PROMPTS } from '../pr/prDescription.js';
import { DESCRIPTION_QUESTIONS } from '../store/prDescriptions.js';
import { toolSchema } from './schema.js';
import type { DesktopToolFactory } from './desktopContext.js';
import { toolError, toolJson } from './protocol.js';

// → docs/spec/11-mcp-tools.md#the-desktop-channel

const MARK = z.enum(['matched', 'missed', 'contradicted', 'not-applicable']);

const QUESTION_HELP = DESCRIPTION_QUESTIONS.map((q) => `\`${q}\` — ${DESCRIPTION_PROMPTS[q]}`).join('; ');

/**
 * What the operator's own Claude Code reads when they press **Check my description**.
 *
 * It hands back the text and the part it belongs to, and nothing else: the diff is
 * on the checkout the session was opened on, which is the point of it being their
 * session rather than a dispatched one.
 */
export const descriptionRead: DesktopToolFactory = (deps) => ({
  description:
    'Read the description the operator wrote for one part’s pull request, so you can check it against ' +
    'the code. The diff is in the checkout you are already in — this gives you what they claimed. ' +
    'Read both, then report with description_check.',
  inputSchema: toolSchema(
    z.object({
      issue: z.number().describe('The goal number, e.g. 284.'),
      part: z.string().describe('The part’s slug, as the plan names it.'),
    }),
  ),
  handler: async (args) => {
    const originRef = issueOriginRef('part', args.issue as number, String(args.part));
    const current = deps.store.prDescriptions.currentDescription(originRef);
    if (current === null)
      return toolError(
        `Nobody has written a description for part "${String(args.part)}" of #${String(args.issue)}. There is ` +
          'nothing to check — say so rather than writing one.',
      );
    return toolJson({
      id: current.id,
      version: current.version,
      originRef: current.originRef,
      text: current.text,
      authoredAt: current.authoredAt,
      alreadyChecked: current.checkedAt !== null,
      questions: DESCRIPTION_PROMPTS,
    });
  },
});

/**
 * The reading, reported back onto the version it was taken of.
 *
 * **It takes findings and marks, and deliberately no text.** The whole value of the
 * description is that a person wrote it; a session that hands back better prose and
 * an operator who accepts it produces a body that reads as theirs and is not, which
 * is worse than the agent-written body this replaces — that one is at least known to
 * be an agent's. So there is no argument here that could carry one. Say what is
 * wrong; they will fix it.
 * → docs/spec/07-pull-requests.md#it-contradicts-it-never-drafts
 */
export const descriptionCheck: DesktopToolFactory = (deps) => ({
  description:
    'Report how the operator’s description stood against the diff. Mark each of the four questions you ' +
    'reached and say what you found. `matched` is the description getting it right; `missed` is the diff ' +
    'answering a question the description does not; `contradicted` is the description asserting something ' +
    'the diff does not do, which is the one worth saying first. There is no argument here for a rewritten ' +
    'description, and that is deliberate: the operator writes their own, or the pull request carries none. ' +
    `The questions: ${QUESTION_HELP}.`,
  inputSchema: toolSchema(
    z.object({
      id: z
        .string()
        .describe(
          'The description version’s id, from description_read. Address the version you actually read — the ' +
            'operator may have edited while you were reading, and a report on "the current one" marks text ' +
            'you never saw.',
        ),
      'asked-for': MARK.describe('Is this what we asked for?').optional(),
      undone: MARK.describe('What can’t be undone if this is wrong?').optional(),
      missing: MARK.describe('What’s missing?').optional(),
      reach: MARK.describe('How far does it reach if it’s wrong?').optional(),
      findings: z
        .array(z.string())
        .describe(
          'What you found, one line each, carrying a coordinate — `src/store/sync.ts:41` — wherever the diff ' +
            'is what settles it. These are shown to the operator and are not published anywhere.',
        )
        .optional(),
    }),
  ),
  handler: async (args) => {
    const marks: Record<string, unknown> = {};
    for (const question of DESCRIPTION_QUESTIONS) {
      const given = args[question];
      if (typeof given === 'string') marks[question] = given;
    }
    if (Object.keys(marks).length === 0)
      return toolError(
        'description_check needs at least one mark. A report that marks nothing says the check did not ' +
          'happen, and the operator would be shown a tick for a reading nobody took.',
      );
    const version = deps.store.prDescriptions.recordCheck({
      id: String(args.id),
      marks: marks as Parameters<typeof deps.store.prDescriptions.recordCheck>[0]['marks'],
    });
    if (version === null)
      return toolError(
        `No description version "${String(args.id)}". Call description_read again — the operator may have ` +
          'rewritten it, and the version you read is not the one to mark.',
      );
    return toolJson({ recorded: true, version: version.version, marks: version.marks, checkedAt: version.checkedAt });
  },
});
