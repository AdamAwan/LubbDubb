/**
 * Turning an injected code **blueprint** into a ticket the planning funnel picks
 * up (issue #198).
 *
 * ## The gap this closes
 *
 * An operator-launched code job (a "blueprint" from the cockpit's New blueprint
 * panel) used to be dispatched straight onto a branch by rule `manual-job`, on the raw
 * prompt — skipping the whole funnel a *picked-up* ticket goes through: the goal
 * assay, the planning agent, the plan's parts. The workflow's two entry points
 * ("start with a prompt", "start with a ticket") are drawn converging on
 * *find-or-create a ticket, then the funnel*, and the prompt arm was never wired
 * to that convergence.
 *
 * So a code blueprint, when a tracker is configured, is filed as a **watched
 * ticket** instead of dispatched, and the funnel takes over with no new dispatcher
 * wiring, because the funnel already keys on watched issues. The one thing a
 * finding-filed ticket does not need and a blueprint does: the issue must carry the
 * effective `-watch` label, or the watch gate never picks it up.
 *
 * That label is why this arm no longer spends a desk agent (issue #394). An agent
 * that forgot it left the item created, the filing shown complete in the cockpit,
 * and **nothing ever dispatched** for it — no error and nothing red, which is
 * exactly the genre `CLAUDE.md` collects. The harness passes the label to the
 * create, so it cannot be forgotten; and the ticket's body was always the
 * operator's own request verbatim, so the only judgement being delegated was a
 * title.
 *
 * The wording an operator has opinions about still lives in a template
 * (`blueprint-ticket-body`), so this module is only the pure fields the route
 * renders it with — testable without a server.
 */

const MAX_TITLE = 80;

/**
 * The title and body vars for the ticket a blueprint becomes.
 *
 * `request` is the operator's prompt, carried verbatim: it *is* the ticket's body,
 * which is why nothing was ever being delegated here but a title. The title is
 * derived from its first line, and the operator may still replace it before it
 * files (`body.title` on the launch route).
 *
 * The watch label is no longer here. It used to be composed into a `{labelling}`
 * paragraph telling the agent to add it — with an empty-case branch, because
 * `labelPrefix: ''` turns the watch gate off and instructing an agent to add a
 * `` label would be a bug. The harness passes the label to the create now, so both
 * readings are a `labels` array and neither is a sentence.
 */
export function blueprintTicketFields(request: string): { title: string; vars: Record<string, string> } {
  const firstLine =
    request
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? request;
  return { title: firstLine.slice(0, MAX_TITLE), vars: { request } };
}
