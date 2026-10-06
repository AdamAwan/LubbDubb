import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { api } from '../api.js';
import type { CockpitActions } from '../cockpit/actions.js';
import {
  FEATURE_MODES,
  FEATURE_SORTS,
  type FeatureDensity,
  type FeatureMode,
  type FeatureSort,
} from '../cockpit/place.js';
import type { CockpitView } from '../view/viewModel.js';
import { FeatureFocus } from './FeatureFocus.js';
import { FeatureSummariesAd } from './FeatureSummariesAd.js';
import { RefLinksExtended } from './refs.js';
import { BareButton, Button } from './button.js';
import { fmtUsd } from './util.js';
import type { FeatureBoardPayload } from '../types.js';
import { Crumb, type CrumbStep } from '../console/Crumb.js';
import { BoardCard, buildCards, FeatureCard, orderCards } from './featureCards.js';

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

/** A closed Feature is off the board unless the operator asks for it back. → docs/spec/17-cockpit.md#closed-features */
export function shownFeatures(board: FeatureBoardPayload, showClosed: boolean): FeatureBoardPayload {
  return showClosed ? board : { ...board, features: board.features.filter((f) => f.state !== 'closed') };
}

export function FeatureBoard({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const { board: all, failed, read } = useFeatureBoard();

  if (failed) return <p className="muted">This deployment has no feature board.</p>;
  if (all === null) return <p className="muted">Reading the tracker’s hierarchy…</p>;

  /* A card opened is a page of its own, on `?card=` — the board draws briefs and
     nothing more. → docs/spec/17-cockpit.md#the-feature-page */
  if (view.featureMode === 'board' && view.featureCard !== null) {
    return (
      <FeatureDetail
        number={view.featureCard}
        board={all}
        back={{
          label: 'Features',
          usage: { counted: 'feature.view' },
          go: () => actions.setFeatureQuery({ featureCard: null }),
        }}
        view={view}
        actions={actions}
        onAnswered={() => void read()}
      />
    );
  }

  return <BoardBody all={all} view={view} actions={actions} read={read} />;
}

function BoardBody({
  all,
  view,
  actions,
  read,
}: {
  all: FeatureBoardPayload;
  view: CockpitView;
  actions: CockpitActions;
  read: () => Promise<void>;
}): JSX.Element {
  const board = shownFeatures(all, view.featureClosed);
  const closed = all.features.length - shownFeatures(all, false).features.length;
  const { features, unresolved } = board;
  if (all.features.length === 0) {
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

  return (
    <RefLinksExtended refUrls={board.refUrls}>
      <div className="cn-fb">
        <BoardHead board={board} cards={cards.length} closed={closed} view={view} actions={actions} />

        {features.length === 0 && <p className="muted">Every Feature on the board is closed.</p>}

        {!view.state.config.featureSummaries && <FeatureSummariesAd actions={actions} onTurnedOn={() => void read()} />}

        {view.featureMode === 'focus' && features.length > 0 && (
          <FeatureFocus board={board} view={view} actions={actions} onAnswered={() => void read()} />
        )}

        {view.featureMode === 'board' &&
          cards.map((card) => (
            <BoardCard
              key={card.rollup.number}
              card={card}
              rows={rows}
              view={view}
              actions={actions}
              onAnswered={() => void read()}
            />
          ))}

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

function BoardHead({
  board,
  cards,
  closed,
  view,
  actions,
}: {
  board: FeatureBoardPayload;
  cards: number;
  closed: number;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  const { features, orphans } = board;
  const paused = features.filter((f) => f.paused !== null).length;
  return (
    <div className="cn-fb-head">
      <h2>Features</h2>
      <span className="cn-fb-quiet">
        {features.length} {features.length === 1 ? 'feature' : 'features'}
        {/* A pause withholds work, so it is counted out loud. A rested card that
            nothing says is resting is the silent version of this button. */}
        {paused > 0 && ` · ${paused} paused`}
        {/* The orphan bucket's money, said once about the page: this much was spent
            under no Feature, which is also the sentence that says every roll-up
            below understates its own. */}
        {orphans !== null && orphans.costUsd !== null && ` · ${fmtUsd(orphans.costUsd)} spent under no Feature`}
        {board.backfilling ? ' · still filling' : ''}
      </span>
      <ModeControl mode={view.featureMode} actions={actions} />
      {closed > 0 && <ClosedControl closed={closed} shown={view.featureClosed} actions={actions} />}
      {view.featureMode === 'board' && (
        <>
          <DensityControl density={view.featureDensity} cards={cards} actions={actions} />
          <SortControl sort={view.featureSort} actions={actions} />
        </>
      )}
    </div>
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
  const card = buildCards(board, view).find((c) => c.rollup.number === number);
  const title = card === undefined ? null : card.rollup.title;
  return (
    <RefLinksExtended refUrls={board.refUrls}>
      <Crumb trail={[back]} here={title === null ? `#${number}` : `#${number} ${title}`} />
      <div className="cn-fb cn-fb-page">
        {card === undefined ? (
          <p className="muted">#{number} is not on the feature board — only Features are.</p>
        ) : (
          <FeatureCard card={card} view={view} actions={actions} onAnswered={onAnswered} page />
        )}
      </div>
    </RefLinksExtended>
  );
}

function ModeControl({ mode, actions }: { mode: FeatureMode; actions: CockpitActions }): JSX.Element {
  return (
    <span className="cn-fb-mode">
      {FEATURE_MODES.map((m) => (
        <BareButton
          key={m}
          usage="feature.filter"
          logs={m !== mode}
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
        </BareButton>
      ))}
    </span>
  );
}

/**
 * Full cards while the board is short enough to read down, one line each past that.
 * Eight is where a reader stops holding the list in their head: a brief runs about a
 * viewport-third, so eight is already three screens of scrolling to find a name.
 * → docs/spec/17-cockpit.md#the-board-at-length
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
        usage="feature.filter"
        logs={rows}
        ghost={rows}
        aria-pressed={!rows}
        title="Every Feature in full — its account, its progress and where it has reached"
        onClick={() => actions.setFeatureQuery({ featureDensity: 'brief' })}
      >
        Full
      </Button>
      <Button
        size="small"
        usage="feature.filter"
        logs={!rows}
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

function ClosedControl({
  closed,
  shown,
  actions,
}: {
  closed: number;
  shown: boolean;
  actions: CockpitActions;
}): JSX.Element {
  return (
    <Button
      size="small"
      usage="feature.filter"
      ghost={!shown}
      aria-pressed={shown}
      title={shown ? 'Hide the Features that are closed' : 'Bring the closed Features back onto the board'}
      onClick={() => actions.setFeatureQuery({ featureClosed: !shown })}
    >
      {shown ? `Hide ${closed} closed` : `Show ${closed} closed`}
    </Button>
  );
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
          usage="feature.filter"
          logs={s !== sort}
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
