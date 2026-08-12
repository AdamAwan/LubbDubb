import type { Config } from './config.js';

/**
 * Who a ticket the harness files is assigned to.
 *
 * ## The gap this closes
 *
 * All four filing arms — a deferred finding, unrecorded work, a blueprint, a bug
 * the operator raised — created their item **unassigned**, and an unassigned item
 * is in nobody's queue. The operator who asked for the ticket then has to go and
 * claim it in the tracker by hand, on a ticket they are already the owner of.
 *
 * Unlike the ticket's wording, the assignee is not a judgement being delegated to
 * the filing agent: an agent running in a scratch directory cannot infer who
 * asked for the work any more than it can infer which tracker to file into. It is
 * the same class of fact as the coordinates, so it travels with them.
 *
 * ## Why it rides in the coordinates and not in a placeholder
 *
 * A new `{assignee}` token would be dropped silently by every prompt override
 * that never learned about it — exactly the deployments that customised most
 * (CLAUDE.md, "Prompts and templates"). `{tracker}` is already rendered by all
 * four filing templates, so the assignee arrives as part of it: the flag spliced
 * into the create command that is already in that string, plus one paragraph
 * saying it is not optional.
 *
 * Null when no assignee is configured, and the coordinates then read exactly as
 * they did before — a deployment with nobody to assign to still files tickets.
 */

interface TicketAssignment {
  /** Spliced into the create command in the coordinates; already space-prefixed. */
  flag: string;
  /** The paragraph appended after them, telling the agent the flag is not optional. */
  note: string;
}

/**
 * The assignment for the provider **actually serving issues** — the same
 * selection `trackerCoordinates` reads, so the assignee belongs to the tracker
 * the ticket lands in. A GitHub login and an Azure UPN are different identities;
 * neither is meaningful to the other's provider, which is why this is configured
 * per provider rather than once.
 *
 * Azure falls back to `filters.workItemAssignedTo`. Where that filter is set the
 * harness surfaces only items assigned to that identity, so an item filed to
 * anyone else — including nobody — is invisible to the harness that filed it:
 * created, then immediately lost. GitHub has no equivalent to fall back to, since
 * `filters.prAuthor` names the account the harness *acts as*, not the operator.
 */
export function ticketAssignment(config: Config): TicketAssignment | null {
  const provider = config.integrations.issues;
  if (provider === 'github' && config.github) {
    const who = config.github.defaultAssignee?.trim();
    return who ? { flag: ` --assignee ${who}`, note: assignmentNote(who) } : null;
  }
  if (provider === 'azure' && config.azureDevOps) {
    const az = config.azureDevOps;
    const who = (az.defaultAssignee ?? az.filters?.workItemAssignedTo)?.trim();
    return who ? { flag: ` --assigned-to "${who}"`, note: assignmentNote(who) } : null;
  }
  return null;
}

/**
 * The wording, in one place for both coordinate builders.
 *
 * Three things it has to say, each earned by a way the assignment goes wrong: the
 * flag is not decoration (an agent editing the command down drops it first); it
 * applies only to what the agent *creates* (every filing template offers linking
 * an existing item instead, and reassigning somebody else's ticket is a side
 * effect nobody asked for); and a refused assignment must not cost the ticket —
 * an identity the project cannot assign is a configuration problem, not a reason
 * to come back empty.
 */
function assignmentNote(who: string): string {
  return (
    `Assign it to \`${who}\` — that is what the assignee flag above does, and it is not optional: ` +
    "an unassigned item sits in nobody's queue, which is the state this filing exists to avoid. " +
    'Only the item you create: if you link an existing one instead of filing, leave its assignee ' +
    'as it is. If the tracker refuses the assignment — an identity it does not know, or one that ' +
    'cannot be assigned in this project — create the item anyway, unassigned, and say so when you ' +
    'report back.'
  );
}
