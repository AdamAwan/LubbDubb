import type { Config } from '../config.js';
import type { ActionSink } from '../sink/actionSink.js';
import { ticketAssignee } from '../ticketAssignment.js';
import { bugFilingType, filingType } from '../ticketTypes.js';

/**
 * Filing a tracker item, from the harness rather than from an agent's shell
 * (issue #394).
 *
 * ## What this replaced
 *
 * Four cockpit buttons filed a ticket, and each spent a whole desk agent doing it.
 * The harness composed the *exact command* — `gh issue create -R … --label … `,
 * `az boards work-item create … --type …` followed by
 * `az boards work-item relation add …` — and handed it to a model to type back.
 * The judgement in that (dedupe, and writing the thing up) is real; the command is
 * not, and it was the half that could silently go wrong. A blueprint whose ticket
 * lost its watch label is created, linked, and shown in the cockpit as a completed
 * filing while **nothing is ever dispatched for it** — nothing errors, and nothing
 * is red.
 *
 * So the four facts a model used to have to remember — the label, the type, the
 * assignee and the relation — are arguments here, and two of the four arms no
 * longer dispatch anything at all.
 *
 * ## Why a function and not a desk
 *
 * A filing is **operator-initiated from a route**, so it is neither of the two
 * shapes the harness already has: not an executor action (nothing proposed it, and
 * there is no decision to audit — the operator's click is the decision), and not a
 * desk pass on the pulse (the operator is waiting for the ticket's number, and a
 * pulse-time filing would answer them a heartbeat later with no way to say why).
 * It is a call the route makes, on the request, and it either produces a ref or
 * refuses.
 *
 * The one thing it must not become is a second opinion about *when* to file. It
 * files what it is given. Which things get filed is unchanged: the same four
 * clicks, in the same places.
 */

/** One item to create, in provider-neutral terms. */
interface TicketFiling {
  title: string;
  body: string;
  /**
   * Labels / tags to create it with — the effective watch label for a blueprint,
   * which is the whole of why that arm could not stay a prompt.
   */
  labels?: string[];
  /**
   * True when this is a bug an operator raised, which changes two things: the work
   * item type it is created as, and nothing else. Whether it is *linked* is
   * `relatedTo`'s business, because a bug filed against no story is still a bug.
   */
  bug?: boolean;
  /** The story this is related to — the bug/story edge, drawn in each tracker's own way. */
  relatedTo?: number;
}

/**
 * Files one item and answers its ref (`issue:314`) — the vocabulary a filing row
 * stores and `link_ticket` speaks, so no caller ever handles a provider id.
 *
 * A function rather than an object, because there is exactly one thing to do with
 * it and the four call sites are already holding a config they should not have to
 * re-read.
 */
export type TicketFiler = (input: TicketFiling) => Promise<string>;

/**
 * Bind a filer to this deployment: the tracker's type vocabulary and the identity
 * a filed ticket belongs to are config, and resolving them per call is what stops
 * a route needing to know either.
 *
 * Nothing here checks that a tracker is configured. That gate is
 * {@link trackerCoordinates}, asked by every filing route before anything else, and
 * one gate asked in one place is why all four refuse identically.
 */
export function ticketFiler(config: Config, sink: ActionSink): TicketFiler {
  return async (input) => {
    const result = await sink.createIssue({
      title: input.title,
      body: input.body,
      labels: input.labels ?? [],
      type: input.bug ? bugFilingType(config) : filingType(config),
      assignee: ticketAssignee(config),
      relatedTo: input.relatedTo ?? null,
    });
    // A create that answered without a ref is the one failure the seam cannot
    // express as a throw: the item may well exist, and there is nothing to record
    // it under. Named as such rather than returning an empty ref, which would be
    // written onto a filing row and read as a ticket forever after.
    if (!result.ok || !result.ref) throw new Error('the tracker accepted the item but did not say what it created');
    return result.ref;
  };
}
