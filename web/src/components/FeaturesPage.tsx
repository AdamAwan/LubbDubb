import { useEffect, useState, type JSX } from 'react';
import { api } from '../api.js';
import type { CockpitActions } from '../cockpit/actions.js';
import { issueTypeTone } from '../issueGroups.js';
import { stateColour } from '../stateColour.js';
import type { FeatureNode, FeatureProgress, FeaturesPayload } from '../types.js';
import type { CockpitView } from '../view/viewModel.js';
import { Ref, RefLinksExtended } from './refs.js';
import { fmtUsd, relAge } from './util.js';

/**
 * The tracker's hierarchy, with what the fleet has made of each branch rolled up
 * it — features as headings, everything under them, and how far along each is.
 *
 * ## Why it is not the tickets tab
 *
 * The tickets tab already groups its rows under a feature heading, and it answers
 * the *list* question: which items am I being asked about, and what is the harness
 * doing with each one. This page answers the other question — **is the feature
 * getting done** — and the two need different shapes. A rollup spans levels the
 * list flattens to one; it counts items the assignment filter never returned; and
 * it cannot be paged, because a tree cut off at forty rows reports a branch as
 * finished when the rest of it is on the next page. The tickets tab stays the
 * surface triage happens on. This is the one an operator opens to see whether the
 * goal above the tickets is moving.
 *
 * ## Every number here was decided somewhere else
 *
 * A lens, in the sense `docs/spec/17-cockpit.md` uses the word: the buckets are
 * folded server-side by `src/features/featureTree.ts` out of readings the harness
 * already made — the watch tag through `src/watchLabels.ts`, the money through
 * `buildSpendGoals`, the outcome word through `ticketOutcomes`. Nothing is
 * re-derived in the browser, and no rule under `src/dispatcher/` reads any of it.
 *
 * ## The bar says what it cannot see
 *
 * A feature's fifth segment is **outside** — items the tracker hangs under it that
 * this harness's assignment filter has never returned. Drawing four segments would
 * make a feature with three stories on another team's board read as complete, which
 * is the one number a delivery conversation turns on. → docs/spec/17-cockpit.md#the-features-page
 */
