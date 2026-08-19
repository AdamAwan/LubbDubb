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
 * ## Why it is not a prompt placeholder any more
 *
 * It used to be a `--assignee` flag spliced into the `gh`/`az` command the filing
 * prompt carried, plus a paragraph telling the agent the flag was not optional —
 * three sentences earning their place because an agent editing the command down
 * dropped the flag first. Issue #394 removed the command: the harness files the
 * item itself and passes this straight to
 * {@link ActionSink.createIssue}, so there is no longer a
 * sentence for a model to forget.
 *
 * Null when no assignee is configured, and a deployment with nobody to assign to
 * still files tickets — unassigned, exactly as it always did.
 */

/**
 * The assignee for the provider **actually serving issues**, so the identity
 * belongs to the tracker the ticket lands in.
 *
 * Who it names is `userId`, which is the same fact the ownership gate and the PR
 * author filter read: the harness works one person's queue, and a ticket it files
 * belongs to that person. The identity itself is per *deployment* rather than per
 * provider, because one project is worked at a time — the string is a GitHub login
 * where `integrations.issues` is `github` and an Azure UPN where it is `azure`,
 * and only one of those is ever in force.
 */
export function ticketAssignee(config: Config): string | null {
  const who = config.userId?.trim();
  if (!who) return null;
  const provider = config.integrations.issues;
  if (provider === 'github' && config.github) return who;
  if (provider === 'azure' && config.azureDevOps) return who;
  return null;
}
