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
 * ticket** instead of dispatched: a desk agent creates the issue with `gh`/`az`
 * and the funnel takes over with no new dispatcher wiring, because the funnel
 * already keys on watched issues. The one thing a finding-filed ticket does not
 * need and a blueprint does: the issue must carry the effective `-watch` label,
 * or the watch gate never picks it up.
 *
 * This is the same shape as `finding-ticket` / `work-item-ticket`: a desk job, an
 * overridable prompt naming the tracker, and `link_ticket` to report the ref
 * back. The wording an operator has opinions about lives in the template, so this
 * module is only the pure fields the route renders it with — testable without a
 * server, and leaving the route with nothing but `render` + `createJob`.
 */

const MAX_TITLE = 80;

/**
 * The title and template vars for a blueprint's ticket-filing desk job.
 *
 * `request` is the operator's prompt, carried verbatim so the desk agent writes
 * the ticket from the actual ask. `title` is the *job's*, not the ticket's — the
 * agent writes the ticket's title (that is the judgement being delegated); this
 * one only has to be recognisable in the Up next queue.
 *
 * `labelling` is composed here rather than in the template because the empty case
 * is real: `labelPrefix: ''` turns the watch gate off (the harness acts on every
 * open issue), so there is then no label to add and instructing the agent to tag
 * a `` label would be a bug. Both readings are decided in one pure place. The raw
 * `watchLabel` is passed through too, so an override can word its own instruction.
 */
export function blueprintTicketFields(
  request: string,
  tracker: string,
  watchLabel: string,
): { title: string; vars: Record<string, string> } {
  const firstLine =
    request
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? request;
  const title = `File ticket: ${firstLine}`.slice(0, MAX_TITLE);
  const labelling = watchLabel
    ? `Add the label \`${watchLabel}\` to the issue when you create it. That label is what the ` +
      'harness watches: without it, nothing will pick the issue up to work it.'
    : 'The harness is configured to act on every open issue (no watch label), so no label is required.';
  return {
    title,
    vars: { request, tracker, watchLabel, labelling },
  };
}
