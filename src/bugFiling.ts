import type { Config } from './config.js';
import { ticketAssignment } from './ticketAssignment.js';

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
 * The same shape as `finding-ticket` / `work-item-ticket` / `blueprint-ticket`: a
 * desk job, an overridable prompt naming the tracker, and `link_ticket` to report
 * the ref back. The wording an operator has opinions about lives in the template,
 * so this module is only the pure fields the route renders it with — testable
 * without a server, and leaving the route with nothing but `render` +
 * `createJob`.
 *
 * The story's own verdict is deliberately untouched: the bug is its own work item
 * and carries the work, which is also the only arrangement where the fleet is
 * handed the operator's actual words as the goal.
 */

const MAX_TITLE = 80;

/**
 * Where a raised bug goes, in the words the filing agent needs — the bug-shaped
 * sibling of `trackerCoordinates`, which files a `Task` and knows nothing about
 * relations.
 *
 * Two commands rather than one, because a bug that is not linked back to its
 * story is a bug nobody can trace: the create, then the relation. **`related`,
 * not parent/child** — it is legal whatever process template the project uses and
 * changes neither item's rollup or board position, while a parent link from a
 * User Story to a Bug is valid only where the project manages bugs at the task
 * level and is refused outright where it is not.
 *
 * GitHub gets the same two halves in its own vocabulary rather than a port of
 * Azure's: the type is a `bug` label, and the link is a **cross-reference** —
 * naming `#<story>` in the body is what makes GitHub draw the edge on both
 * issues, and it is the closest thing GitHub has to a related link. Null only for
 * the `fake` provider and an unconfigured one, where there is no tracker at all;
 * the cockpit hides the button rather than offering one that fails.
 *
 * The assignee rides along on the same argument the coordinates themselves do —
 * a desk agent cannot infer who raised the bug. → `src/ticketAssignment.ts`.
 */
export function bugTrackerCoordinates(config: Config, storyNumber: number): string | null {
  const provider = config.integrations.issues;
  const assignment = ticketAssignment(config);
  const assign = assignment?.flag ?? '';
  const note = assignment ? `\n\n${assignment.note}` : '';
  if (provider === 'github' && config.github) {
    const slug = `${config.github.owner}/${config.github.repo}`;
    return (
      `the GitHub repository ${slug}. Create it with:\n\n` +
      `  gh issue create -R ${slug} --label bug --title "<title>" --body "<body>"${assign}\n\n` +
      `Name issue #${storyNumber} in the body (write it as "#${storyNumber}") — that cross-reference ` +
      `is what links the two, and GitHub shows it on both. If the repository has no "bug" label, ` +
      `drop the --label flag rather than creating one.${note}`
    );
  }
  if (provider === 'azure' && config.azureDevOps) {
    const { organization, project } = config.azureDevOps;
    const org = `https://dev.azure.com/${organization}`;
    return (
      `the Azure DevOps project "${project}" in organization "${organization}". Create it with:\n\n` +
      `  az boards work-item create --org ${org} --project "${project}" ` +
      `--type Bug --title "<title>" --description "<body>"${assign}\n\n` +
      `Then link it back to story #${storyNumber}, using the id the create command returned:\n\n` +
      `  az boards work-item relation add --org ${org} --id <new bug id> ` +
      `--relation-type related --target-id ${storyNumber}${note}`
    );
  }
  return null;
}

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
