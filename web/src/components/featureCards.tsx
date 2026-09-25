import type { JSX } from 'react';
import type { CockpitActions } from '../cockpit/actions.js';
import type { FeatureSort } from '../cockpit/place.js';
import type { CockpitView } from '../view/viewModel.js';
import { featureHolds, type FeatureHolds } from '../view/featureHolds.js';
import type {
  FeatureBoardPayload,
  FeatureChildRow,
  FeatureChildStanding,
  FeatureCounts,
  FeatureLandingRow,
  FeatureReach,
  FeatureRollup,
} from '../types.js';
import { Panel } from './panel.js';
import { relAge } from './util.js';
import { FeatureAccount, FeatureMarks } from './featureAccount.js';
import { Bar, Brief, Reach, Standing, wantsYou } from './featureBrief.js';
import { Courts, Holds } from './featureHoldList.js';
import { held, Sequence } from './featureOrder.js';
import { Children, Delivered } from './featureStories.js';

type Card =
  | { kind: 'feature'; rollup: FeatureRollup; holds: FeatureHolds }
  | { kind: 'goal'; row: FeatureChildRow; landings: FeatureLandingRow[]; holds: FeatureHolds };

export function buildCards(board: FeatureBoardPayload, view: CockpitView): Card[] {
  const state = view.state;
  const cards: Card[] = board.features.map((rollup) => ({
    kind: 'feature',
    rollup,
    holds: featureHolds(
      state,
      view.needsYou,
      rollup.children.map((c) => c.number),
    ),
  }));
  for (const row of board.orphans?.children ?? []) {
    cards.push({
      kind: 'goal',
      row,
      landings: (board.orphans?.landings ?? []).filter((l) => l.goal === row.number),
      holds: featureHolds(state, view.needsYou, [row.number]),
    });
  }
  return cards;
}

export function orderCards(cards: Card[], sort: FeatureSort): Card[] {
  // A paused Feature sinks under every sort, including the ones that would
  // otherwise pull it back up: resting is the whole point of the button, and a
  // sort that outranks it hands the operator back the crowded board they paused
  // their way out of.
  const resting = (c: Card): number => (c.kind === 'feature' && c.rollup.paused !== null ? 1 : 0);
  // And a flagged one rises, for the mirror of that reason: the flag is a standing
  // instruction about what the fleet works next, so a board that took it and left the
  // card where it was would be the one surface disagreeing with the queue.
  // A pause still wins — it is the more deliberate of the two.
  const first = (c: Card): number => (c.kind === 'feature' && c.rollup.priority !== null ? 0 : 1);
  const counts = (c: Card): FeatureCounts => (c.kind === 'feature' ? c.rollup.counts : countOne(c.row.standing));
  const cost = (c: Card): number | null => (c.kind === 'feature' ? c.rollup.costUsd : c.row.costUsd);
  const latest = (c: Card): string | null =>
    c.kind === 'feature' ? c.rollup.lastLandingAt : (c.landings[0]?.at ?? null);
  const number = (c: Card): number => (c.kind === 'feature' ? c.rollup.number : c.row.number);
  const desc = (a: number, b: number): number => b - a;
  const by: Record<FeatureSort, (a: Card, b: Card) => number> = {
    'wants-you': (a, b) =>
      desc(a.holds.you.length, b.holds.you.length) ||
      desc(a.holds.fleet.length, b.holds.fleet.length) ||
      desc(counts(a).total, counts(b).total),
    moved: (a, b) => (latest(b) ?? '').localeCompare(latest(a) ?? ''),
    done: (a, b) => desc(share(counts(a)), share(counts(b))),
    spend: (a, b) => desc(cost(a) ?? -1, cost(b) ?? -1),
  };
  return [...cards].sort(
    (a, b) => resting(a) - resting(b) || first(a) - first(b) || by[sort](a, b) || number(a) - number(b),
  );
}

function share(counts: FeatureCounts): number {
  return counts.total === 0 ? 0 : counts.delivered / counts.total;
}

function countOne(standing: FeatureChildStanding): FeatureCounts {
  const counts: FeatureCounts = {
    delivered: 0,
    inFlight: 0,
    queued: 0,
    fellShort: 0,
    settled: 0,
    unwatched: 0,
    total: 1,
  };
  counts[standing] = 1;
  return counts;
}

export function BoardCard({
  card,
  rows,
  environments,
  view,
  actions,
  onAnswered,
}: {
  card: Card;
  rows: boolean;
  environments: readonly string[];
  view: CockpitView;
  actions: CockpitActions;
  onAnswered: () => void;
}): JSX.Element {
  if (card.kind === 'feature') {
    return rows ? (
      <FeatureRow card={card} actions={actions} onAnswered={onAnswered} />
    ) : (
      <FeatureCard card={card} view={view} actions={actions} onAnswered={onAnswered} />
    );
  }
  return rows ? (
    <GoalRow card={card} view={view} actions={actions} />
  ) : (
    <GoalCard card={card} environments={environments} view={view} actions={actions} />
  );
}

