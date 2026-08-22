import { corroborationGoal, validateRaise } from '../../knowledge/knowledge.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

/**
 * The door `raise` replaced, kept working and named nowhere.
 *
 * **It is still registered on purpose.** Withdrawing a tool name fails silently in
 * the one place it matters most: an operator's prompt override written before the
 * intake may still say `report_finding`, and a name dropped from `MCP_TOOL_NAMES`
 * and the `--allowedTools` grants comes back refused with nothing in the logs to
 * say why — on exactly the deployments that customised most. Unlike a `PromptId`,
 * whose removal turns a deployment into a harness that will not boot and says so,
 * a withdrawn tool name is a call that quietly does not work. So it is classified
 * `superseded` in `test/mcpChannel.test.ts` and advertised in no prompt.
 *
 * **What it writes is a `knowledge_facts` row, like everything else.** There is one
 * claim store now, so the shape of this call is a translation rather than a second
 * writer: `summary` is the claim, `detail` is the evidence, `where` and `ref` are
 * the two coordinates a fact already carried under the same two names. Keeping a
 * second table alive so an unadvertised tool could keep writing to it is exactly
 * the drift the merge removed.
 *
 * **`kind` is accepted and ignored**, which is the one thing here worth arguing.
 * It was the agent's guess at what an operator would do about the claim — the
 * operator's knowledge and not the agent's — and it is the question `raise` exists
 * to have stopped asking. Refusing a call that supplies one would break the
 * overrides this tool is kept alive *for*; storing it would be reviving a taxonomy
 * nothing else writes. So it rides into the evidence, where an operator reads how
 * the claim arrived, and decides nothing.
 */
export const reportFinding: ToolFactory = ({ deps, agent, task, ok }) => ({
  description:
    'Superseded by `raise`, and kept working for prompts written before it. File something an ' +
    'operator should see that your own task will not deliver: something you noticed that is NOT ' +
    'your task, or something you learned about THIS REPOSITORY that the repository itself does not ' +
    'say.\n\n' +
    'It does NOT create work or dispatch anyone: an operator decides whether it becomes a job. ' +
    'So report it and carry on with your own task — do not wait, and do not go fix it yourself. ' +
    'If another agent already raised the same claim, yours is recorded as agreeing with theirs ' +
    'rather than filing a second copy.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        description:
          'Accepted and ignored. Which kind of thing this is was a guess at what an operator would ' +
          'do about it, which is their knowledge and not yours — the harness works out where a claim ' +
          'goes. Whatever you pass is kept with the evidence and decides nothing.',
      },
      summary: {
        type: 'string',
        description:
          'The claim, on ONE line under 160 characters — what it is and why it matters. No ' +
          'newlines: an operator scans this in a list. Everything else goes in where and detail.',
      },
      where: {
        type: 'string',
        description:
          'Where you saw it: file and line, package, service, endpoint — whatever locates it. ' +
          'Omit it when the summary already says, or when there is nowhere to point.',
      },
      detail: {
        type: 'string',
        description:
          'The evidence, in markdown: the error, how to reproduce it, your reasoning. Put ' +
          'stack traces and command output in a fenced code block. This is what an operator reads ' +
          'to decide whether the claim should reach other agents.',
      },
      ref: {
        type: 'string',
        description:
          'The item this is about, if there is one: "issue:41", "pr:42". For a ' +
          'duplicate, the item you believe it duplicates. Omit it when the finding is about ' +
          'something the harness does not track.',
      },
    },
    required: ['summary', 'detail'],
  },
  handler: (args) => {
    const raw = args as Record<string, unknown>;
    const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
    // The one refusal this door kept, and the one worth keeping: the only cheap
    // moment to fix a blob is the agent's own turn, and an unreadable row costs an
    // operator every time they open it. `raise` bounds the claim but takes a line
    // or two; this arm still asks for the one line it always asked for.
    if (/[\r\n]/.test(summary)) {
      return toolError(
        'Finding rejected: summary must be a single line — the claim on its own. Put the error, the ' +
          'repro and the reasoning in detail, and the file or package in where.',
      );
    }
    if (summary.length > MAX_SUMMARY) {
      return toolError(
        `Finding rejected: summary is ${summary.length} characters; keep it under ${MAX_SUMMARY}. It is ` +
          'the one line an operator scans — move the rest into detail.',
      );
    }
    // Translated into the intake's own arguments and validated by the intake's own
    // validator, so a claim filed through this door and one raised through `raise`
    // are bounded, located and matched identically. Two validators for one row is
    // how two doors come to disagree about what a claim is.
    const parsed = validateRaise(
      { claim: summary, evidence: evidenceOf(raw), where: raw.where, ref: raw.ref },
      corroborationGoal(task.originRef),
    );
    if (!parsed.ok) return toolError(`Finding rejected: ${parsed.error}`);
    // Attribution is the credential's, never an argument's. `world_read` could
    // relax the no-cross-origin rule because a read forges nothing; this is a
    // *write* that puts words in an agent's mouth in front of an operator, and a
    // claim is read as testimony about work its author actually did.
    const result = deps.agents.proposeFact(agent.id, parsed.proposal);
    if (!result.ok) return toolError(result.error);
    const outcome = result.outcome;
    if (outcome.outcome === 'barred') {
      return toolError(
        `An operator has rejected this claim, so it cannot be filed again: "${outcome.barredBy.claim}" ` +
          `(${outcome.barredBy.id}). Rejected means it was judged not true. If what you saw genuinely ` +
          `differs, raise the sharper version with the \`raise\` tool's contradicts argument.`,
      );
    }
    return ok({
      recorded: true,
      fact: { id: outcome.fact.id, scope: outcome.fact.scope, reach: outcome.fact.reach },
      corroborations: outcome.corroborations,
      // Said again in the response, not only in the description: an agent that
      // believes reporting a bug scheduled its fix will stop watching for it. And
      // an agent whose report merged is told so rather than left to conclude from a
      // returned id that it filed something new.
      note:
        outcome.outcome === 'filed'
          ? 'Filed for an operator. It queues no work by itself and reaches no other agent yet — keep ' +
            'going with your own task.'
          : `Recorded as agreeing with a claim already raised — ${outcome.corroborations} independent ` +
            `${outcome.corroborations === 1 ? 'goal has' : 'goals have'} now seen it. Nothing more to do.`,
    });
  },
});

/** The one line an operator scans in a list. `raise` bounds the claim; this door bounds the headline. */
const MAX_SUMMARY = 160;

/**
 * What the agent saw, with whatever `kind` it named folded in.
 *
 * The word decides nothing and is not stored as a field, but throwing it away
 * would lose the one thing about a call through this door that is not true of a
 * `raise`: the agent thought it was sorting the claim. An operator reading the
 * provenance is better served by seeing that than by a sentence that pretends the
 * call arrived through the front.
 */
function evidenceOf(args: Record<string, unknown>): string {
  const detail = typeof args.detail === 'string' ? args.detail.trim() : '';
  const kind = typeof args.kind === 'string' ? args.kind.trim() : '';
  const how = kind ? `Reported through report_finding as a "${kind}" finding.` : 'Reported through report_finding.';
  return detail ? `${how}\n\n${detail}` : how;
}
