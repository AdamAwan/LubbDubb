import { isContainerType } from '../issueRelations.js';
import { allGoalReach } from '../environments/reach.js';
import { isWatched } from '../watchLabels.js';
import type { Store } from '../store/store.js';
import type { Escalation, GoalEnvironmentReach } from '../types.js';
import type { EnvironmentConfig } from '../environments/policy.js';
import { featureStandingKey, type FeatureChildStandingFacts } from './featureSummary.js';

/**
 * Everything the harness knows about one Feature, in the one shape anything that
 * has to account for a Feature needs.
 *
 * **There is one assembly of this and there must stay one** — `goalRecord`'s rule,
 * one tier up, and for its reason. Two readers want it and each wants a different
 * *rendering*: rule `feature-summary` compares {@link FeatureRecord.key} to decide
 * whether to dispatch, and the dispatched agent is handed
 * {@link renderFeatureDossier} of the same record. What those two must never
 * disagree about is which children a Feature has and where each of them stands —
 * a second gather is a second answer to that, free to drift silently, and the
 * symptom would be an agent re-summarising a Feature every pulse or never again.
 *
 * It is **not** the feature board. The board is a lens for the cockpit and this is
 * dispatch material; they read overlapping rows and neither quotes the other,
 * because the board's readings are shaped for a card (bounded lists, a bar, a hue)
 * and these are shaped for a paragraph. What they do share is the discipline: every
 * sentence in the dossier was written by somebody, and nothing here composes one.
 */
interface FeatureRecord {
  number: number;
  title: string;
  /** The digest rule `feature-summary` compares against the summary on file. */
  key: string;
  children: FeatureChildRecord[];
}

/** One goal under a Feature, with everything said about it. */
interface FeatureChildRecord extends FeatureChildStandingFacts {
  title: string;
  /** False for an item carrying no watch label — one the fleet has never looked at. */
  watched: boolean;
  /** The delivery verdict's own sentence, quoted. Null where none stands. */
  delivered: string | null;
  /** The shortfall verdict's own sentence, and which of the three failures it named. */
  shortfall: { summary: string; cause: string | null } | null;
  /** Open escalations naming this goal — an agent stopped, waiting on a person. */
  questions: { prompt: string; since: string }[];
}

/**
 * The config a Feature gather needs and the store does not hold. One object rather
 * than three arguments, because they arrive together from one place: the
 * `featureBoardOn` conjunction in `src/system.ts`, which is also what decides
 * whether any of this happens at all.
 */
export interface FeatureBoardFacts {
  containerTypes: readonly string[] | undefined;
  watchLabel: string;
  environments: EnvironmentConfig[];
}

/**
 * Gather every Feature the mirror knows about.
 *
 * Whole-mirror rather than per-Feature, for `listScratchPadSummaries`' reason: the
 * caller that dispatches wants every Feature's key on one pulse, and a per-Feature
 * read would scale that pulse with the number of Features to say nothing more.
 *
 * **Read only where the deployment has a feature board.** This is several
 * full-table reads, and on a tracker with no hierarchy every one of them answers
 * nothing — see `featureBoardOn`, which both callers gate on.
 */
export function featureRecords(store: Store, opts: FeatureBoardFacts): FeatureRecord[] {
  const items = store.listTrackerItems();
  const deliveries = new Map(store.listDeliveries().map((d) => [d.originRef, d]));
  const shortfalls = new Map(store.listShortfalls().map((s) => [s.originRef, s]));
  const questions = openQuestionsByGoal(store.listEscalations());
  const running = new Map(
    store
      .listIssueRuns()
      .filter((r) => r.completedAt === null && r.dismissedAt === null)
      .map((r) => [r.issueNumber, r.startedAt]),
  );
  const landings = store.listGoalLandings();
  const landedAt = new Map<string, string>();
  for (const landing of landings) {
    const seen = landedAt.get(landing.goalRef);
    if (seen === undefined || landing.recordedAt > seen) landedAt.set(landing.goalRef, landing.recordedAt);
  }
  const groups = new Map<number, { title: string; children: FeatureChildRecord[] }>();
  for (const item of items) {
    // A container is never its own child — `buildFeatureBoard`'s rule, and here it
    // matters twice: an Epic counted as a story would put a whole Feature's worth
    // of work in front of the agent as one line.
    if (isContainerType(item.issueType, opts.containerTypes)) continue;
    if (!item.parent) continue;
    const goalRef = `issue:${item.number}`;
    const shortfall = shortfalls.get(goalRef);
    const child: FeatureChildRecord = {
      number: item.number,
      title: item.title,
      state: item.state,
      workItemState: item.workItemState,
      watched: isWatched(item.labels, opts.watchLabel),
      deliveredAt: deliveries.get(goalRef)?.decidedAt ?? null,
      shortfallAt: shortfall?.decidedAt ?? null,
      runningSince: running.get(item.number) ?? null,
      landedAt: landedAt.get(goalRef) ?? null,
      delivered: deliveries.get(goalRef)?.summary ?? null,
      shortfall: shortfall ? { summary: shortfall.summary, cause: shortfall.cause } : null,
      questions: questions.get(item.number) ?? [],
    };
    const seen = groups.get(item.parent.number);
    if (seen) seen.children.push(child);
    else groups.set(item.parent.number, { title: item.parent.title, children: [child] });
  }

  return [...groups].map(([number, group]) => ({
    number,
    title: group.title,
    key: featureStandingKey(group.children),
    children: group.children.sort((a, b) => a.number - b.number),
  }));
}

