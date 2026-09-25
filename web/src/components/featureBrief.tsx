import type { JSX, ReactNode } from 'react';
import type { CockpitActions } from '../cockpit/actions.js';
import type { CockpitView } from '../view/viewModel.js';
import type { FeatureHolds, FeaturePresence } from '../view/featureHolds.js';
import type {
  FeatureChildStanding,
  FeatureCounts,
  FeatureLandingRow,
  FeatureReach,
  FeatureRollup,
  GoalReachStatus,
} from '../types.js';
import { AgentOnIt } from './AgentOnIt.js';
import { HeadRow } from './panel.js';
import { Ref } from './refs.js';
import { Tag } from './tag.js';
import { relAge } from './util.js';
import { Courts } from './featureHoldList.js';
import { money, STANDING_WORD } from './featureStories.js';

export function Brief({
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

export function Standing({ feature, view }: { feature: FeatureRollup; view: CockpitView }): JSX.Element | null {
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

export function wantsYou(feature: FeatureRollup, view: CockpitView): ReactNode {
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

export function Bar({ counts }: { counts: FeatureCounts }): JSX.Element {
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

function barLabel(counts: FeatureCounts): string {
  const parts = (Object.keys(STANDING_WORD) as FeatureChildStanding[])
    .filter((s) => counts[s] > 0)
    .map((s) => `${counts[s]} ${STANDING_WORD[s]}`);
  return `${parts.join(', ')} — ${counts.total} in all`;
}

export function Reach({ reach }: { reach: readonly FeatureReach[] }): JSX.Element | null {
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
