import type { Config } from './config.js';

/**
 * What **type** of work item the harness files.
 *
 * ## The gap this closes
 *
 * Every non-bug filing arm — a deferred finding, unrecorded work, a blueprint —
 * created an Azure DevOps `Task`, hardcoded into the coordinates. A Task is the
 * wrong altitude for all three: it is the unit a story is broken into *once
 * someone is working it*, so one filed from the cockpit arrives with no story
 * above it, rolls up to nothing, and does not appear on a backlog anybody
 * grooms. The board fills with orphaned low-level items while the work they
 * describe is invisible at the level it is planned at.
 *
 * The types a project actually files at are its own — "User Story" and "Bug" on
 * the Agile template, "Product Backlog Item" on Scrum, "Issue" on Basic, plus
 * whatever custom types a process has been extended with. So the harness carries
 * a list rather than a type, and the *choice within it* is the filing agent's,
 * on the same argument that leaves it the ticket's wording: which of a story, a
 * debt item and a bug this is, is a judgement about the report, and only the
 * agent has read it.
 *
 * ## Why it rides in the coordinates and not in a placeholder
 *
 * The same reason the assignee does (→ {@link file://./ticketAssignment.ts}): a
 * new `{type}` token would be dropped silently by every prompt override that
 * never learned about it — exactly the deployments that customised most
 * (CLAUDE.md, "Prompts and templates"). `{tracker}` is already rendered by all
 * four filing templates, so the type arrives as part of it: the flag spliced
 * into the create command that is already in that string, plus a paragraph
 * naming the closed list.
 *
 * ## Azure only
 *
 * Same scope as `issueContainerTypes`: a work item type is a thing only Azure
 * reports and only Azure accepts on create. A GitHub issue has no type, so its
 * coordinates read exactly as they did before — there is nothing there to get
 * wrong.
 */

/**
 * The types filed where the operator has named none.
 *
 * Azure's Agile template names, matched by the same reasoning
 * `DEFAULT_CONTAINER_TYPES` uses: it is the most widely deployed process, and a
 * project on another one lists its own. Deliberately **not** including a
 * decomposition type — the default has to be the altitude a backlog is groomed
 * at, or this module has changed nothing.
 */
export const DEFAULT_FILING_TYPES = ['User Story', 'Bug'];

interface TicketTypeGuidance {
  /** Spliced into the create command in the coordinates; already space-prefixed. */
  flag: string;
  /** The paragraph appended after them, naming the list and what is not on it. */
  note: string;
}

/**
 * The type clause for the provider **actually serving issues**, or null where the
 * tracker has no such concept (GitHub, the fake, an unconfigured provider) and
 * the coordinates must read as they always did.
 *
 * An empty configured list falls back to the default rather than rendering a
 * `--type` with nothing to put in it: `[]` on `issueContainerTypes` means "turn
 * the gate off", but there is no off here — a work item is created *as*
 * something, and a create command missing the flag is refused by Azure outright.
 */
export function ticketTypeGuidance(config: Config): TicketTypeGuidance | null {
  if (config.integrations.issues !== 'azure' || !config.azureDevOps) return null;
  const types = (config.issueFilingTypes ?? []).map((t) => t.trim()).filter((t) => t.length > 0);
  const allowed = types.length > 0 ? types : DEFAULT_FILING_TYPES;
  const only = allowed.length === 1 ? allowed[0] : undefined;
  return {
    flag: only ? ` --type "${only}"` : ' --type "<type>"',
    note: typeNote(allowed, only),
  };
}

/**
 * The wording.
 *
 * Three things it has to say, each earned by a way the type goes wrong. The list
 * is **closed** (an agent handed a menu treats it as a suggestion and reaches
 * for whatever the project also offers). A decomposition type is named and
 * refused outright, because that is the failure this exists to stop and "pick
 * the right one" does not read as excluding the one it has always picked. And an
 * imperfect fit resolves to the closest entry rather than to an invented type —
 * Azure refuses a type the project does not define, and the ticket is lost with
 * it, which is strictly worse than a story that should have been a debt item.
 */
function typeNote(allowed: string[], only: string | undefined): string {
  const list = allowed.map((t) => `"${t}"`).join(', ');
  const opening = only
    ? `File it as a ${list} — that is the only work item type this harness creates, and the type flag ` +
      'above is already set to it.'
    : `Choose the \`<type>\` from exactly this list: ${list}. That is the closed set of work item types ` +
      'this harness creates — pick the one that fits what you are filing, and file nothing outside it.';
  return (
    `${opening} In particular do not file a Task, or any other item the project uses to break a story ` +
    'down: those belong under a story somebody is already working, and one filed here has nothing above ' +
    'it to roll up to and appears on no backlog anybody grooms. If none of the types fits exactly, use ' +
    'the closest one and say so in the body — a type the project does not define is refused outright, ' +
    'and the ticket is lost with it.'
  );
}
