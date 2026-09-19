import { z } from 'zod';
import { issueSubtreeNumber } from '../../issueOrigins.js';
import { issueOrigin } from '../../plans/planning.js';
import { toolSchema } from '../schema.js';
import { prTitleFields, renderPrTitle } from '../../pr/prTitle.js';
import { PR_BODY, prBodyRefusal } from '../../pr/prBody.js';
import { diffFacts } from '../../pr/prDiff.js';
import { PR_EVIDENCE, evidenceRefusal, renderEvidence, type PrEvidence } from '../../pr/prEvidence.js';
import { openPrFailure, resolveOpenPr } from '../openPr.js';
import { linkPrWorkItem } from '../../pr/prWorkItemDesk.js';
import { seedPrWatch } from '../../pr/prWatchDesk.js';
import { toolError } from '../protocol.js';
import type { PrRefStyle } from '../../pr/prRef.js';
import type { ToolFactory } from './context.js';

// → docs/spec/11-mcp-tools.md

function prRefGuidance(style: PrRefStyle): string {
  return style === '!'
    ? 'If you name another pull request in it — the one your work stacks on, say — write it as `!12`, ' +
        'not `#12`: this provider reads `#12` as work item 12, so the wrong sigil links to an unrelated ticket.'
    : 'If you name another pull request in it — the one your work stacks on, say — write it as `#12`.';
}

const COORDINATE_RULE =
  'Every entry is one line carrying a coordinate — `src/store/sync.ts:41` — naming a file this pull ' +
  'request changes. A coordinate is a place the reviewer can go and disagree with you in one click, ' +
  'and an entry without one is an opinion. Entries that answer the question for the reviewer are ' +
  'refused: no "safe", "simple", "minimal", "no risk", "fully tested". ' +
  `At most ${PR_EVIDENCE.entries} entries, ${PR_EVIDENCE.entryChars} characters each.`;

const evidenceField = (description: string): z.ZodOptional<z.ZodArray<z.ZodString>> =>
  z.array(z.string()).describe(`${description} ${COORDINATE_RULE}`).optional();

function evidenceOf(args: Record<string, unknown>): PrEvidence {
  const list = (key: string): string[] =>
    Array.isArray(args[key]) ? (args[key] as unknown[]).filter((v): v is string => typeof v === 'string') : [];
  return {
    satisfies: list('satisfies'),
    decided: list('decided'),
    oneWay: list('one_way'),
    unverified: list('unverified'),
    reach: list('reach'),
  };
}

