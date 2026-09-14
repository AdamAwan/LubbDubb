import type { CockpitView } from '../../view/viewModel.js';
import type { OpenPullRequest } from '../../types.js';
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
  /** What it has been waiting since, where the reading has one — drawn as the wait. */
  since?: string;
}

export interface Lead {
  key: LeadKey;
  /** The hue it wears, from {@link LEAD_TONE}. Null is a reading with nothing wrong and nobody's move. */
  tone: 'red' | 'amber' | 'blue' | null;
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

type LeadKey = 'prs' | 'queued' | 'reservoir' | 'quiet' | 'faults';

/**
 * What each lead's hue answers is *whose* it is, which is the rail's own question
 * and the rail's own palette. **Amber is the operator's own move** — an approval
 * is the one act nothing else on the deployment can do for them. Blue is the
 * fleet's supply, nothing wrong with it. Red is something wrong. And a lead that
 * is neither — a goal quietly working its plan — wears **no tone at all**, because
 * a colour on every row is a colour that says nothing.
 *
 * Total over {@link LeadKey}, like the rail's own tables, so a new lead is given a
 * hue deliberately rather than inheriting the last one's.
 */
const LEAD_TONE: Record<LeadKey, Lead['tone']> = {
  prs: 'amber',
  queued: 'blue',
  reservoir: 'blue',
  quiet: null,
  faults: 'red',
};

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

  /* `approved === false` and never `!== true`: the field is optional, so an
     unreported approval is an **unknown** rather than a missing one, and folding
     the two would have this lead claim every open pull request on a provider that
     does not report reviews. Minus the branches an agent is out on, for the
     reason the readying rows are not agents: the fleet is still writing those,
     and the harness raises a merge ask of its own when it wants one merged. */
  const unapproved = pullRequests
    .filter((pr) => pr.approved === false && !view.agentOnBranch.has(pr.branch))
    .sort(byWait);
  if (unapproved.length > 0) {
    out.push({
      key: 'prs',
      tone: LEAD_TONE.prs,
      count: unapproved.length,
      title:
        unapproved.length === 1 ? 'open pull request nobody has approved' : 'open pull requests nobody has approved',
      say: 'None of these is asking yet, and an approval is nobody’s but yours — which makes an unapproved pull request the likeliest thing on the deployment to be quietly waiting on you.',
      go: 'See them on Cards',
      where: { kind: 'cards' },
      items: unapproved.slice(0, NAMED).map((pr) => ({
        key: `pr:${pr.number}`,
        label: pr.title,
        ref: `pr:${pr.number}`,
        where: { kind: 'pr', number: pr.number },
        ...(pr.attention.reviewWaitingSince === undefined ? {} : { since: pr.attention.reviewWaitingSince }),
      })),
    });
  }

  /* Only where nobody is out. A queue behind a working fleet is the fleet
     working, and saying so on the surface that just said nothing needs you
     would be a lead pointing at normal. */
  const idle = view.live.length + view.readying.length + view.deskRuns.length === 0;
  if (idle && view.upNext.length > 0) {
    out.push({
      key: 'queued',
      tone: LEAD_TONE.queued,
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
      tone: LEAD_TONE.reservoir,
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
      tone: LEAD_TONE.quiet,
      count: quiet.length,
      title: quiet.length === 1 ? 'goal in flight with nobody on it' : 'goals in flight with nobody on them',
      say: 'No agent is out on these and nothing is asking about them. What happens next is on the goal’s own plan.',
      go: 'See them on Cards',
      where: { kind: 'cards' },
      items: quiet.slice(0, NAMED).map(goalItem),
    });
  }

  const faults = view.state.errors.length;
  if (faults > 0) {
    out.push({
      key: 'faults',
      tone: LEAD_TONE.faults,
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

/**
 * Longest-waiting first, which is the cut the lead is about: `reviewWaitingSince`
 * is the server's own reading of when a pull request went into somebody's court,
 * and the one that has been sitting a week is the one worth naming. A pull
 * request with no such reading has not been measured rather than waited no time,
 * so it sorts behind every measured one and on its number.
 */
function byWait(a: OpenPullRequest, b: OpenPullRequest): number {
  const at = since(a);
  const bt = since(b);
  if (at === bt) return a.number - b.number;
  /* Each arm on its own, because the subtraction cannot answer this: an
     unmeasured wait against a measured one gives ±Infinity and against another
     unmeasured one gives NaN, and both fall through a `isFinite` guard into the
     number order — which drew a three-day wait *below* two pull requests whose
     wait nobody had measured. */
  if (!Number.isFinite(at)) return 1;
  if (!Number.isFinite(bt)) return -1;
  return at - bt;
}

/** When a pull request went into somebody's court, or `Infinity` where nothing measured it. */
function since(pr: OpenPullRequest): number {
  const at = Date.parse(pr.attention.reviewWaitingSince ?? '');
  return Number.isFinite(at) ? at : Infinity;
}
