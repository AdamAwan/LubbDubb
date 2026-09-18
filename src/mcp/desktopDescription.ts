import { z } from 'zod';
import { issueOriginRef } from '../issueOrigins.js';
import { DESCRIPTION_PROMPTS, descriptionStanding } from '../pr/prDescription.js';
import { DESCRIPTION_QUESTIONS } from '../store/prDescriptions.js';
import { toolSchema } from './schema.js';
import type { DescriptionQuestion } from '../types.js';
import type { DesktopToolFactory } from './desktopContext.js';
import { toolError, toolJson } from './protocol.js';

// → docs/spec/11-mcp-tools.md#the-desktop-channel

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
      stood: descriptionStanding(current),
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
    'Report what you found checking the operator’s description against the diff. One finding per ' +
    'thing, each carrying a coordinate wherever the diff is what settles it. ' +
    '`contradicted` is the description asserting something the diff does not do — say those first, ' +
    'they are the ones that would have put a false sentence in front of a reviewer. `gap` is ' +
    'something the diff raises that the description does not. A check that found nothing real reports ' +
    'an empty list, which is a result and not a failure to report. There is no argument here for a ' +
    'rewritten description, and that is deliberate: the operator writes their own, or the pull ' +
    'request carries none.',
  inputSchema: toolSchema(
    z.object({
      id: z
        .string()
        .describe(
          'The description version’s id, from description_read. Address the version you actually read — the ' +
            'operator may have edited while you were reading, and a report on "the current one" marks text ' +
            'you never saw.',
        ),
      findings: z
        .array(
          z.object({
            kind: z
              .enum(['contradicted', 'gap'])
              .describe(
                '`contradicted` — the diff does not do what this says. `gap` — the diff raises it and the description does not.',
              ),
            note: z
              .string()
              .describe(
                'What you found, in one or two sentences, carrying a coordinate — src/store/sync.ts:41 — ' +
                  'wherever the diff is what settles it. Plain text: it is drawn as written, so backticks ' +
                  'around a path show up as backticks. Written to the operator, who will decide whether you ' +
                  'are right.',
              ),
            question: z
              .enum(['asked-for', 'undone', 'missing', 'reach'])
              .describe(
                'Optional, and usually omitted. Tag a finding with one of the four questions under the field ' +
                  'only where it genuinely is one of them — most of what is worth saying about a description ' +
                  `is none of the four. The questions: ${QUESTION_HELP}.`,
              )
              .optional(),
          }),
        )
        .describe(
          'Everything you found, most serious first. An empty list says you checked and it stood up, which ' +
            'is recorded as a clean check rather than as no check at all.',
        ),
    }),
  ),
  handler: async (args) => {
    const given = Array.isArray(args.findings) ? args.findings : null;
    if (given === null)
      return toolError('description_check needs a `findings` list. Pass an empty one if the description stood up.');
    const findings = given.map((raw) => {
      const f = raw as { kind: 'contradicted' | 'gap'; note: string; question?: DescriptionQuestion };
      return { kind: f.kind, note: f.note, question: f.question ?? null };
    });
    const version = deps.store.prDescriptions.recordCheck({ id: String(args.id), findings });
    if (version === null)
      return toolError(
        `No description version "${String(args.id)}". Call description_read again — the operator may have ` +
          'rewritten it, and the version you read is not the one to mark.',
      );
    return toolJson({
      recorded: true,
      version: version.version,
      stood: descriptionStanding(version),
      findings: version.findings.length,
      checkedAt: version.checkedAt,
    });
  },
});
