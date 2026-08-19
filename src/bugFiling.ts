/**
 * Raising a **bug** against a story the harness already worked.
 *
 * ## The gap this closes
 *
 * An operator looking at a story the harness believes is finished had no way to
 * say "this shipped, and it does not do what I expect". The two verdict buttons
 * on the row are both about the story's own completeness, and the `more_work`
 * one writes a fixed note (`Set by the operator from the cockpit.`) carrying not
 * one word of what is actually wrong.
 *
 * That observation is the one fact no agent on the goal can derive. The assayer
 * read the ticket, the planner read the repository, the working agent read its
 * own diff — none of them ran the thing and formed an expectation about it.
 *
 * ## Shape
 *
 * The same shape as `finding-ticket`: a desk job, an overridable prompt naming the
 * tracker, and `link_ticket` to report back. What the agent does *not* do any more
 * is create the item — since #394 it composes the title and the body and hands both
 * to `link_ticket`, and the harness files them. That is what closes the hole this
 * arm had: a bug is only correct with **two** writes, the create and the relation
 * back to the story, and a model that got the first and forgot the second left a
 * bug nobody could trace with nothing red. The relation is now a field on
 * {@link IssueCreateInput}, not a second command in a prompt.
 *
 * The wording an operator has opinions about still lives in the template, so this
 * module is only the pure fields the route renders it with — testable without a
 * server, and leaving the route with nothing but `render` + `createJob`.
 *
 * The story's own verdict is deliberately untouched: the bug is its own work item
 * and carries the work, which is also the only arrangement where the fleet is
 * handed the operator's actual words as the goal.
 */

const MAX_TITLE = 80;

/**
 * The title and template vars for a raised bug's filing job.
 *
 * `summary` is the operator's own report, carried verbatim so the desk agent
 * writes the bug from what they actually said. `title` is the **job's**, not the
 * bug's — the agent writes the bug's title (that is the judgement being
 * delegated); this one only has to be recognisable in the Up next queue.
 */
export function bugTicketFields(
  issue: { number: number; title: string },
  summary: string,
  tracker: string,
): { title: string; vars: Record<string, string> } {
  const firstLine =
    summary
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? summary;
  const title = `Raise bug on #${issue.number}: ${firstLine}`.slice(0, MAX_TITLE);
  return {
    title,
    vars: { number: String(issue.number), title: issue.title, summary, tracker },
  };
}