export function FeaturesPage({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const [payload, setPayload] = useState<FeaturesPayload | null>(null);
  const [failed, setFailed] = useState(false);

  // Fetched on open rather than polled, for the tickets tab's reason: the tree is
  // folded from the whole mirror, and `/api/state` comes round every couple of
  // seconds for every open cockpit.
  useEffect(() => {
    let live = true;
    api
      .getFeatures()
      .then((next) => {
        if (live) setPayload(next);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);

  if (failed) return <p className="muted">The feature tree could not be read. The harness is unaffected.</p>;
  if (payload === null) return <p className="muted">Reading the tracker’s hierarchy…</p>;
  if (!payload.tracked) return <FlatTracker />;

  const { roots, orphans, totals } = payload;

  return (
    // The route's URLs merged over the shell's, so a reference to a container the
    // world never held still resolves to a link — most features are visible only as
    // something else's parent, and the snapshot's map is built from the world.
    <RefLinksExtended refUrls={payload.refUrls}>
      <section className="feat-page">
        <header className="feat-head">
          <div>
            <h2>Features</h2>
            <p className="muted">
              {roots.length === 0
                ? 'The tracker reports a hierarchy, but nothing the filter returned hangs under a container.'
                : `${roots.length} feature${roots.length === 1 ? '' : 's'} · ${totals.total} item${
                    totals.total === 1 ? '' : 's'
                  } under them`}
            </p>
          </div>
          <div className="feat-headline">
            <ProgressBar progress={totals} />
            <Legend progress={totals} />
          </div>
        </header>

        {roots.map((node) => (
          <NodeView key={node.number} node={node} view={view} actions={actions} now={view.now} />
        ))}

        {orphans.length > 0 && (
          <section className="feat-orphans">
            {/* Its own section rather than a root beside the features, because it is
                not one: these are items the tracker says hang off nothing, and the
                page's whole subject is what they are missing. → src/issueRelations.ts */}
            <h3>
              No feature <i className="feat-count">{orphans.length}</i>
            </h3>
            <p className="muted">
              The tracker says these hang off nothing — not the same as a parent we could not read. Their wider goal is
              not recorded anywhere the harness can see, so an agent working one is told to say so rather than to guess
              at it.
            </p>
            {orphans.map((node) => (
              <LeafRow key={node.number} node={node} view={view} actions={actions} now={view.now} />
            ))}
          </section>
        )}
      </section>
    </RefLinksExtended>
  );
}

/**
 * What the page says on a tracker with no hierarchy.
 *
 * Reachable only by a stale or hand-typed URL — the nav appends the tab only where
 * the snapshot says a parent link was resolved — so it says which fact it is
 * answering rather than drawing an empty tree. A page that rendered nothing here
 * would read as one that failed to load. → docs/spec/17-cockpit.md#the-features-page
 */
function FlatTracker(): JSX.Element {
  return (
    <section className="feat-page">
      <header className="feat-head">
        <div>
          <h2>Features</h2>
          <p className="muted">
            This tracker reports no hierarchy: nothing it has returned carries a parent link either way. Features and
            epics are an Azure DevOps Boards concept, and GitHub Issues answer here only once a provider resolves their
            sub-issue links onto <code>Issue.parent</code> — at which point this page fills in by itself, with nothing
            in the cockpit to change.
          </p>
        </div>
      </header>
    </section>
  );
}

/**
 * One node and everything under it: a container as a heading, anything else as a
 * row.
 *
 * **A container is never drawn as a row**, which is the same rule the dispatcher's
 * pickup gate keeps: a Feature is a statement of intent its children deliver, so
 * offering it as a thing to work would be offering an agent a goal whose
 * decomposition already exists next to it. → src/issueRelations.ts
 */
function NodeView({
  node,
  view,
  actions,
  now,
}: {
  node: FeatureNode;
  view: CockpitView;
  actions: CockpitActions;
  now: number;
}): JSX.Element {
  // The tickets tab's own folds, by issue number — the same `Place` field and the
  // same action. It is one fact ("this feature is folded away"), and a second field
  // for it would be two places disagreeing about one answer.
  const collapsed = view.collapsedFeatures.has(node.number);
  const kids = node.children;

  if (!node.container) return <LeafRow node={node} view={view} actions={actions} now={now} />;

  return (
    <section className={`feat-block d${Math.min(node.depth, 3)}`}>
      <header className="feat-fhead">
        <button
          type="button"
          className="feat-fold"
          aria-expanded={!collapsed}
          onClick={() => actions.collapseFeature(node.number, !collapsed)}
          title={collapsed ? 'Show the work under this feature' : 'Fold this feature away'}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <i className={`feat-stripe f${node.slot ?? 0}`} />
        <span className="feat-fname">
          {/* The name is the control and the reference sits beside it: one click
              cannot have two destinations. */}
          <button
            type="button"
            className="feat-name-btn"
            onClick={() => actions.selectGoal(`issue:${node.number}`)}
            title="Open this feature’s page — its children, its plan and anything it is asking you"
          >
            <b>{node.title}</b>
          </button>
          <i className="feat-num">#{node.number}</i>
          {node.issueType !== null && <i className={`feat-type ${issueTypeTone(node.issueType)}`}>{node.issueType}</i>}
          {node.workItemState !== null && (
            <StateChip state={node.workItemState} colours={view.state.config.stateColours} />
          )}
          {node.known === 'relation' && (
            <i className="feat-outside" title="Named only as a parent — the assignment filter has never returned it">
              not in your list
            </i>
          )}
        </span>
        <span className="feat-fbar">
          <ProgressBar progress={node.progress} />
        </span>
        <span className="feat-fcount">
          {node.progress.done}/{node.progress.total}
        </span>
        <span className={`feat-fcost${node.progress.costUsd === 0 ? ' none' : ''}`}>
          {/* An em dash, not `$0.00`: never worked and worked for free are different
              facts, and a zero would state the wrong one. */}
          {node.progress.costUsd === 0 ? '—' : fmtUsd(node.progress.costUsd)}
        </span>
        <span className="cn-refs">
          <Ref to={`issue:${node.number}`} />
        </span>
      </header>

      {!collapsed && (
        <div className="feat-kids">
          {kids.length === 0 ? (
            <p className="muted feat-empty">
              Nothing hangs off this yet. A container with no children is a goal whose decomposition has not been
              written down — the harness reports it and does not invent one.
            </p>
          ) : (
            kids.map((kid) => <NodeView key={kid.number} node={kid} view={view} actions={actions} now={now} />)
          )}
        </div>
      )}
    </section>
  );
}

/** One workable item under a feature: what it is, where it stands, what it cost. */
function LeafRow({
  node,
  view,
  actions,
  now,
}: {
  node: FeatureNode;
  view: CockpitView;
  actions: CockpitActions;
  now: number;
}): JSX.Element {
  const outside = node.known === 'relation';
  return (
    <div className={`feat-row ${node.state === 'closed' ? 'done' : ''} ${outside ? 'outside' : ''}`}>
      <span className="feat-id">#{node.number}</span>
      <span className="feat-what">
        {/* A node the filter never returned has no goal page to open — the harness
            holds nothing about it beyond the line its parent carried. The reference
            beside it is the whole way in, which is the tracker. */}
        {outside ? (
          <b className="feat-name">{node.title}</b>
        ) : (
          <button
            type="button"
            className="feat-name-btn"
            onClick={() => actions.selectGoal(`issue:${node.number}`)}
            title="Open this goal — its plan, its ticket, its pull requests and anything it is asking you"
          >
            <b className="feat-name">{node.title}</b>
          </button>
        )}
        <span className="feat-sub">
          {node.issueType !== null && <i className={`feat-type ${issueTypeTone(node.issueType)}`}>{node.issueType}</i>}
          {node.outcome !== null && <i className="chip small feat-verdict">{node.outcome}</i>}
          {outside && (
            <i
              className="feat-outside"
              title="The tracker hangs this here; your assignment filter has never returned it"
            >
              not in your list
            </i>
          )}
          {node.tracking === 'frozen' && node.changedAt !== null && (
            <span>last change {relAge(node.changedAt, now)}</span>
          )}
        </span>
      </span>
      <span className="feat-watch">
        {/* Null, not `unwatched`: nothing told us this item's labels, and the
            absent reading is not the same as a negative one. */}
        {node.watch === null ? <i className="feat-unknown">—</i> : node.watch === 'watched' ? 'watched' : 'not watched'}
      </span>
      <span>
        {node.workItemState !== null ? (
          <StateChip state={node.workItemState} colours={view.state.config.stateColours} />
        ) : (
          <i className="chip small">{node.state}</i>
        )}
      </span>
      <span className={`feat-cost${node.costUsd === null ? ' none' : ''}`}>
        {node.costUsd === null ? '—' : fmtUsd(node.costUsd)}
      </span>
      <span className="cn-refs">
        <Ref to={`issue:${node.number}`} />
      </span>
    </div>
  );
}

/** The five buckets, in the order work moves through them. */
const SEGMENTS: ReadonlyArray<{ key: keyof Omit<FeatureProgress, 'total' | 'costUsd'>; label: string; why: string }> = [
  { key: 'done', label: 'done', why: 'Closed in the tracker — its own word, and it outranks every reading we have' },
  { key: 'working', label: 'working', why: 'Open, and the fleet has been on it: money spent, or a verdict cast' },
  { key: 'queued', label: 'queued', why: 'Watched and untouched — opted in, waiting for a slot' },
  { key: 'waiting', label: 'waiting', why: 'Open, and nobody has opted it in' },
  {
    key: 'outside',
    label: 'not in your list',
    why: 'The tracker hangs these here and your assignment filter has never returned them — work this harness cannot see',
  },
];

/**
 * The rollup as one bar.
 *
 * Percentages are of `total`, which includes the items the harness cannot see —
 * folding those out would draw a full bar over a feature that is half somebody
 * else's, which is the number this whole page exists to state honestly.
 */
function ProgressBar({ progress }: { progress: FeatureProgress }): JSX.Element {
  if (progress.total === 0) return <span className="feat-bar empty" title="Nothing hangs under this yet" />;
  return (
    <span className="feat-bar">
      {SEGMENTS.map(({ key, label, why }) => {
        const count = progress[key];
        if (count === 0) return null;
        return (
          <i
            key={key}
            className={`feat-seg ${key}`}
            style={{ width: `${(count / progress.total) * 100}%` }}
            title={`${count} ${label} — ${why}`}
          />
        );
      })}
    </span>
  );
}

/** What each colour on the bar means, with the head's own counts against it. */
function Legend({ progress }: { progress: FeatureProgress }): JSX.Element {
  return (
    <span className="feat-legend">
      {SEGMENTS.map(({ key, label, why }) => (
        <span key={key} className="feat-key" title={why}>
          <i className={`feat-dot ${key}`} />
          {progress[key]} {label}
        </span>
      ))}
    </span>
  );
}

/**
 * The tracker's own state word, in the operator's colour for it.
 *
 * The same reading the tickets tab's chip draws, through the same `stateColour`
 * fold — the tracker's punctuation is not the operator's, and two surfaces folding
 * the key differently is two colours for one state.
 */
function StateChip({ state, colours }: { state: string; colours: Record<string, string> }): JSX.Element {
  const colour = stateColour(colours, state);
  return (
    <i className="chip small feat-state" style={colour === null ? {} : { borderColor: colour, color: colour }}>
      {state}
    </i>
  );
}
