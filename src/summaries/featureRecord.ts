import { isContainerType } from '../issueRelations.js';
import { allGoalReach } from '../environments/reach.js';
import { isWatched } from '../watchLabels.js';
import type { Store } from '../store/store.js';
import type { Escalation, GoalEnvironmentReach } from '../types.js';
import type { EnvironmentConfig } from '../environments/policy.js';
import { featureStandingKey, type FeatureChildStandingFacts } from './featureSummary.js';

// → docs/spec/14-persistence.md

interface FeatureRecord {
  number: number;
  title: string;
  key: string;
  children: FeatureChildRecord[];
}

interface FeatureChildRecord extends FeatureChildStandingFacts {
  title: string;
  watched: boolean;
  delivered: string | null;
  shortfall: { summary: string; cause: string | null } | null;
  questions: { prompt: string; since: string }[];
}

export interface FeatureBoardFacts {
  containerTypes: readonly string[] | undefined;
  watchLabel: string;
  environments: EnvironmentConfig[];
}

export function featureRecords(store: Store, opts: FeatureBoardFacts): FeatureRecord[] {
  const items = store.tickets.listTrackerItems();
  const deliveries = new Map(store.verdicts.listDeliveries().map((d) => [d.originRef, d]));
  const shortfalls = new Map(store.verdicts.listShortfalls().map((s) => [s.originRef, s]));
  const questions = openQuestionsByGoal(store.escalations.listEscalations());
  const running = new Map(
    store.floor
      .listIssueRuns()
      .filter((r) => r.completedAt === null && r.dismissedAt === null)
      .map((r) => [r.issueNumber, r.startedAt]),
  );
  const landings = store.environments.listGoalLandings();
  const landedAt = new Map<string, string>();
  for (const landing of landings) {
    const seen = landedAt.get(landing.goalRef);
    if (seen === undefined || landing.recordedAt > seen) landedAt.set(landing.goalRef, landing.recordedAt);
  }
  const groups = new Map<number, { title: string; children: FeatureChildRecord[] }>();
  for (const item of items) {
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

export function featureReach(store: Store, opts: FeatureBoardFacts): Map<string, GoalEnvironmentReach[]> {
  return new Map(
    allGoalReach({
      landings: store.environments.listGoalLandings(),
      readings: store.environments.listEnvironmentReach(),
      nodes: store.graph.listWorkNodes(),
      landed: store.environments.landedPrs(),
      plans: store.plans.listPlans(),
      parts: store.plans.listAllPlanParts(),
      environments: opts.environments,
    }).map((r) => [r.goalRef, r.environments]),
  );
}
