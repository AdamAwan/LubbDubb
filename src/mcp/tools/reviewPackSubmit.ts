import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

/**
 * The author's one write: the review pack for the pull request it was dispatched
 * to restate. → `docs/spec/31-review-packs.md#when-a-pack-is-made`
 *
 * **The call is the pack.** The store's row is what the read route ships and
 * what the checker is later handed; an author that writes a file, or prose, has
 * written nothing the harness can see. The tool refuses by field name and the
 * agent fixes and calls again in the same turn — a coverage gap in particular
 * names the hunks, because the author has to find them.
 *
 * The pull request, the head, the hunks and the log are all the desk's: this
 * tool takes ideas, claims and ranges and nothing that would let the author
 * choose what it is checked against.
 */
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
  inputSchema: {
    type: 'object',
    properties: {
      headline: {
        type: 'string',
        description: 'What the change does, in one plain sentence — for the masthead. At most 100 characters.',
      },
      summary: {
        type: 'string',
        description:
          'A short bulleted list in the same register — `- ` per line, the words that matter most in **bold**, ' +
          'and nothing that is not needed to decide whether to read on. Markdown. Not a paragraph. Each bullet ' +
          'at most 100 characters.',
      },
      estimatedMinutes: { type: 'number', description: 'How long you expect the read to take.' },
      fake: {
        type: 'string',
        description: 'The colophon\'s "what is invented" sentence. Leave it out: a real pack states "nothing".',
      },
      ideas: {
        type: 'array',
        description: 'The ideas, in the order you would tell them. At least one.',
        items: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description:
                'Leave out — ids are minted. The one value you may give is "plumbing", for the idea that owns the ' +
                'hunks carrying nothing to review.',
            },
            claim: {
              type: 'string',
              description:
                'One falsifiable sentence stating what this idea does — for the checker. At most 120 characters.',
            },
            title: {
              type: 'string',
              description: 'The same thing said across a desk, no identifiers — for the person. At most 60 characters.',
            },
            anchors: {
              type: 'array',
              description: 'The walk, in reasoning order. At least one.',
              items: {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: ['hunk', 'region'] },
                  hunk: { type: 'string', description: 'kind=hunk: the hunk id from your prompt, e.g. "h3".' },
                  path: { type: 'string', description: 'kind=region: the file, relative to the checkout root.' },
                  start: { type: 'integer', description: 'kind=region: first line, 1-based.' },
                  end: { type: 'integer', description: 'kind=region: last line, inclusive.' },
                  gist: {
                    type: 'string',
                    description: 'One line, always shown: why the walk stops here. At most 90 characters.',
                  },
                  note: {
                    type: 'object',
                    description:
                      'The reasoning, folded away. {by: "witness", entryId: "scr_…", text} quotes the log; ' +
                      '{by: "author", text} is yours.',
                    properties: {
                      by: { type: 'string', enum: ['witness', 'author'] },
                      entryId: { type: 'string' },
                      text: { type: 'string' },
                    },
                    required: ['by', 'text'],
                  },
                  caption: {
                    type: 'string',
                    description:
                      'The one-line label on the code block: "new function", "unchanged, shown because you need ' +
                      'it", "should this have changed? no". At most 40 characters.',
                  },
                  mark: {
                    type: 'string',
                    enum: ['key', 'disputed'],
                    description: 'key: the stop the idea turns on. disputed: where the witness and the code disagree.',
                  },
                },
                required: ['kind', 'gist'],
              },
            },
            coverage: {
              type: 'array',
              description:
                'The scenarios the tests cover, one short line each — "an unwitnessed pull request still renders", ' +
                'not a paragraph about the test. Required on the idea that owns the test hunks; the reader wants ' +
                'assurance the cases were thought of, and nothing more. Each at most 60 characters.',
              items: { type: 'string' },
            },
            claims: {
              type: 'array',
              description: 'The checkable statements this idea rests on. May be empty.',
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string', description: 'One sentence that can be shown false.' },
                  provenance: {
                    type: 'object',
                    properties: {
                      kind: { type: 'string', enum: ['witnessed', 'inferred', 'disputed'] },
                      entryId: { type: 'string', description: 'The scr_… entry, required on witnessed and disputed.' },
                    },
                    required: ['kind'],
                  },
                },
                required: ['text', 'provenance'],
              },
            },
          },
          required: ['claim', 'title', 'anchors'],
        },
      },
    },
    required: ['headline', 'summary', 'estimatedMinutes', 'ideas'],
  },
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
