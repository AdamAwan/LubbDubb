import { z } from 'zod';
import { toolError } from '../protocol.js';
import { toolSchema } from '../schema.js';
import type { ToolFactory } from './context.js';

// → docs/spec/11-mcp-tools.md

export const reviewPackSubmit: ToolFactory = ({ deps, agent, task, ok }) => ({
  description:
    'Submit the review pack for the PULL REQUEST you were dispatched to restate. This is the pack — the harness ' +
    'keeps what you say here and a reviewer reads it in the cockpit; a run that ends without this call has ' +
    'written nothing. A pack is a handful of **ideas**, each a falsifiable `claim` for the checker and a `title` ' +
    'for the person, walked through the tree in the order the reasoning ran: an ordered list of **anchors**, ' +
    'each a `hunk` from your prompt (named by its id — the harness fills in the range and the code) or a ' +
    '`region` of a file the diff does not touch (named by path and 1-based inclusive lines — the harness reads ' +
    'the code off the tree), each with a one-line `gist`. **Every hunk in the diff must be owned by exactly one ' +
    "idea's hunk anchor**; give the ones with nothing to review to the idea whose id is `plumbing`. Under each " +
    'idea, `claims`: sentences that can be shown false, each with its `provenance` — `witnessed` citing the log ' +
    'entry it comes from, `disputed` citing the entry the code contradicts, or `inferred` for your own reading. ' +
    'A note on an anchor is `{by: "witness", entryId, text}` or `{by: "author", text}`. **Tests are never an idea ' +
    "of their own**: give a test hunk to the idea it exercises, and list what it covers as that idea's `coverage` " +
    'lines — one short scenario each, named and not explained. Write nothing the checker ' +
    'owns: no verdicts, no attention labels, no cues, no reading order. **Every prose field is capped** — say ' +
    'it in as few words as you can, in the plainest ones you know, and the refusal names the field and the ' +
    'count. The refusal names the field.',
  inputSchema: toolSchema(
    z.object({
      headline: z
        .string()
        .describe('What the change does, in one plain sentence — for the masthead. At most 100 characters.'),
      summary: z
        .string()
        .describe(
          'A short bulleted list in the same register — `- ` per line, the words that matter most in **bold**, ' +
            'and nothing that is not needed to decide whether to read on. Markdown. Not a paragraph. Each bullet ' +
            'at most 100 characters.',
        ),
      estimatedMinutes: z.number().describe('How long you expect the read to take.'),
      fake: z
        .string()
        .describe('The colophon\'s "what is invented" sentence. Leave it out: a real pack states "nothing".')
        .optional(),
      ideas: z
        .array(
          z.object({
            id: z
              .string()
              .describe(
                'Leave out — ids are minted. The one value you may give is "plumbing", for the idea that owns the ' +
                  'hunks carrying nothing to review.',
              )
              .optional(),
            claim: z
              .string()
              .describe(
                'One falsifiable sentence stating what this idea does — for the checker. At most 120 characters.',
              ),
            title: z
              .string()
              .describe('The same thing said across a desk, no identifiers — for the person. At most 60 characters.'),
            anchors: z
              .array(
                z.object({
                  kind: z.enum(['hunk', 'region']),
                  hunk: z.string().describe('kind=hunk: the hunk id from your prompt, e.g. "h3".').optional(),
                  path: z.string().describe('kind=region: the file, relative to the checkout root.').optional(),
                  start: z.number().int().describe('kind=region: first line, 1-based.').optional(),
                  end: z.number().int().describe('kind=region: last line, inclusive.').optional(),
                  gist: z.string().describe('One line, always shown: why the walk stops here. At most 90 characters.'),
                  note: z
                    .object({
                      by: z.enum(['witness', 'author']),
                      entryId: z.string().optional(),
                      text: z.string(),
                    })
                    .describe(
                      'The reasoning, folded away. {by: "witness", entryId: "scr_…", text} quotes the log; ' +
                        '{by: "author", text} is yours.',
                    )
                    .optional(),
                  caption: z
                    .string()
                    .describe(
                      'The one-line label on the code block: "new function", "unchanged, shown because you need ' +
                        'it", "should this have changed? no". At most 40 characters.',
                    )
                    .optional(),
                  mark: z
                    .enum(['key', 'disputed'])
                    .describe('key: the stop the idea turns on. disputed: where the witness and the code disagree.')
                    .optional(),
                }),
              )
              .describe('The walk, in reasoning order. At least one.'),
            coverage: z
              .array(z.string())
              .describe(
                'The scenarios the tests cover, one short line each — "an unwitnessed pull request still renders", ' +
                  'not a paragraph about the test. Required on the idea that owns the test hunks; the reader wants ' +
                  'assurance the cases were thought of, and nothing more. Each at most 60 characters.',
              )
              .optional(),
            claims: z
              .array(
                z.object({
                  text: z.string().describe('One sentence that can be shown false.'),
                  provenance: z.object({
                    kind: z.enum(['witnessed', 'inferred', 'disputed']),
                    entryId: z.string().describe('The scr_… entry, required on witnessed and disputed.').optional(),
                  }),
                }),
              )
              .describe('The checkable statements this idea rests on. May be empty.')
              .optional(),
          }),
        )
        .describe('The ideas, in the order you would tell them. At least one.'),
    }),
  ),
  handler: async (args) => {
    const desk = deps.reviewPacks;
    if (!desk) {
      return toolError(
        'The review pack desk is not wired on this deployment, so nothing can be recorded. Say so in your summary.',
      );
    }
    const result = await desk.submit(agent, task, args);
    if (!result.ok) return toolError(result.error);
    const { pack } = result.record;
    return ok({
      recorded: true,
      prNumber: pack.prNumber,
      headSha: pack.headSha,
      ideas: pack.ideas.map((i) => ({ id: i.id, hunks: i.anchors.filter((a) => a.kind === 'hunk').length })),
      witnessed: pack.witnessed,
      note:
        "Recorded. A reviewer reads it from the pull request's row in the cockpit; nothing is posted to the " +
        'provider. You are done — there is nothing else to write.',
    });
  },
});
