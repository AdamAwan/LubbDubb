import type { CockpitView } from '../../view/viewModel.js';
import { IN_FLIGHT } from '../Overview.js';

// → docs/spec/17-cockpit.md#when-nothing-needs-you

/**
 * Where a lead goes. A union rather than a callback, so a lead is a value the
 * tests can read and every lead has somewhere to go — the routing is one
 * `switch` in `NextOverview`, total over this type, and a lead added with no
 * route fails the typecheck rather than drawing a control that does nothing.
 */
export type LeadWhere =
  | { kind: 'upnext' }
  | { kind: 'reservoir' }
  | { kind: 'cards' }
  | { kind: 'faults' }
  | { kind: 'goal'; ref: string }
  | { kind: 'pr'; number: number };

/** One thing a lead names: the control's word, the ref beside it, and its way there. */
interface LeadItem {
  key: string;
  label: string;
  ref: string;
  where: LeadWhere;
}

export interface Lead {
  key: LeadKey;
  /** The figure, drawn in its own slot — a lead with nothing in it is never built. */
  count: number;
  /** What the figure counts, as a noun phrase reading on from it. */
  title: string;
  /** Why it is worth a look, and what the operator would be doing about it. */
  say: string;
  /** The word on the control that goes there. */
  go: string;
  where: LeadWhere;
  /** Up to {@link NAMED} of them by name, each its own way there. */
  items: LeadItem[];
}

type LeadKey = 'queued' | 'reservoir' | 'quiet' | 'prs' | 'faults';

/**
 * How many of a lead's own things it names. The figure says how many there are;
 * the names are there to make the lead concrete enough to press, and a column of
 * fifteen is the list surface this panel is pointing at rather than a lead.
 */
const NAMED = 3;

/**
 * What is worth a look when no ask is waiting.
 *
 * The one-at-a-time shape is a queue of asks, and an empty queue used to be the
 * end of it: a sentence saying nothing needs you, on the surface an operator
 * opens *to be told what to do*. But an empty ask queue is not an empty
 * deployment — it means only that nothing is **blocked on a person**, which is
 * the state a fleet spends most of its time in. The work nobody is asking about
 * is exactly the work nobody is looking at: a ticket the fleet cannot see because
 * nothing watches it, a queue nothing has been dispatched off, a goal in flight
 * with no agent on it, a pull request waiting on a review nobody has claimed.
 *
 * So the clear state draws **leads**: the readings that are true right now and
 * have somewhere to go. Each is built only where it has something in it — a lead
 * reading zero is furniture, and this panel is read at the moment an operator is
 * deciding whether there is anything here at all.
 *
 * **Nothing here re-decides what the server decided.** Every cut is a
 * `pickup.status`, an `attention` reading, or the queue's own row; the leads
 * choose which of them to put in front of somebody, and no more than that.
 */
export function buildLeads(view: CockpitView): Lead[] {
  const out: Lead[] = [];
  const { issues, pullRequests } = view.state.world;

  /* Only where nobody is out. A queue behind a working fleet is the fleet
     working, and saying so on the surface that just said nothing needs you
     would be a lead pointing at normal. */
  const idle = view.live.length + view.readying.length + view.deskRuns.length === 0;
  if (idle && view.upNext.length > 0) {
    out.push({
      key: 'queued',
      count: view.upNext.length,
      title: view.upNext.length === 1 ? 'candidate queued, and nobody is out' : 'candidates queued, and nobody is out',
      say: 'The harness has work it has not dispatched. Each row carries the reason it is still sitting there.',
      go: 'Open the queue',
      where: { kind: 'upnext' },
      items: [],
    });
  }

  /* Newest first: the reservoir is mostly old, and the item somebody filed this
     morning is the one a lead has any chance of being about. */
  const unwatched = issues.filter((issue) => issue.pickup.status === 'unwatched').sort((a, b) => b.number - a.number);
  if (unwatched.length > 0) {
    out.push({
      key: 'reservoir',
      count: unwatched.length,
      title: unwatched.length === 1 ? 'tracker item nobody has picked up' : 'tracker items nobody has picked up',
      say: `Nothing watches these, so the fleet never sees one. The ${view.state.config.watchLabel} label is what lets it.`,
      go: 'Open the tracker',
      where: { kind: 'reservoir' },
      items: unwatched.slice(0, NAMED).map(goalItem),
    });
  }

  /* Oldest first, which is the opposite cut and for the opposite reason: what
     makes an unstaffed goal worth finding is how long it has been sitting. */
  const quiet = issues
    .filter((issue) => IN_FLIGHT.has(issue.pickup.status) && !view.agentOnGoal.has(`issue:${issue.number}`))
    .sort((a, b) => a.number - b.number);
  if (quiet.length > 0) {
    out.push({
      key: 'quiet',
      count: quiet.length,
      title: quiet.length === 1 ? 'goal in flight with nobody on it' : 'goals in flight with nobody on them',
      say: 'No agent is out on these and nothing is asking about them. What happens next is on the goal’s own plan.',
      go: 'See them on Cards',
      where: { kind: 'cards' },
      items: quiet.slice(0, NAMED).map(goalItem),
    });
  }

  const waiting = pullRequests.filter((pr) => !view.agentOnBranch.has(pr.branch)).sort((a, b) => a.number - b.number);
  if (waiting.length > 0) {
    out.push({
      key: 'prs',
      count: waiting.length,
      title:
        waiting.length === 1 ? 'open pull request with no agent on it' : 'open pull requests with no agent on them',
      say: 'Each of these is in somebody’s court. Which court, and what its checks say, is on its own page.',
      go: 'See them on Cards',
      where: { kind: 'cards' },
      items: waiting.slice(0, NAMED).map((pr) => ({
        key: `pr:${pr.number}`,
        label: pr.title,
        ref: `pr:${pr.number}`,
        where: { kind: 'pr', number: pr.number },
      })),
    });
  }

  const faults = view.state.errors.length;
  if (faults > 0) {
    out.push({
      key: 'faults',
      count: faults,
      title: faults === 1 ? 'fault recorded' : 'faults recorded',
      say: 'Failures the harness caught and carried on past. Nothing is asking you to act on one.',
      go: 'Open the fault log',
      where: { kind: 'faults' },
      items: [],
    });
  }

  return out;
}

function goalItem(issue: { number: number; title: string }): LeadItem {
  const ref = `issue:${issue.number}`;
  return { key: ref, label: `#${issue.number} ${issue.title}`, ref, where: { kind: 'goal', ref } };
}