/**
 * One Feature on one line: what it is called, and how far along it is. Nothing else
 * from the brief survives here except the marks and the two counts that are asks —
 * everything that went is detail about a Feature the reader has not chosen yet.
 *
 * The headline is what makes the row an answer rather than an index entry, which is
 * why this shape only became possible once the summariser wrote one: a list of names
 * and bars says which Features exist and nothing about any of them.
 * → docs/spec/17-cockpit.md#the-board-at-length
 */
function FeatureRow({
  card,
  actions,
  onAnswered,
}: {
  card: Card & { kind: 'feature' };
  actions: CockpitActions;
  onAnswered: () => void;
}): JSX.Element {
  const { rollup: feature, holds } = card;
  const rested = feature.paused !== null;
  return (
    <Panel
      density="flush"
      className={`cn-fb-row${holds.you.length > 0 && !rested ? ' cn-fb-wants' : ''}${
        rested ? ' cn-fb-row-rested' : ''
      }`}
    >
      <i className={`cn-fb-hue f${feature.slot}`} aria-hidden="true" />
      <button
        type="button"
        className="cn-fb-row-open"
        onClick={() => actions.setFeatureQuery({ featureCard: feature.number })}
      >
        <span className="cn-fb-row-name">{feature.title}</span>
        {feature.summary?.headline !== null && feature.summary !== null && (
          <span className="cn-fb-row-said">{feature.summary.headline}</span>
        )}
      </button>
      <Bar counts={feature.counts} />
      <Courts holds={holds} yoursOnly />
      <FeatureMarks feature={feature} onChanged={onAnswered} />
    </Panel>
  );
}

export function FeatureCard({
  card,
  view,
  actions,
  onAnswered,
  page = false,
}: {
  card: Card & { kind: 'feature' };
  view: CockpitView;
  actions: CockpitActions;
  onAnswered: () => void;
  page?: boolean;
}): JSX.Element {
  const { rollup: feature, holds } = card;
  const rested = feature.paused !== null;
  // Both halves of the first column draw nothing of their own when they have
  // nothing — so with the account moved onto the brief, the column can be a
  // heading over empty space. It is the same rule the account's own fields keep:
  // an absent thing is absent, never an empty heading.
  const told = feature.sequence !== null || feature.briefing.delivered.length > 0;
  return (
    <Panel
      density="flush"
      className={`cn-fb-card${holds.you.length > 0 && !rested ? ' cn-fb-wants' : ''}${page ? ' cn-fb-open' : ''}${
        rested ? ' cn-fb-rested' : ''
      }`}
    >
      <Brief
        hue={<i className={`cn-fb-hue f${feature.slot}`} aria-hidden="true" />}
        title={feature.title}
        number={feature.number}
        state={feature.workItemState}
        holds={holds}
        onOpen={page ? null : () => actions.setFeatureQuery({ featureCard: feature.number })}
        actions={actions}
        headline={feature.summary?.headline ?? null}
        standing={<Standing feature={feature} view={view} />}
        account={<FeatureAccount summary={feature.summary} />}
        counts={feature.counts}
        reach={<Reach reach={feature.reach} />}
        costUsd={feature.costUsd}
        landings={feature.landings}
        now={view.now}
        pause={<FeatureMarks feature={feature} onChanged={onAnswered} />}
      >
        <FeatureCardNotes feature={feature} view={view} />
      </Brief>
      {page && (
        <div className={`cn-fb-detail${told ? '' : ' cn-fb-detail-2'}`}>
          {told && (
            <div className="cn-fb-col">
              <h4 className="cn-fb-colhead">Its order, and what landed</h4>
              <Sequence feature={feature} view={view} onAnswered={onAnswered} />
              {held(feature) === null && (
                <Delivered
                  rows={feature.briefing.delivered}
                  total={feature.briefing.deliveredTotal}
                  now={view.now}
                  actions={actions}
                />
              )}
            </div>
          )}
          <div className="cn-fb-col">
            <h4 className="cn-fb-colhead">In the way · grouped by who clears it</h4>
            <Holds holds={holds} stories={feature.children} now={view.now} actions={actions} />
          </div>
          <div className="cn-fb-col">
            <Children
              rows={feature.children}
              total={feature.counts.total}
              view={view}
              actions={actions}
              sequence={held(feature)}
            />
          </div>
        </div>
      )}
    </Panel>
  );
}

function FeatureCardNotes({ feature, view }: { feature: FeatureRollup; view: CockpitView }): JSX.Element {
  const attention = wantsYou(feature, view);
  const rested = feature.paused !== null;
  return (
    <>
      {feature.paused !== null && (
        <p className="cn-fb-restednote">
          Paused {relAge(feature.paused.since, view.now)} — nothing under it is picked up. Its watch tags are untouched,
          so resuming puts the work back exactly as you left it.
        </p>
      )}
      {attention !== null && !rested && <p className="cn-fb-attn">{attention}</p>}
    </>
  );
}

