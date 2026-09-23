import { Fragment, useCallback, useEffect, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { api } from '../api.js';
import type { CockpitActions } from '../cockpit/actions.js';
import {
  FEATURE_MODES,
  FEATURE_SORTS,
  type FeatureDensity,
  type FeatureMode,
  type FeaturePrFilter,
  type FeatureSort,
} from '../cockpit/place.js';
import type { CockpitView } from '../view/viewModel.js';
import { featureHolds, goalPullRequests } from '../view/featureHolds.js';
import type { FeatureHold, FeatureHolds, FeaturePresence, GoalPullRequest } from '../view/featureHolds.js';
import { FeatureFocus } from './FeatureFocus.js';
import { FeatureSummariesAd } from './FeatureSummariesAd.js';
import { Ref, RefLinksExtended } from './refs.js';
import { AsyncButton } from './AsyncButton.js';
import { AgentOnIt } from './AgentOnIt.js';
import { Button } from './button.js';
import { CiMark } from './CiMark.js';
import { CommentsMark } from './CommentsMark.js';
import { ReviewMark } from './ReviewMark.js';
import { heldByAccepting, waitsOn, wavesOf } from '../view/sequence.js';
import { fmtUsd, relAge } from './util.js';
import type {
  FeatureBoardPayload,
  FeatureChildRow,
  FeatureChildStanding,
  FeatureCounts,
  FeatureLandingRow,
  FeatureReach,
  FeatureReportRow,
  FeatureRollup,
  FeatureSequence,
  GoalReachStatus,
  OpenPullRequest,
} from '../types.js';
import { HeadRow, Panel } from './panel.js';
import { DesktopLink } from './DesktopLink.js';
import { Tag, type TagTone } from './tag.js';
import { FeatureAccount, FeatureMarks } from './featureAccount.js';
import { Crumb, type CrumbStep } from '../console/Crumb.js';

// → docs/spec/17-cockpit.md

function useFeatureBoard(): { board: FeatureBoardPayload | null; failed: boolean; read: () => Promise<void> } {
  const [board, setBoard] = useState<FeatureBoardPayload | null>(null);
  const [failed, setFailed] = useState(false);

  const read = useCallback(async () => {
    try {
      setBoard(await api.getFeatures());
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void read();
  }, [read]);

  return { board, failed, read };
}

export function FeatureBoard({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const { board, failed, read } = useFeatureBoard();

  if (failed) return <p className="muted">This deployment has no feature board.</p>;
  if (board === null) return <p className="muted">Reading the tracker’s hierarchy…</p>;

  /* A card opened is a page of its own, on `?card=` — the board draws briefs and
     nothing more. → docs/spec/17-cockpit.md#the-feature-page */
  if (view.featureMode === 'board' && view.featureCard !== null) {
    return (
      <FeatureDetail
        number={view.featureCard}
        board={board}
        back={{ label: 'Features', go: () => actions.setFeatureQuery({ featureCard: null }) }}
        view={view}
        actions={actions}
        onAnswered={() => void read()}
      />
    );
  }

  const { features, orphans, unresolved } = board;
  if (features.length === 0 && orphans === null) {
    return (
      <p className="muted">
        {board.backfilling
          ? 'Still reading the tracker — the board fills as the first sweep lands.'
          : 'Nothing in the tracker hangs off a container yet.'}
      </p>
    );
  }

  const cards = orderCards(buildCards(board, view), view.featureSort);
  const rows = drawsRows(view.featureDensity, cards.length);
  const promoted = orphans?.counts.total ?? 0;
  const paused = features.filter((f) => f.paused !== null).length;

  return (
    <RefLinksExtended refUrls={board.refUrls}>
      <div className="cn-fb">
        <div className="cn-fb-head">
          <h2>Features</h2>
          <span className="cn-fb-quiet">
            {features.length} {features.length === 1 ? 'feature' : 'features'}
            {/* A pause withholds work, so it is counted out loud. A rested card that
                nothing says is resting is the silent version of this button. */}
            {paused > 0 && ` · ${paused} paused`}
            {promoted > 0 && ` · ${promoted} ${promoted === 1 ? 'story' : 'stories'} with no Feature`}
            {/* The orphan bucket's money, said once about the page: this much was spent
                under no Feature, which is also the sentence that says every roll-up
                below understates its own. */}
            {orphans !== null && orphans.costUsd !== null && ` · ${fmtUsd(orphans.costUsd)} spent under no Feature`}
            {board.backfilling ? ' · still filling' : ''}
          </span>
          <ModeControl mode={view.featureMode} actions={actions} />
          {view.featureMode === 'board' && (
            <>
              <DensityControl density={view.featureDensity} cards={cards.length} actions={actions} />
              <SortControl sort={view.featureSort} actions={actions} />
            </>
          )}
        </div>

        {!view.state.config.featureSummaries && <FeatureSummariesAd actions={actions} onTurnedOn={() => void read()} />}

        {view.featureMode === 'focus' && (
          <FeatureFocus board={board} view={view} actions={actions} onAnswered={() => void read()} />
        )}

        {view.featureMode === 'board' &&
          cards.map((card) =>
            card.kind === 'feature' ? (
              rows ? (
                <FeatureRow
                  key={`f:${card.rollup.number}`}
                  card={card}
                  actions={actions}
                  onAnswered={() => void read()}
                />
              ) : (
                <FeatureCard
                  key={`f:${card.rollup.number}`}
                  card={card}
                  view={view}
                  actions={actions}
                  onAnswered={() => void read()}
                />
              )
            ) : rows ? (
              <GoalRow key={`g:${card.row.number}`} card={card} view={view} actions={actions} />
            ) : (
              <GoalCard
                key={`g:${card.row.number}`}
                card={card}
                environments={board.environments}
                view={view}
                actions={actions}
              />
            ),
          )}

        {view.featureMode === 'board' && unresolved > 0 && (
          <p className="cn-fb-quiet cn-fb-unresolved">
            {unresolved} {unresolved === 1 ? 'item’s' : 'items’'} parent link could not be read, so{' '}
            {unresolved === 1 ? 'it is' : 'they are'} counted nowhere above.
          </p>
        )}
      </div>
    </RefLinksExtended>
  );
}

/**
 * A Feature's own page, for a surface that is not the board — the goal page of an
 * item that is a container, which the fleet never works and so has nothing of its own
 * to draw. → docs/spec/17-cockpit.md#the-feature-page
 */
export function FeaturePage({
  number,
  back,
  view,
  actions,
}: {
  number: number;
  back: CrumbStep;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  const { board, failed, read } = useFeatureBoard();
  if (failed) return <p className="muted">This deployment has no feature board.</p>;
  if (board === null) return <p className="muted">Reading the tracker’s hierarchy…</p>;
  return (
    <FeatureDetail
      number={number}
      board={board}
      back={back}
      view={view}
      actions={actions}
      onAnswered={() => void read()}
    />
  );
}

function FeatureDetail({
  number,
  board,
  back,
  view,
  actions,
  onAnswered,
}: {
  number: number;
  board: FeatureBoardPayload;
  back: CrumbStep;
  view: CockpitView;
  actions: CockpitActions;
  onAnswered: () => void;
}): JSX.Element {
  const card = buildCards(board, view).find((c) => (c.kind === 'feature' ? c.rollup.number : c.row.number) === number);
  const title = card === undefined ? null : card.kind === 'feature' ? card.rollup.title : card.row.title;
  return (
    <RefLinksExtended refUrls={board.refUrls}>
      <Crumb trail={[back]} here={title === null ? `#${number}` : `#${number} ${title}`} />
      <div className="cn-fb cn-fb-page">
        {card === undefined ? (
          <p className="muted">
            #{number} is not on the feature board — it is neither a Feature nor a story that hangs off none.
          </p>
        ) : card.kind === 'feature' ? (
          <FeatureCard card={card} view={view} actions={actions} onAnswered={onAnswered} page />
        ) : (
          <GoalCard card={card} environments={board.environments} view={view} actions={actions} page />
        )}
      </div>
    </RefLinksExtended>
  );
}

type Card =
  | { kind: 'feature'; rollup: FeatureRollup; holds: FeatureHolds }
  | { kind: 'goal'; row: FeatureChildRow; landings: FeatureLandingRow[]; holds: FeatureHolds };

function buildCards(board: FeatureBoardPayload, view: CockpitView): Card[] {
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

function ModeControl({ mode, actions }: { mode: FeatureMode; actions: CockpitActions }): JSX.Element {
  return (
    <span className="cn-fb-mode">
      {FEATURE_MODES.map((m) => (
        <button
          key={m}
          type="button"
          aria-pressed={m === mode}
          className={m === mode ? 'cn-fb-mode-on' : ''}
          title={
            m === 'board'
              ? 'Every Feature at once — how the work is going'
              : 'One Feature at a time, with its asks in front — what to do about it'
          }
          onClick={() => actions.setFeatureMode(m)}
        >
          {m === 'board' ? 'Board' : 'Focus'}
        </button>
      ))}
    </span>
  );
}

/**
 * Full cards while the board is short enough to read down, one line each past that.
 * Eight is where a reader stops holding the list in their head: a brief runs about a
 * viewport-third, so eight is already three screens of scrolling to find a name.
 *
 * The threshold counts **every** card, promoted goals included, since what makes the
 * page long is its length and not what the rows are. → docs/spec/17-cockpit.md#the-board-at-length
 */
export const BRIEFS_AT_MOST = 8;

export function drawsRows(density: FeatureDensity, cards: number): boolean {
  if (density === 'brief') return false;
  if (density === 'rows') return true;
  return cards > BRIEFS_AT_MOST;
}

function DensityControl({
  density,
  cards,
  actions,
}: {
  density: FeatureDensity;
  cards: number;
  actions: CockpitActions;
}): JSX.Element {
  const rows = drawsRows(density, cards);
  return (
    <span className="cn-fb-density" role="group" aria-label="How much of each Feature">
      <Button
        size="small"
        ghost={rows}
        aria-pressed={!rows}
        title="Every Feature in full — its account, its progress and where it has reached"
        onClick={() => actions.setFeatureQuery({ featureDensity: 'brief' })}
      >
        Full
      </Button>
      <Button
        size="small"
        ghost={!rows}
        aria-pressed={rows}
        title="One line each — the name and how far along it is, with the card you open still drawn in full"
        onClick={() => actions.setFeatureQuery({ featureDensity: 'rows' })}
      >
        Rows
      </Button>
    </span>
  );
}

function orderCards(cards: Card[], sort: FeatureSort): Card[] {
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

const SORT_WORD: Record<FeatureSort, string> = {
  'wants-you': 'Wants you',
  moved: 'Moved',
  done: 'Done',
  spend: 'Spend',
};

function SortControl({ sort, actions }: { sort: FeatureSort; actions: CockpitActions }): JSX.Element {
  return (
    <span className="cn-fb-sort" role="group" aria-label="Order">
      <span className="cn-fb-quiet">Order</span>
      {FEATURE_SORTS.map((s) => (
        <Button
          key={s}
          size="small"
          ghost={s !== sort}
          aria-pressed={s === sort}
          onClick={() => actions.setFeatureQuery({ featureSort: s })}
        >
          {SORT_WORD[s]}
        </Button>
      ))}
    </span>
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

function FeatureCard({
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
  const attention = wantsYou(feature, view);
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
        {feature.paused !== null && (
          <p className="cn-fb-restednote">
            Paused {relAge(feature.paused.since, view.now)} — nothing under it is picked up. Its watch tags are
            untouched, so resuming puts the work back exactly as you left it.
          </p>
        )}
        {attention !== null && !rested && <p className="cn-fb-attn">{attention}</p>}
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

function GoalCard({
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

function Brief({
  hue,
  title,
  number,
  state,
  holds,
  onOpen,
  actions,
  headline,
  standing,
  account,
  counts,
  reach,
  costUsd,
  landings,
  now,
  pause,
  children,
}: {
  hue: ReactNode;
  title: string;
  number: number;
  state: string | null;
  holds: FeatureHolds;
  /** Opens the Feature's page; null on the page itself, where the name is a heading. */
  onOpen: (() => void) | null;
  actions: CockpitActions;
  headline?: string | null;
  standing: ReactNode;
  account?: ReactNode;
  counts: FeatureCounts;
  reach: ReactNode;
  costUsd: number | null;
  landings: readonly FeatureLandingRow[];
  now: number;
  pause?: ReactNode;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div className="cn-fb-brief">
      {hue}
      <div className="cn-fb-brief-body">
        <div className="cn-fb-top">
          {onOpen === null ? (
            <h3>{title}</h3>
          ) : (
            <button type="button" className="cn-fb-toggle" onClick={onOpen}>
              <h3>{title}</h3>
            </button>
          )}
          <span className="cn-refs">
            <Ref to={`issue:${number}`} />
          </span>
          {state !== null && <Tag>{state}</Tag>}
          <Presence agents={holds.agents} actions={actions} />
          <Courts holds={holds} />
          {pause}
        </div>
        {headline !== null && headline !== undefined && <p className="cn-fb-headline">{headline}</p>}
        {standing}
        {account}
        <div className="cn-fb-grid">
          <div className="cn-fb-progress">
            <Bar counts={counts} />
          </div>
          <HeadRow className="cn-fb-where">
            {reach}
            <span className="cn-fb-reading">{money(costUsd)}</span>
          </HeadRow>
          <Movement landings={landings} now={now} />
        </div>
        {children}
      </div>
    </div>
  );
}

function Courts({ holds, yoursOnly }: { holds: FeatureHolds; yoursOnly?: boolean }): JSX.Element | null {
  const you = holds.you.length;
  // A row has one line to say what a Feature is, and the fleet's and the world's
  // counts are the two things on the brief that ask nothing of anybody. They are the
  // first to go where the space they take is the headline's.
  const fleet = yoursOnly === true ? 0 : holds.fleet.length;
  const world = yoursOnly === true ? 0 : holds.world.length;
  if (you + fleet + world === 0) return null;
  return (
    <span className="cn-fb-courts">
      {you > 0 && (
        <Tag tone={holds.you.some(isRed) ? 'red' : 'amber'} fill>
          you {you}
        </Tag>
      )}
      {fleet > 0 && <span className="cn-fb-court-quiet">fleet {fleet}</span>}
      {world > 0 && <span className="cn-fb-court-quiet">world {world}</span>}
    </span>
  );
}

function Presence({
  agents,
  actions,
}: {
  agents: readonly FeaturePresence[];
  actions: CockpitActions;
}): JSX.Element | null {
  if (agents.length === 0) return null;
  return (
    <span className="cn-fb-presence">
      {agents.map((a) => (
        <AgentOnIt
          key={a.agentId}
          agentId={a.agentId}
          note={a.note}
          holding={a.state === 'holding'}
          actions={actions}
        />
      ))}
    </span>
  );
}

function Standing({ feature, view }: { feature: FeatureRollup; view: CockpitView }): JSX.Element | null {
  const summary = feature.summary;
  if (summary === null) {
    if (!view.state.config.featureSummaries) return null;
    return (
      <p className="cn-fb-noline">
        {feature.counts.inFlight + feature.counts.delivered + feature.counts.fellShort + feature.counts.settled === 0
          ? 'Not yet summarised — nothing under it has moved since it was linked.'
          : 'Not yet summarised.'}
      </p>
    );
  }
  const moved = feature.standingKey !== '' && feature.standingKey !== summary.standingKey;
  const rewriting = view.state.tasks.some(
    (t) => t.originRef === `issue:${feature.number}:summary` && (t.status === 'queued' || t.status === 'running'),
  );
  return (
    <>
      <p className="cn-fb-standing">{summary.standing}</p>
      <p className="cn-fb-quiet cn-fb-stamp">
        written {relAge(summary.updatedAt, view.now)}
        {moved && (
          <>
            {' · '}
            <span className="cn-fb-moved">moved since this was written</span>
          </>
        )}
        {rewriting && ' · being rewritten'}
      </p>
    </>
  );
}

const MOVEMENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function Movement({ landings, now }: { landings: readonly FeatureLandingRow[]; now: number }): JSX.Element {
  const newest = landings[0];
  if (newest === undefined) {
    return (
      <span className="cn-fb-move">
        <i className="cn-fb-never">never landed</i>
      </span>
    );
  }
  const recent = landings.filter((l) => now - Date.parse(l.at) <= MOVEMENT_WINDOW_MS).length;
  return (
    <span className="cn-fb-move">
      {recent} landed in the last 7 days · last {relAge(newest.at, now)}
    </span>
  );
}

function Delivered({
  rows,
  total,
  now,
  actions,
}: {
  rows: readonly FeatureReportRow[];
  total: number;
  now: number;
  actions: CockpitActions;
}): JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <section className="cn-fb-brief-list">
      <h4>
        Delivered <span className="cn-fb-quiet">{total > rows.length ? `${rows.length} of ${total}` : total}</span>
      </h4>
      <ul>
        {rows.map((row) => (
          <li key={row.number}>
            <GoalLink number={row.number} title={row.title} actions={actions} />
            <span className="cn-fb-said">“{row.summary}”</span>
            <span className="cn-fb-quiet">
              — {row.by}, {relAge(row.at, now)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const COURT_WORD = { you: 'you', fleet: 'fleet', world: 'world' } as const;

const RED_KINDS: ReadonlySet<string> = new Set(['escalation', 'permission', 'recovery']);

function isRed(hold: FeatureHold): boolean {
  return hold.tone === 'red' || RED_KINDS.has(hold.kind);
}

function Holds({
  holds,
  stories,
  now,
  actions,
}: {
  holds: FeatureHolds;
  stories: readonly { number: number; title: string }[];
  now: number;
  actions: CockpitActions;
}): JSX.Element {
  const groups: { court: keyof typeof COURT_WORD; rows: FeatureHold[]; empty: string }[] = [
    { court: 'you', rows: holds.you, empty: 'Nothing here is waiting on you.' },
    { court: 'fleet', rows: holds.fleet, empty: '' },
    { court: 'world', rows: holds.world, empty: '' },
  ];
  const any = groups.some((g) => g.rows.length > 0);
  if (!any) return <p className="cn-fb-quiet cn-fb-empty">Nothing is in the way.</p>;
  return (
    <div className="cn-fb-holds">
      {groups.map(({ court, rows, empty }) =>
        rows.length === 0 ? (
          empty === '' ? null : (
            <p key={court} className="cn-fb-quiet cn-fb-empty">
              {empty}
            </p>
          )
        ) : (
          <section key={court} className={`cn-fb-court cn-fb-court-${court}`}>
            <h5>
              {COURT_WORD[court]} <span className="cn-fb-quiet">{rows.length}</span>
            </h5>
            {rows.map((hold) => (
              <HoldRow
                key={`${hold.court}:${hold.kind}:${hold.ref ?? ''}:${hold.needId ?? hold.title}`}
                hold={hold}
                story={stories.find((s) => s.number === hold.goal) ?? null}
                now={now}
                actions={actions}
              />
            ))}
          </section>
        ),
      )}
    </div>
  );
}

function HoldRow({
  hold,
  story,
  now,
  actions,
}: {
  hold: FeatureHold;
  story: { number: number; title: string } | null;
  now: number;
  actions: CockpitActions;
}): JSX.Element {
  const open = openHold(hold, actions);
  const suffix = story === null ? '' : ` · ${story.title}`;
  const said = suffix !== '' && hold.title.endsWith(suffix) ? hold.title.slice(0, -suffix.length) : hold.title;
  const storyRef = story === null ? null : `issue:${story.number}`;
  return (
    <div className={`cn-fb-hold cn-fb-hold-${hold.court}${isRed(hold) ? ' cn-fb-hold-red' : ''}`}>
      <div className="cn-fb-hold-body">
        {(story !== null || hold.ref !== null) && (
          <div className="cn-fb-hold-about">
            <span className="cn-refs">
              {storyRef !== null && <Ref to={storyRef} />}
              {hold.ref !== null && hold.ref !== storyRef && <Ref to={hold.ref} />}
            </span>
            {story !== null && <span className="cn-fb-hold-story">{story.title}</span>}
          </div>
        )}
        <div className="cn-fb-hold-title">{said}</div>
        {(hold.detail !== null || hold.since !== null) && (
          <div className="cn-fb-quiet">
            {hold.detail !== null && <span className="cn-fb-said-inline">{hold.detail}</span>}
            {hold.detail !== null && hold.since !== null && ' · '}
            {hold.since !== null && relAge(hold.since, now)}
          </div>
        )}
      </div>
      {open !== null && (
        <Button size="small" onClick={open}>
          {hold.needId !== null ? 'Answer' : 'Open'}
        </Button>
      )}
    </div>
  );
}

function openHold(hold: FeatureHold, actions: CockpitActions): (() => void) | null {
  if (hold.needId !== null) {
    const id = hold.needId;
    return () => actions.openPanel({ ask: id });
  }
  const pr = /^pr:(\d+)$/.exec(hold.ref ?? '');
  if (pr) {
    const n = Number(pr[1]);
    return () => actions.selectPr(n);
  }
  if (hold.ref !== null && /^issue:\d+$/.test(hold.ref)) {
    const ref = hold.ref;
    return () => actions.selectGoal(ref);
  }
  return null;
}

function held(feature: FeatureRollup): FeatureSequence | null {
  return feature.sequence?.status === 'accepted' ? feature.sequence : null;
}

function Sequence({
  feature,
  view,
  onAnswered,
}: {
  feature: FeatureRollup;
  view: CockpitView;
  onAnswered: () => void;
}): JSX.Element | null {
  const sequence = feature.sequence;
  if (sequence === null) return null;
  const open = feature.children.map((c) => c.number);
  const waves = wavesOf(open, sequence.edges);

  if (sequence.status !== 'proposed') {
    const folder = view.state.config.desktopFolder;
    const by = sequence.answeredBy === null || sequence.answeredBy === folder ? 'you' : sequence.answeredBy;
    const when = sequence.answeredAt === null ? '' : ` ${relAge(sequence.answeredAt, view.now)}`;
    return (
      <div className="cn-fb-seq-said">
        <p className="cn-fb-quiet">
          {sequence.status === 'accepted'
            ? `Order accepted by ${by}${when} — ${waves.length} wave${waves.length === 1 ? '' : 's'}.`
            : `${by === 'you' ? 'You' : by} said run them all${when} — the fleet will not propose an order again until this Feature gains or loses a story.`}
        </p>
        <Discuss feature={feature.number} folder={folder} />
        {sequence.status === 'accepted' && (
          <Order waves={waves} stories={feature.children} delivered={feature.briefing.delivered} now={view.now} />
        )}
      </div>
    );
  }

  const wouldHold = heldByAccepting(open, sequence.edges);
  return (
    <div className="cn-fb-seq">
      <h4>Proposed order</h4>
      <p className="cn-fb-seq-why">{sequence.reason}</p>
      {sequence.unsure !== null && (
        <p className="cn-fb-seq-unsure">
          <b>Least sure about</b> {sequence.unsure}
        </p>
      )}
      <div className="cn-fb-seq-waves">
        {waves.map((wave) => (
          <HeadRow key={wave.depth} align="baseline">
            <b>Wave {wave.depth + 1}</b>
            <span className="cn-refs">
              {wave.issues.map((n) => (
                <Ref key={n} to={`issue:${n}`} />
              ))}
            </span>
          </HeadRow>
        ))}
      </div>
      <Edges sequence={sequence} />
      {/* What accepting costs. Without it the operator is agreeing to a hold whose
          size is not on the card. */}
      <p className="cn-fb-quiet">
        {wouldHold === 0
          ? 'Accepting holds nothing right now — everything this order puts later is already settled or in flight.'
          : `Accepting holds ${wouldHold} of these ${open.length} stories until what they wait on has a branch.`}
      </p>
      <div className="cn-fb-seq-ctrls">
        <AsyncButton
          tone="primary"
          size="small"
          onClick={async () => {
            await api.answerFeatureSequence(feature.number, 'accepted', view.state.config.desktopFolder || 'you');
            onAnswered();
          }}
        >
          Accept
        </AsyncButton>
        <AsyncButton
          ghost
          size="small"
          onClick={async () => {
            await api.answerFeatureSequence(feature.number, 'declined', view.state.config.desktopFolder || 'you');
            onAnswered();
          }}
        >
          Run them all
        </AsyncButton>
        <Discuss feature={feature.number} folder={view.state.config.desktopFolder} />
      </div>
    </div>
  );
}

const DONE: ReadonlySet<FeatureChildStanding> = new Set(['delivered', 'settled']);

function Order({
  waves,
  stories,
  delivered,
  now,
}: {
  waves: ReturnType<typeof wavesOf>;
  stories: readonly FeatureChildRow[];
  delivered: readonly FeatureReportRow[];
  now: number;
}): JSX.Element {
  return (
    <ol className="cn-fb-order">
      {waves.map((wave) => (
        <li key={wave.depth}>
          <span className="cn-fb-order-n">{wave.depth + 1}</span>
          <ul>
            {wave.issues.map((n) => {
              const story = stories.find((c) => c.number === n);
              const said = delivered.find((d) => d.number === n);
              return (
                <li key={n} className={story !== undefined && DONE.has(story.standing) ? 'cn-fb-order-done' : ''}>
                  <span className="cn-refs">
                    <Ref to={`issue:${n}`} />
                  </span>
                  <div className="cn-fb-order-body">
                    <span className="cn-fb-order-title">{story?.title ?? `#${n}`}</span>
                    {said !== undefined && (
                      <>
                        <span className="cn-fb-said">“{said.summary}”</span>
                        <span className="cn-fb-quiet">
                          — {said.by}, {relAge(said.at, now)}
                        </span>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ol>
  );
}

function Discuss({ feature, folder }: { feature: number; folder: string }): JSX.Element | null {
  if (!folder) return null;
  return (
    <DesktopLink
      folder={folder}
      prompt={`Read the story order for feature #${feature} with sequence_read, then talk me through changing it.`}
      explain="so you can argue with the order and write it back with sequence_amend"
    />
  );
}

const EDGE_SOURCE: Record<FeatureSequence['edges'][number]['source'], string> = {
  link: 'tracker link',
  inferred: 'inferred',
  operator: 'yours',
};

function Edges({ sequence }: { sequence: FeatureSequence }): JSX.Element | null {
  if (sequence.edges.length === 0) {
    return <p className="cn-fb-quiet">No story waits on another — the sequencer found these independent.</p>;
  }
  return (
    <ul className="cn-fb-seq-edges">
      {sequence.edges.map((edge) => (
        <li key={`${edge.issue}>${edge.dependsOn}`}>
          <span className="cn-refs">
            <Ref to={`issue:${edge.issue}`} />
          </span>{' '}
          waits on{' '}
          <span className="cn-refs">
            <Ref to={`issue:${edge.dependsOn}`} />
          </span>
          <Tag>{EDGE_SOURCE[edge.source]}</Tag>
          {edge.reason !== null && <span className="cn-fb-seq-edge-why">{edge.reason}</span>}
        </li>
      ))}
    </ul>
  );
}

function GoalLink({ number, title, actions }: { number: number; title: string; actions: CockpitActions }): JSX.Element {
  return (
    <>
      <span className="cn-refs">
        <Ref to={`issue:${number}`} />
      </span>{' '}
      <button type="button" className="cn-fb-goal" onClick={() => actions.selectGoal(`issue:${number}`)}>
        {title}
      </button>
    </>
  );
}

function wantsYou(feature: FeatureRollup, view: CockpitView): ReactNode {
  const { counts } = feature;

  const unclear = feature.children.filter(
    (child) => view.state.world.issues.find((i) => i.number === child.number)?.appraisal?.verdict === 'unclear',
  );

  if (unclear.length > 0) {
    return (
      <>
        <b>Blocked.</b> The appraiser cannot tell what {unclear.length === 1 ? 'this is' : 'these are'} asking for:{' '}
        <Refs numbers={unclear.map((c) => c.number)} />. Nothing under them will dispatch until somebody answers.
      </>
    );
  }
  if (counts.fellShort > 0) {
    const rows = feature.children.filter((c) => c.standing === 'fellShort');
    return (
      <>
        <b>
          {counts.fellShort} {counts.fellShort === 1 ? 'item' : 'items'} fell short
        </b>{' '}
        — worked, and the goal still not reached: <Refs numbers={rows.map((r) => r.number)} />. A decision, not a retry.
      </>
    );
  }
  if (counts.unwatched > 0) {
    const rows = feature.children.filter((c) => c.standing === 'unwatched');
    return (
      <>
        <b>
          {counts.unwatched} {counts.unwatched === 1 ? 'item is' : 'items are'} unseen.
        </b>{' '}
        <Refs numbers={rows.map((r) => r.number)} /> carry no watch tag, so no agent has read{' '}
        {counts.unwatched === 1 ? 'it' : 'them'} — not behind, never in the queue.
      </>
    );
  }
  const unknown = feature.reach.filter((r) => r.status === 'unknown');
  if (unknown.length > 0) {
    return (
      <>
        <b>Reach unreadable.</b> The probe could not answer for {unknown.map((r) => r.environment).join(', ')} — which
        is not the same as “hasn’t shipped”.
      </>
    );
  }
  return null;
}

function Refs({ numbers }: { numbers: readonly number[] }): JSX.Element {
  const shown = numbers.slice(0, 3);
  return (
    <span className="cn-refs">
      {shown.map((n) => (
        <Ref key={n} to={`issue:${n}`} />
      ))}
      {numbers.length > shown.length && <span className="cn-fb-quiet">+{numbers.length - shown.length}</span>}
    </span>
  );
}

function Bar({ counts }: { counts: FeatureCounts }): JSX.Element {
  const order: FeatureChildStanding[] = ['delivered', 'inFlight', 'fellShort', 'settled', 'queued', 'unwatched'];
  return (
    <div className="cn-fb-bar" role="img" aria-label={barLabel(counts)}>
      {order.map((standing) =>
        counts[standing] === 0 ? null : (
          <i
            key={standing}
            className={`cn-fb-seg cn-fb-${standing}`}
            style={{ width: `${(counts[standing] / Math.max(counts.total, 1)) * 100}%` }}
          />
        ),
      )}
    </div>
  );
}

const STANDING_WORD: Record<FeatureChildStanding, string> = {
  delivered: 'delivered',
  inFlight: 'in flight',
  fellShort: 'fell short',
  settled: 'settled',
  queued: 'queued',
  unwatched: 'not watched',
};

const STANDING_TONE: Record<FeatureChildStanding, TagTone | undefined> = {
  delivered: 'green',
  inFlight: 'blue',
  fellShort: 'red',
  settled: undefined,
  queued: undefined,
  unwatched: 'amber',
};

function barLabel(counts: FeatureCounts): string {
  const parts = (Object.keys(STANDING_WORD) as FeatureChildStanding[])
    .filter((s) => counts[s] > 0)
    .map((s) => `${counts[s]} ${STANDING_WORD[s]}`);
  return `${parts.join(', ')} — ${counts.total} in all`;
}

function Reach({ reach }: { reach: readonly FeatureReach[] }): JSX.Element | null {
  if (reach.length === 0) return null;
  return (
    <span className="cn-fb-reach">
      {reach.map((env) => (
        <i key={env.environment} className={`cn-fb-env cn-fb-r-${env.status}`} title={reachTitle(env)}>
          {env.environment}
          {env.total > 0 && env.status !== 'unknown' ? ` ${env.goals}/${env.total}` : ''}
          {env.status === 'unknown' ? ' ?' : ''}
        </i>
      ))}
    </span>
  );
}

const REACH_WORD: Record<GoalReachStatus, string> = {
  reached: 'confirmed there',
  partial: 'partly there',
  absent: 'not there',
  unknown: 'the probe could not say — not the same as “hasn’t shipped”',
};

function reachTitle(env: FeatureReach): string {
  if (env.status === 'unknown') return `${env.environment}: ${REACH_WORD.unknown}`;
  return `${env.environment}: ${env.goals} of ${env.total} goals confirmed — ${REACH_WORD[env.status]}`;
}

function Children({
  rows,
  total,
  view,
  actions,
  sequence,
}: {
  rows: readonly FeatureChildRow[];
  total: number;
  view: CockpitView;
  actions: CockpitActions;
  sequence: FeatureSequence | null;
}): JSX.Element | null {
  if (rows.length === 0) return null;
  const filter = view.featurePrs;
  const openRows = rows.filter((r) => !isDone(r));
  const doneRows = rows.filter(isDone);
  const shown = filter === 'open' ? openRows : filter === 'done' ? doneRows : rows;
  const ordered =
    sequence === null
      ? shown
      : wavesOf(
          shown.map((r) => r.number),
          sequence.edges,
        ).flatMap((wave) => shown.filter((r) => wave.issues.includes(r.number)));
  const chip = (f: FeaturePrFilter, label: string, n: number): JSX.Element => (
    <Button
      key={f}
      size="small"
      ghost={f !== filter}
      aria-pressed={f === filter}
      onClick={() => actions.setFeatureQuery({ featurePrs: f })}
    >
      {label} {n}
    </Button>
  );
  return (
    <div className="cn-fb-kids">
      <div className="cn-fb-kids-head">
        <h4 className="cn-fb-colhead">Its stories &amp; PRs</h4>
        <span className="cn-fb-kids-filter" role="group" aria-label="Which stories">
          {chip('open', 'open', openRows.length)}
          {chip('done', 'done', doneRows.length)}
          {chip('all', 'all', rows.length)}
        </span>
      </div>
      {shown.length === 0 && (
        <p className="cn-fb-quiet cn-fb-empty">Nothing {filter === 'open' ? 'open' : 'done'} here.</p>
      )}
      <div className="cn-fb-stories">
        {ordered.map((row) => (
          <Story key={row.number} row={row} view={view} actions={actions} sequence={sequence} />
        ))}
      </div>
      {total > rows.length && (
        <p className="cn-fb-quiet">
          {rows.length} of {total} shown — the rest are on the Tickets tab.
        </p>
      )}
    </div>
  );
}

function isDone(row: FeatureChildRow): boolean {
  return row.standing === 'delivered' || row.standing === 'settled';
}

function Story({
  row,
  view,
  actions,
  sequence,
}: {
  row: FeatureChildRow;
  view: CockpitView;
  actions: CockpitActions;
  sequence: FeatureSequence | null;
}): JSX.Element {
  const waiting = sequence === null ? [] : waitsOn(row.number, sequence.edges);
  const prs = goalPullRequests(view.state, row.number);
  const issue = view.state.world.issues.find((i) => i.number === row.number);
  return (
    <div className="cn-fb-story">
      <Tag tone={STANDING_TONE[row.standing]} fill={STANDING_TONE[row.standing] !== undefined}>
        {STANDING_WORD[row.standing]}
      </Tag>
      <div className="cn-fb-story-main">
        <div className="cn-fb-story-head">
          <GoalLink number={row.number} title={row.title} actions={actions} />
          {/* The harness's own outcome word, beside the standing rather than instead
              of it: a re-picked goal is in flight and still carries `fell short`. */}
          {row.outcome !== null && row.outcome !== STANDING_WORD[row.standing] && (
            <span className="cn-fb-quiet"> · {row.outcome}</span>
          )}
        </div>
        {waiting.length > 0 && (
          <div className="cn-fb-waits cn-fb-quiet">
            waits on{' '}
            <span className="cn-refs">
              {waiting.map((n) => (
                <Ref key={n} to={`issue:${n}`} />
              ))}
            </span>
          </div>
        )}
        {prs.length === 0 && !isDone(row) && row.standing !== 'unwatched' && (
          <div className="cn-fb-quiet">no PR yet</div>
        )}
        {prs.length > 0 && (
          <div className="cn-fb-prs">
            {prs.map((gp) => (
              <PrRow key={gp.pr.number} gp={gp} slot={prs.some((p) => p.open)} view={view} actions={actions} />
            ))}
          </div>
        )}
      </div>
      <span className="cn-fb-story-end">
        {issue?.pickup.status === 'blocked' && issue.pickup.reasons[0] !== undefined && (
          <Tag title={issue.pickup.reasons.join(' · ')}>held</Tag>
        )}
        <span className="cn-fb-num">{money(row.costUsd)}</span>
      </span>
    </div>
  );
}

function PrRow({
  gp,
  slot,
  view,
  actions,
}: {
  gp: GoalPullRequest;
  slot: boolean;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  const { pr, open, position, stackSize } = gp;
  const openPr = open ? (pr as OpenPullRequest) : null;
  const onIt = view.state.tasks.find(
    (t) => t.originRef === `pr:${pr.number}` && (t.status === 'running' || t.status === 'waiting'),
  );
  const agent = onIt === undefined ? undefined : view.state.agents.find((a) => a.id === onIt.agentId);
  return (
    <div className={`cn-fb-pr${open ? '' : ' cn-fb-pr-done'}`}>
      {openPr !== null ? (
        <CiMark pr={openPr} reserve onOpen={() => actions.selectPr(pr.number)} />
      ) : (
        slot && <span className="ck-slot" />
      )}
      <span className="cn-refs cn-fb-pr-ref">
        <Ref to={`pr:${pr.number}`} />
      </span>
      {position !== null && stackSize !== null && (
        <span className="cn-fb-rung" title={`Rung ${position} of ${stackSize} in its stack, bottom first`}>
          [{position}/{stackSize}]
        </span>
      )}
      <span className="cn-fb-pr-said">
        {openPr !== null ? (openPr.attention.reasons[0] ?? pr.title) : pr.merged ? 'merged' : 'closed'}
        {!open && pr.closedAt !== undefined && <span className="cn-fb-quiet"> {relAge(pr.closedAt, view.now)}</span>}
      </span>
      {openPr !== null && (
        <span className="cn-fb-pr-marks">
          <ReviewMark review={openPr.review} now={view.now} onOpen={() => actions.selectPr(pr.number)} />
          <CommentsMark comments={openPr.unresolvedComments} onOpen={() => actions.selectPr(pr.number)} />
        </span>
      )}
      {agent !== undefined && (
        <AgentOnIt
          agentId={agent.id}
          note={agent.note ?? onIt?.title}
          holding={agent.status === 'waiting'}
          actions={actions}
        />
      )}
    </div>
  );
}

function money(usd: number | null): ReactNode {
  return usd === null ? <i className="cn-fb-never">not measured</i> : fmtUsd(usd);
}