/**
 * Open escalations that name a goal, keyed by its issue number.
 *
 * Only where the escalation names the goal itself. One raised against a pull
 * request names no goal and is attributed to no Feature rather than to a guess —
 * `briefingFor`'s rule, and the same reasoning: a question put under the wrong
 * Feature is worse than one put under none.
 */
function openQuestionsByGoal(escalations: readonly Escalation[]): Map<number, { prompt: string; since: string }[]> {
  const out = new Map<number, { prompt: string; since: string }[]>();
  for (const ask of escalations) {
    if (ask.status !== 'open') continue;
    const match = /^issue:(\d+)$/.exec(ask.context.originRef ?? '');
    if (!match) continue;
    const number = Number(match[1]);
    const list = out.get(number) ?? [];
    list.push({ prompt: ask.prompt, since: ask.createdAt });
    out.set(number, list);
  }
  return out;
}

/**
 * What a feature-summary agent is handed beyond its prompt.
 *
 * Markdown, and **appended** to the rendered prompt rather than interpolated into
 * it — the rule every block the executor adds follows, and here it is the whole of
 * what the agent can say: a summariser has no worktree and no world of its own, so
 * an operator's template override that had never heard of a `{children}` token
 * would silently produce an agent asked to summarise a Feature it cannot see.
 *
 * Every line is a quotation or a fact. The verdicts are their authors' own
 * sentences, the questions are the escalations' own prompts, and the standing
 * words are the tracker's — this renders them and judges none of them, which is
 * the same discipline the board's briefing is held to and for the same reason: the
 * agent is being asked to write the sentence, and prose handed to it as evidence
 * would be a verdict it merely re-voiced.
 */
export function renderFeatureDossier(
  record: FeatureRecord,
  reach: ReadonlyMap<string, GoalEnvironmentReach[]>,
  previous: string | null,
): string {
  const lines: string[] = [`## Feature #${record.number} — ${record.title}`, ''];
  lines.push(`${record.children.length} item(s) hang off it.`, '');

  for (const child of record.children) {
    const state = [child.state, child.workItemState].filter(Boolean).join(' / ');
    lines.push(`### #${child.number} — ${child.title}`);
    lines.push(`- State: ${state}${child.watched ? '' : ' — **not watched**: no agent has ever been on it'}`);
    if (child.runningSince) lines.push(`- An agent has been on this since ${child.runningSince}`);
    if (child.delivered) lines.push(`- Delivered: "${child.delivered}"`);
    if (child.shortfall) {
      const cause = child.shortfall.cause ? ` (${child.shortfall.cause})` : '';
      lines.push(`- Fell short${cause}: "${child.shortfall.summary}"`);
    }
    for (const ask of child.questions) lines.push(`- Waiting on a person since ${ask.since}: "${ask.prompt}"`);
    if (child.landedAt) lines.push(`- Last landed a commit at ${child.landedAt}`);
    for (const env of reach.get(`issue:${child.number}`) ?? []) {
      lines.push(`- ${env.environment}: ${env.status} (${env.landed}/${env.total} landings)`);
    }
    lines.push('');
  }

  if (previous) {
    lines.push(
      '## The summary on file',
      '',
      'Something under this Feature has moved since this was written. Revise it — keep what is still true',
      'rather than restating it differently, and say what the movement changed.',
      '',
      previous,
    );
  }
  return lines.join('\n');
}

/**
 * Where each goal's commits have got to, per environment — the one reading a
 * summary needs that is not in {@link featureRecords}.
 *
 * **Deliberately not part of the gather.** `featureRecords` runs on every pulse to
 * answer one question ("has anything moved"), and reach answers none of it: the
 * digest is built from standings, verdicts and landings, and an environment probe
 * changes none of them. Folding it in would put `allGoalReach` and the five
 * full-table reads under it on the pulse to produce a value nothing compares.
 * This is read once, when a summariser is actually dispatched.
 *
 * `allGoalReach` is the same fold the board and the goal page use, never a second
 * one — which is what keeps `unknown` from collapsing into `absent` here, the
 * whole reason that verdict is three-valued. → `docs/spec/24-environments.md`
 */
export function featureReach(store: Store, opts: FeatureBoardFacts): Map<string, GoalEnvironmentReach[]> {
  return new Map(
    allGoalReach({
      landings: store.listGoalLandings(),
      readings: store.listEnvironmentReach(),
      nodes: store.listWorkNodes(),
      landed: store.landedPrs(),
      plans: store.listPlans(),
      parts: store.listAllPlanParts(),
      environments: opts.environments,
    }).map((r) => [r.goalRef, r.environments]),
  );
}
