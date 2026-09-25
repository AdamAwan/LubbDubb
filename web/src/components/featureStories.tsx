import type { JSX, ReactNode } from 'react';
import type { CockpitActions } from '../cockpit/actions.js';
import type { FeaturePrFilter } from '../cockpit/place.js';
import type { CockpitView } from '../view/viewModel.js';
import { goalPullRequests, type GoalPullRequest } from '../view/featureHolds.js';
import { waitsOn, wavesOf } from '../view/sequence.js';
import type {
  FeatureChildRow,
  FeatureChildStanding,
  FeatureReportRow,
  FeatureSequence,
  OpenPullRequest,
} from '../types.js';
import { AgentOnIt } from './AgentOnIt.js';
import { Button } from './button.js';
import { CiMark } from './CiMark.js';
import { CommentsMark } from './CommentsMark.js';
import { ReviewMark } from './ReviewMark.js';
import { Ref } from './refs.js';
import { Tag, type TagTone } from './tag.js';
import { fmtUsd, relAge } from './util.js';

export function Delivered({
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

export const STANDING_WORD: Record<FeatureChildStanding, string> = {
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

export function Children({
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
      <PrAgent pr={pr.number} view={view} actions={actions} />
    </div>
  );
}

function PrAgent({
  pr,
  view,
  actions,
}: {
  pr: number;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element | null {
  const onIt = view.state.tasks.find(
    (t) => t.originRef === `pr:${pr}` && (t.status === 'running' || t.status === 'waiting'),
  );
  const agent = onIt === undefined ? undefined : view.state.agents.find((a) => a.id === onIt.agentId);
  if (agent === undefined) return null;
  return (
    <AgentOnIt
      agentId={agent.id}
      note={agent.note ?? onIt?.title}
      holding={agent.status === 'waiting'}
      actions={actions}
    />
  );
}

export function money(usd: number | null): ReactNode {
  return usd === null ? <i className="cn-fb-never">not measured</i> : fmtUsd(usd);
}