export const openPr: ToolFactory = ({ deps, task, ok }) => ({
  description:
    'Open the pull request for the work you were dispatched to do. The harness supplies the branch, ' +
    'the base — which is the rung beneath you when your work is stacked on another part — and the ' +
    'title convention; you supply what the change does. Commit and push your branch before you call ' +
    'this — the harness never pushes, and the provider refuses a pull request whose head it cannot ' +
    'see. You cannot open a pull request for another ' +
    "agent's work: the branch and base come from your own origin, never from an argument. If this " +
    'tool reports it is unavailable, open the pull request yourself against the branch and base named ' +
    'in your prompt.',
  inputSchema: toolSchema(
    z.object({
      summary: z
        .string()
        .describe(
          'What the change does, in a few words — it becomes the title. Not a sentence and not a ' +
            'restatement of the issue: "sync cursor table", not "This PR adds a table for sync cursors".',
        ),
      type: z
        .string()
        .describe('Optional conventional-commit type: feat, fix, refactor, docs, test, chore. Omit it if none fits.')
        .optional(),
      scope: z
        .string()
        .describe('Optional module the change lands in, e.g. "store". Omit it if the change is broad.')
        .optional(),
      body: z
        .string()
        .describe(
          deps.manualDescriptions
            ? 'Do not use this. On this deployment the description is the operator\u2019s \u2014 they write it ' +
                'against this pull request once it is open, and a body sent here is refused rather than ' +
                'merged with theirs. What you know about the change goes in the evidence arguments below, ' +
                'as coordinates.'
            : 'Optional PR body. The harness adds the issue reference itself, so describe the change, not ' +
                `which ticket it belongs to. Write it as a bullet list: at most ${PR_BODY.bullets} bullets, why ` +
                'the change is needed first and what it does after, one line each. No headings, no prose ' +
                'paragraphs — a reviewer reads this before the diff, not instead of it. These are checked and ' +
                `a body that breaks them is refused: every line starts with \`- \`, no bullet runs past ` +
                `${PR_BODY.bulletChars} characters, no semicolons, no clauses hung off a dash, and the plainest ` +
                'word that is still true. ' +
                prRefGuidance(deps.openPr?.prRefStyle ?? '#'),
        )
        .optional(),
      satisfies: evidenceField(
        'Where each of this part’s acceptance criteria is met, one entry per criterion in the order the ' +
          'plan lists them. If one is not met, write "not met: <why>" instead of a coordinate. Required ' +
          'when the part has criteria — the refusal lists them for you.',
      ),
      one_way: evidenceField(
        'What a revert of this pull request would not take back: a migration that has run, rows that are ' +
          'gone, something written into the world, a name a deployment may already be overriding. ' +
          'Required when the diff touches a surface like that.',
      ),
      unverified: evidenceField(
        'What nothing pins: behaviour in this change that no test covers, and work in scope you left out ' +
          'on purpose. Required when the diff changes code and no test changed with it. The reviewer ' +
          'cannot be told what is missing — this is how they see the edge of what was checked.',
      ),
      reach: evidenceField(
        'How far this carries if it is wrong: what runs the changed code — the pulse, boot, a route, an ' +
          'agent tool, the cockpit alone — and whether a config flag gates it or it is unconditional. ' +
          'Required of every change that touches code that runs.',
      ),
      decided: evidenceField(
        'A fork the ask did not settle and you settled, written as "X, not Y". The road not taken is the ' +
          'information: it is where "this is not what we asked for" actually lives. No coordinate needed, ' +
          'and nothing is required here — an empty list says the ask settled everything.',
      ),
    }),
  ),
  handler: async (args) => {
    const wiring = deps.openPr;
    if (!wiring) {
      return toolError(
        'Pull-request authoring is not wired on this harness. Open the pull request yourself against ' +
          'the branch and base named in your prompt.',
      );
    }
    const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
    if (!summary) return toolError('open_pr rejected: summary is required and must not be empty.');
    const given = typeof args.body === 'string' ? args.body.trim() : '';
    if (deps.manualDescriptions && given !== '')
      return toolError(
        'open_pr rejected: this deployment writes its own pull-request descriptions. The body is the ' +
          'operator\u2019s, written against this pull request once it is open, so there is nothing for you ' +
          'to say here \u2014 drop the body argument and call again. Your account of the change goes in the ' +
          'evidence arguments, as coordinates.',
      );
    if (!deps.manualDescriptions) {
      const bodyRefusal = prBodyRefusal(given);
      if (bodyRefusal !== null) return toolError(`open_pr rejected: ${bodyRefusal}`);
    }

    const issueNumber = issueSubtreeNumber(task.originRef);
    const plan = issueNumber === null ? null : deps.store.plans.getPlanByOrigin(issueOrigin(issueNumber));
    const target = resolveOpenPr(task.originRef, {
      issues: deps.store.world.getWorldBaseline()?.issues ?? [],
      plan,
      parts: plan ? deps.store.plans.listPlanParts(plan.id) : [],
      defaultBranch: wiring.defaultBranch,
    });
    if ('error' in target) return toolError(target.error);

    const facts = diffFacts((await wiring.git?.diff(target.base, target.branch)) ?? null);
    const evidence = evidenceOf(args);
    const evidenceRefused = evidenceRefusal(evidence, { criteria: target.criteria, facts });
    if (evidenceRefused !== null) return toolError(`open_pr rejected: ${evidenceRefused}`);

    const title = renderPrTitle(
      wiring.prompts.render('pr-title', {}),
      prTitleFields({
        number: target.issueNumber,
        title: target.issueTitle,
        position: target.position,
        total: target.total,
        type: typeof args.type === 'string' ? args.type : undefined,
        scope: typeof args.scope === 'string' ? args.scope : undefined,
        summary,
      }),
    );

    const reference =
      target.total > 1
        ? `Part ${target.position}/${target.total} of #${target.issueNumber}.`
        : `Relates to #${target.issueNumber}.`;
    const evidenceBlock = renderEvidence({
      evidence,
      criteria: target.criteria,
      issueNumber: target.issueNumber,
      issueTitle: target.issueTitle,
      facts,
    });
    // With `manualDescriptions` on, nothing of the operator's goes above the block
    // here: they write the description after reading the pull request, so it always
    // lands as an edit and never at the open. What opens is the evidence and the
    // reference — `07`'s existing answer to an absent body, not a new one. The
    // agent's `given` cannot reach here either; it was refused above.
    // → docs/spec/07-pull-requests.md#the-operator-writes-the-description
    const tail = [evidenceBlock, reference].filter((part) => part !== '').join('\n\n');
    const body = deps.manualDescriptions ? tail : [given, tail].filter((part) => part !== '').join('\n\n');

    try {
      const result = await wiring.sink.createPullRequest({
        branch: target.branch,
        base: target.base,
        title,
        body,
      });
      const prNumber = result.ref ? Number(result.ref) : null;
      if (prNumber !== null && Number.isFinite(prNumber)) {
        await seedPrWatch(
          { prNumber, branch: target.branch },
          { sink: wiring.sink, store: deps.store, watchLabel: wiring.watchLabel, errors: deps.errors },
        );
        await linkPrWorkItem(
          { prNumber, workItemNumber: target.issueNumber },
          { sink: wiring.sink, store: deps.store, errors: deps.errors },
        );
        // The tail this body carries, kept so the description written against the
        // open pull request goes in front of it without the body being read back off
        // the provider. → docs/spec/07-pull-requests.md#the-operator-writes-the-description
        if (deps.manualDescriptions && target.partRef !== null) {
          deps.store.prDescriptions.recordPrBody({ originRef: target.partRef, prNumber, tail });
        }
      }
      return ok({
        opened: result.ok,
        pullRequest: prNumber,
        title,
        branch: target.branch,
        base: target.base,
        note:
          target.base === wiring.defaultBranch
            ? 'Opened against the default branch.'
            : `Opened against ${target.base} — your work is stacked on it, so do not retarget this at the default branch.`,
      });
    } catch (err) {
      return toolError(openPrFailure((err as Error).message, target.branch, target.base));
    }
  },
});
