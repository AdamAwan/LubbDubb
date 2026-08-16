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
 * selection `trackerCoordinates` reads, so the flag spelling belongs to the
 * tracker the ticket lands in.
 *
 * Who it names is `userId`, which is the same fact the ownership gate and the PR
 * author filter read: the harness works one person's queue, and a ticket it files
 * belongs to that person. The identity itself is per *deployment* rather than per
 * provider, because one project is worked at a time — the string is a GitHub login
 * where `integrations.issues` is `github` and an Azure UPN where it is `azure`,
 * and only one of those is ever in force.
 *
 * Null when `userId` is unset, and the coordinates then read exactly as they did
 * before: a deployment with nobody to assign to still files tickets.
 */
export function ticketAssignment(config: Config): TicketAssignment | null {
  const who = config.userId?.trim();
  if (!who) return null;
  const provider = config.integrations.issues;
  if (provider === 'github' && config.github) return { flag: ` --assignee ${who}`, note: assignmentNote(who) };
  if (provider === 'azure' && config.azureDevOps) return { flag: ` --assigned-to "${who}"`, note: assignmentNote(who) };
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