/**
 * A promoted goal's row. Same shape as a Feature's, so a board in rows is one list
 * rather than a list with full cards standing up in it — but dashed and with the
 * delivery or shortfall quotation where a Feature's headline goes, since a story has
 * no account of its own and the verdict on it is the nearest thing it has.
 */
function GoalRow({
  card,
  view,
  actions,
}: {
  card: Card & { kind: 'goal' };
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  const { row, holds } = card;
  const issue = view.state.world.issues.find((i) => i.number === row.number);
  const said = issue?.delivery?.summary ?? issue?.shortfall?.summary ?? null;
  return (
    <Panel density="flush" className={`cn-fb-row cn-fb-promoted${holds.you.length > 0 ? ' cn-fb-wants' : ''}`}>
      <i className="cn-fb-hue cn-fb-hue-none" aria-hidden="true" />
      <button
        type="button"
        className="cn-fb-row-open"
        onClick={() => actions.setFeatureQuery({ featureCard: row.number })}
      >
        <span className="cn-fb-row-name">{row.title}</span>
        {said === null ? (
          <span className="cn-fb-row-said cn-fb-row-none">no Feature</span>
        ) : (
          <span className="cn-fb-row-said">“{said}”</span>
        )}
      </button>
      <Bar counts={countOne(row.standing)} />
      <Courts holds={holds} yoursOnly />
    </Panel>
  );
}

export function GoalCard({
  card,
  environments,
  view,
  actions,
  page = false,
}: {
  card: Card & { kind: 'goal' };
  environments: readonly string[];
  view: CockpitView;
  actions: CockpitActions;
  page?: boolean;
}): JSX.Element {
  const { row, holds, landings } = card;
  const issue = view.state.world.issues.find((i) => i.number === row.number);
  const reach = goalReach(view, row.number, environments);
  return (
    <Panel
      density="flush"
      className={`cn-fb-card cn-fb-promoted${holds.you.length > 0 ? ' cn-fb-wants' : ''}${page ? ' cn-fb-open' : ''}`}
    >
      <Brief
        hue={<i className="cn-fb-hue cn-fb-hue-none" aria-hidden="true" />}
        title={row.title}
        number={row.number}
        state={row.issueType === null ? 'no Feature' : `${row.issueType} · no Feature`}
        holds={holds}
        onOpen={page ? null : () => actions.setFeatureQuery({ featureCard: row.number })}
        actions={actions}
        standing={
          <p className="cn-fb-noline">
            No account — the fleet summarises Features, not stories.
            {issue?.delivery && (
              <>
                {' '}
                <span className="cn-fb-said">“{issue.delivery.summary}”</span>{' '}
                <span className="cn-fb-quiet">
                  — {issue.delivery.by}, {relAge(issue.delivery.decidedAt, view.now)}
                </span>
              </>
            )}
            {!issue?.delivery && issue?.shortfall && (
              <>
                {' '}
                <span className="cn-fb-said">“{issue.shortfall.summary}”</span>{' '}
                <span className="cn-fb-quiet">
                  — {issue.shortfall.by}, {relAge(issue.shortfall.decidedAt, view.now)}
                </span>
              </>
            )}
          </p>
        }
        counts={countOne(row.standing)}
        reach={reach === null ? null : <Reach reach={reach} />}
        costUsd={row.costUsd}
        landings={landings}
        now={view.now}
      />
      {page && (
        <div className="cn-fb-detail cn-fb-detail-2">
          <div className="cn-fb-col">
            <h4 className="cn-fb-colhead">In the way · grouped by who clears it</h4>
            <Holds holds={holds} stories={[row]} now={view.now} actions={actions} />
          </div>
          <div className="cn-fb-col">
            <Children rows={[row]} total={1} view={view} actions={actions} sequence={null} />
          </div>
        </div>
      )}
    </Panel>
  );
}

/* The board's columns are bands, so a column named by a declared group is answered from the
   group's own roll-up — the one the server computed off these same rows. Looked up among the
   environments instead it would find nothing and draw every grouped place as `absent`.
   → docs/spec/24-environments.md#groups */
function goalReach(view: CockpitView, goal: number, environments: readonly string[]): FeatureReach[] | null {
  if (environments.length === 0) return null;
  const row = view.state.environmentReach.find((r) => r.goalRef === `issue:${goal}`);
  return environments.map((environment) => {
    const found =
      row?.groups.find((g) => g.group === environment) ?? row?.environments.find((e) => e.environment === environment);
    return {
      environment,
      status: found?.status ?? 'absent',
      goals: found !== undefined && found.status === 'reached' ? 1 : 0,
      total: found === undefined ? 0 : 1,
    };
  });
}
