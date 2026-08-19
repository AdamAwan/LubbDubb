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
 * the names rather than assuming them.
 *
 * ## Why the harness chooses, and not the agent
 *
 * It used to be the filing agent's judgement, spliced into the `az` command in the
 * ticket coordinates: the list was rendered into a prompt and the model picked
 * one. That is the class of thing issue #394 removed. Azure refuses an untyped
 * create outright, so a model that trimmed the flag lost the ticket — and, worse,
 * a model that picked the wrong one filed a bug as a story with nothing red. The
 * harness already knows which of the two arms it is in; that is not a judgement,
 * it is a fact about the route the operator clicked.
 *
 * ## Azure only
 *
 * Same scope as `issueContainerTypes`: a work item type is a thing only Azure
 * reports and only Azure accepts on create. A GitHub issue is not created *as*
 * anything, so both functions answer null there and
 * {@link GitHubIssuesIntegration.createIssue} drops the field.
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

/** Filed where `issueBugType` is unset. The Agile and Scrum templates' name for it. */
const DEFAULT_BUG_TYPE = 'Bug';

/**
 * The type a *non-bug* filing is created as — a deferred finding, unrecorded work,
 * a blueprint — or null where the tracker has no such concept.
 *
 * **The first configured type, not a choice among them.** `issueFilingTypes` was
 * written as a menu for a model to pick from, and with the harness filing directly
 * there is no picker left; the honest reading of a list whose order the operator
 * chose is that its head is the default. The rest still document what the project
 * files at, which is what makes the key readable at all.
 *
 * An empty list falls back to the default rather than yielding an empty `type`:
 * `[]` on `issueContainerTypes` means "turn the gate off", but there is no off
 * here — a work item is created *as* something, and Azure refuses a create without
 * one.
 */
export function filingType(config: Config): string | null {
  if (config.integrations.issues !== 'azure' || !config.azureDevOps) return null;
  const named = (config.issueFilingTypes ?? []).map((t) => t.trim()).find((t) => t.length > 0);
  return named ?? DEFAULT_FILING_TYPES[0]!;
}

/**
 * The type a **bug** an operator raised is created as, or null where the tracker
 * has no such concept.
 *
 * Its own key rather than the first entry of `issueFilingTypes` that looks like a
 * bug: what a process template calls its bug type is exactly the thing that
 * varies — the Basic process calls it "Issue" — and matching on the word is the
 * kind of guess that files a story as a bug on the one project it is wrong for,
 * silently. Unset, it is `Bug`, which is what the raise-bug arm hardcoded before
 * the harness filed anything itself.
 */
export function bugFilingType(config: Config): string | null {
  if (config.integrations.issues !== 'azure' || !config.azureDevOps) return null;
  return config.issueBugType?.trim() || DEFAULT_BUG_TYPE;
}
