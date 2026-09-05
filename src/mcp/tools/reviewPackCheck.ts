import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

/**
 * The checker's one write: its verdicts on the pack it was dispatched to check.
 * → `docs/spec/31-review-packs.md#the-check`
 *
 * **The call is the check.** The desk merges what is said here onto the stored
 * document through `applyCheck`, which can reach only the checker's fields —
 * verdicts, evidence, findings, labels, cues, the order, the `false` mark on a
 * step — so the rule that the checker may not edit the pack is the shape of this
 * tool rather than a sentence in its prompt. Keyed to what the prompt handed out:
 * the idea ids and the claim numbers, never a document back.
 */
export const reviewPackCheck: ToolFactory = ({ deps, agent, task, ok }) => ({
  description:
    'Record your verdicts on the review pack you were dispatched to check. This is the check — the harness ' +
    'merges what you say here onto the stored pack and a reviewer reads it in the cockpit; a run that ends ' +
    'without this call has checked nothing. One entry per **idea**, by the id in your prompt: an `attention` ' +
    'label (read, decide, skim, split), a one-line `cue` saying why, and one entry per **claim** by its number: ' +
    'a `verdict` — true (reproduced against the tree), false (the tree contradicts it) or cant_tell (not ' +
    'decidable from this repository: the outside world, a product judgement, an intention) — with the `evidence` ' +
    'of what you ran or read. A false claim carries a `finding`: a plain `headline`, a `body` working out the ' +
    'consequence and how serious it is and whose call, the `step` of the walk it is about, and where the ' +
    'contradicting code is not on the walk a `counter` range the harness reads off the tree. Finish with ' +
    '`order`: every idea id once, in the order to read them. Every idea and every claim must be answered; the ' +
    'refusal names the field. Nothing else in the pack can be changed from here.',
  inputSchema: {
    type: 'object',
    properties: {
      ideas: {
        type: 'array',
        description: 'One entry per idea you were handed, by id.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The idea id from your prompt (e.g. "idea_ab12cd34", or "plumbing").' },
            attention: {
              type: 'string',
              enum: ['read', 'decide', 'skim', 'split'],
              description:
                'How hard to look. read: needs reading. decide: a judgement call for the reviewer. skim: safe to ' +
                'pass over. split: unrelated to the rest of the pull request and could be its own.',
            },
            cue: {
              type: 'string',
              description:
                'One short line: why this label, and where the risk is. At most 70 characters — plainest words, ' +
                'one idea, no clauses hung off dashes.',
            },
            claims: {
              type: 'array',
              description: 'One entry per claim under this idea, by number. Every claim must be answered.',
              items: {
                type: 'object',
                properties: {
                  claim: { type: 'integer', description: 'The claim number from your prompt, 1-based.' },
                  verdict: { type: 'string', enum: ['true', 'false', 'cant_tell'] },
                  evidence: {
                    type: 'string',
                    description:
                      'What you did to decide — the search, the test, the file you read — or why it cannot be decided here.',
                  },
                  finding: {
                    type: 'object',
                    description: 'Required on a false claim, forbidden otherwise.',
                    properties: {
                      headline: { type: 'string', description: 'One plain line saying what is wrong.' },
                      body: {
                        type: 'string',
                        description:
                          'The consequence worked out — a table where numbers make it concrete — how serious it is, ' +
                          'and whose call it is. Markdown.',
                      },
                      step: {
                        type: 'integer',
                        description:
                          'The step of the walk the claim is about, 1-based as your prompt numbers them. Leave out if none fits.',
                      },
                      counter: {
                        type: 'object',
                        description: 'The code that contradicts the claim, where it is not already on the walk.',
                        properties: {
                          path: { type: 'string', description: 'Relative to the checkout root.' },
                          start: { type: 'integer', description: 'First line, 1-based.' },
                          end: { type: 'integer', description: 'Last line, inclusive.' },
                          caption: { type: 'string', description: 'One line on the block: what it is.' },
                        },
                        required: ['path', 'start', 'end', 'caption'],
                      },
                    },
                    required: ['headline', 'body'],
                  },
                },
                required: ['claim', 'verdict', 'evidence'],
              },
            },
          },
          required: ['id', 'attention', 'cue', 'claims'],
        },
      },
      order: {
        type: 'array',
        items: { type: 'string' },
        description: 'Every idea id exactly once, in the order to read them — where to spend the time first.',
      },
    },
    required: ['ideas', 'order'],
  },
  handler: async (args) => {
    const desk = deps.reviewPackChecker;
    if (!desk) {
      return toolError(
        'The review pack checker desk is not wired on this deployment, so nothing can be recorded. Say so in your summary.',
      );
    }
    const result = desk.submit(agent, task, args);
    if (!result.ok) return toolError(result.error);
    const { pack } = result.record;
    const claims = pack.ideas.flatMap((i) => i.claims);
    return ok({
      recorded: true,
      prNumber: pack.prNumber,
      headSha: pack.headSha,
      verdicts: {
        true: claims.filter((c) => c.verdict === 'true').length,
        false: claims.filter((c) => c.verdict === 'false').length,
        cant_tell: claims.filter((c) => c.verdict === 'cant_tell').length,
      },
      note: "Recorded. A reviewer reads it from the pull request's row in the cockpit. You are done — there is nothing else to write.",
    });
  },
});
