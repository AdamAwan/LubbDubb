import type { JSX } from 'react';
import type { CockpitActions } from '../cockpit/actions.js';
import type { FeatureSort } from '../cockpit/place.js';
import type { CockpitView } from '../view/viewModel.js';
import { featureHolds, type FeatureHolds } from '../view/featureHolds.js';
import type { FeatureBoardPayload, FeatureCounts, FeatureRollup } from '../types.js';
import { Panel } from './panel.js';
import { BareButton } from './button.js';
import { DesktopLink } from './DesktopLink.js';
import { featurePrompt } from '../cockpit/desktopLink.js';
import { relAge } from './util.js';
import { FeatureAccount, FeatureMarks } from './featureAccount.js';
import { Bar, Brief, Reach, Standing, wantsYou } from './featureBrief.js';
import { Courts, Holds } from './featureHoldList.js';
import { held, Sequence } from './featureOrder.js';
import { Children, Delivered } from './featureStories.js';

type Card = { rollup: FeatureRollup; holds: FeatureHolds };

export function buildCards(board: FeatureBoardPayload, view: CockpitView): Card[] {
  const state = view.state;
  return board.features.map((rollup) => ({
    rollup,
    holds: featureHolds(
      state,
      view.needsYou,
      rollup.children.map((c) => c.number),
    ),
  }));
}

export function orderCards(cards: Card[], sort: FeatureSort): Card[] {
  // A paused Feature sinks under every sort, including the ones that would
  // otherwise pull it back up: resting is the whole point of the button, and a
  // sort that outranks it hands the operator back the crowded board they paused
  // their way out of.
  const resting = (c: Card): number => (c.rollup.paused !== null ? 1 : 0);
  // And a flagged one rises, for the mirror of that reason: the flag is a standing
  // instruction about what the fleet works next, so a board that took it and left the
  // card where it was would be the one surface disagreeing with the queue.
  // A pause still wins — it is the more deliberate of the two.
  const first = (c: Card): number => (c.rollup.priority !== null ? 0 : 1);
  const counts = (c: Card): FeatureCounts => c.rollup.counts;
  const cost = (c: Card): number | null => c.rollup.costUsd;
  const latest = (c: Card): string | null => c.rollup.lastLandingAt;
  const number = (c: Card): number => c.rollup.number;
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

export function BoardCard({
  card,
  rows,
  view,
  actions,
  onAnswered,
}: {
  card: Card;
  rows: boolean;
  view: CockpitView;
  actions: CockpitActions;
  onAnswered: () => void;
}): JSX.Element {
  return rows ? (
    <FeatureRow card={card} actions={actions} onAnswered={onAnswered} />
  ) : (
    <FeatureCard card={card} view={view} actions={actions} onAnswered={onAnswered} />
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
  card: Card;
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
      <BareButton
        usage="feature.filter"
        className="cn-fb-row-open"
        onClick={() => actions.setFeatureQuery({ featureCard: feature.number })}
      >
        <span className="cn-fb-row-name">{feature.title}</span>
        {feature.summary?.headline !== null && feature.summary !== null && (
          <span className="cn-fb-row-said">{feature.summary.headline}</span>
        )}
      </BareButton>
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
  card: Card;
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
      {page && <TalkAbout feature={feature.number} folder={view.state.config.desktopFolder} />}
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

function TalkAbout({ feature, folder }: { feature: number; folder: string }): JSX.Element | null {
  if (!folder) return null;
  return (
    <DesktopLink
      usage="feature.open"
      folder={folder}
      prompt={featurePrompt(feature)}
      ready="ready for your question"
      explain="answered from what the harness holds about this Feature — its account, its order, and where every story under it is up to."
    />
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
