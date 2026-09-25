import type { JSX } from 'react';
import type { AllowanceApportionment, AllowanceGoal, AllowanceInsights, AllowancePayload } from '../types.js';
import { fmtUsd, relTime } from './util.js';
import { fmtShare, share } from './insightsFormat.js';
import { Ref, RefLinksExtended } from './refs.js';
import { Label } from './label.js';
import { TipLayer, fmtPoints, useTip } from './allowanceChart.js';
import { Timeline } from './AllowanceTimeline.js';
import { Projection } from './AllowanceProjectionChart.js';

// → docs/spec/17-cockpit.md

export function AllowanceTab({ payload }: { payload: AllowancePayload }): JSX.Element {
  const { allowance, refUrls } = payload;
  const now = Date.parse(allowance.generatedAt);
  const { apportionment } = allowance;

  if (allowance.readings.length < 2) {
    return (
      <p className="empty">
        {allowance.readings.length === 0
          ? 'No usage windows were reported in this window. A reading arrives only when an agent takes a turn, ' +
            'and API-key auth reports none at all — so this is a fleet that has not run, not an account at zero.'
          : 'One reading in this window, which is a level rather than a change. The next agent turn gives it ' +
            'something to be measured against.'}
      </p>
    );
  }

  return (
    <RefLinksExtended refUrls={refUrls}>
      <div className="sp al">
        <Headline allowance={allowance} now={now} />

        <p className="sp-sub">Over the window</p>
        <Timeline allowance={allowance} now={now} />

        <div className="sp-cols">
          <section className="sp-col">
            <p className="sp-sub">Where it went</p>
            <GoalBar apportionment={apportionment} />
            <Method allowance={allowance} />
          </section>
          <section className="sp-col">
            <p className="sp-sub">The week</p>
            <Projection allowance={allowance} />
          </section>
        </div>

        <p className="sp-sub">Per landed change</p>
        <Goals goals={apportionment.goals} unattributed={apportionment.unattributedPoints} />
      </div>
    </RefLinksExtended>
  );
}

function Headline({ allowance, now }: { allowance: AllowanceInsights; now: number }): JSX.Element {
  const { observedPoints, attributedPoints, unattributedPoints, pointsPerUsd } = allowance.apportionment;
  const observed = observedPoints ?? 0;
  return (
    <div className="sp-tiles">
      <div className="sp-tile sp-well sp-key">
        <Label dense>Allowance spent</Label>
        <span className="vl">{fmtPoints(observed)}</span>
        <span className="sb">
          of the five-hour window, over {allowance.readings.length} readings · last {relTime(lastAt(allowance), now)}
        </span>
      </div>
      <div className="sp-tile sp-well">
        <Label dense>Charged to a goal</Label>
        <span className="vl">{fmtPoints(attributedPoints)}</span>
        <span className="sb">{fmtShare(attributedPoints, observed)} of the rise, apportioned by cost share</span>
      </div>
      <div className="sp-tile sp-well">
        <Label dense>Unattributed</Label>
        <span className="vl">{fmtPoints(unattributedPoints)}</span>
        <span className="sb">moved with no fleet spend to explain it — your own sessions, and local runs</span>
      </div>
      <div className="sp-tile sp-well">
        <Label dense>Per dollar</Label>
        <span className="vl">{pointsPerUsd === null ? '—' : fmtPoints(pointsPerUsd)}</span>
        <span className="sb">
          {pointsPerUsd === null
            ? 'nothing measured spent in this window'
            : 'of allowance per dollar — the rate the split rests on'}
        </span>
      </div>
    </div>
  );
}

function GoalBar({ apportionment }: { apportionment: AllowanceApportionment }): JSX.Element {
  const { goals, observedPoints, unattributedPoints } = apportionment;
  const total = observedPoints ?? 0;
  const { tip, show, hide, wrap } = useTip();
  return (
    <>
      <div className="al-chart" ref={wrap}>
        <div
          className="sp-bar sp-well"
          role="img"
          aria-label={goals
            .map((g) => `#${g.issueNumber} ${fmtPoints(g.points)}`)
            .concat(`unattributed ${fmtPoints(unattributedPoints)}`)
            .join(', ')}
        >
          {goals.map((goal) => (
            <span
              key={goal.issueNumber}
              className="sg"
              style={{ width: `${share(goal.points, total)}%`, background: `var(--al-goal-${goal.slot})` }}
              onMouseMove={(e) =>
                show(
                  e,
                  [
                    `#${goal.issueNumber} ${goal.title ?? 'no longer on the tracker'}`,
                    `${fmtPoints(goal.points)} of the window (${fmtShare(goal.points, total)})`,
                  ],
                  null,
                )
              }
              onMouseLeave={hide}
            />
          ))}
          <span
            className="sg al-residual"
            style={{ width: `${share(unattributedPoints, total)}%` }}
            onMouseMove={(e) =>
              show(
                e,
                [
                  `Unattributed: ${fmtPoints(unattributedPoints)}`,
                  'the account moved while no fleet agent was spending',
                ],
                null,
              )
            }
            onMouseLeave={hide}
          />
        </div>
        <TipLayer tip={tip} />
      </div>
      <p className="sp-note">
        {fmtPoints(total)} of the five-hour allowance went in this window. Hover a segment for the goal it is charged
        to.
      </p>
    </>
  );
}

function Goals({ goals, unattributed }: { goals: readonly AllowanceGoal[]; unattributed: number }): JSX.Element {
  return (
    <table className="sp-tbl">
      <thead>
        <tr>
          <th>Goal</th>
          <th className="n">Allowance</th>
          <th className="n">Cost</th>
          <th className="n">Landed</th>
          <th className="n">Per landed</th>
        </tr>
      </thead>
      <tbody>
        {goals.map((goal) => (
          <tr key={goal.issueNumber}>
            <td>
              <span className="al-swatch" style={{ background: `var(--al-goal-${goal.slot})` }} />
              <Ref to={goal.originRef} />
              <span className="al-title">{goal.title ?? 'no longer on the tracker'}</span>
            </td>
            <td className="n">{fmtPoints(goal.points)}</td>
            <td className="n">{fmtUsd(goal.costUsd)}</td>
            <td className="n">{goal.landed}</td>
            <td className={goal.pointsPerLanded === null ? 'n al-warn' : 'n'}>
              {goal.pointsPerLanded === null ? 'nothing landed' : fmtPoints(goal.pointsPerLanded)}
            </td>
          </tr>
        ))}
        <tr className="al-residual-row">
          <td>
            <span className="al-swatch al-residual" />
            <span className="al-title">Unattributed — no goal to charge it to</span>
          </td>
          <td className="n">{fmtPoints(unattributed)}</td>
          <td className="n">—</td>
          <td className="n">—</td>
          <td className="n">—</td>
        </tr>
      </tbody>
    </table>
  );
}

function Method({ allowance }: { allowance: AllowanceInsights }): JSX.Element {
  const { pointsPerUsd } = allowance.apportionment;
  return (
    <p className="sp-note">
      Apportioned, not measured. The account reports one percentage for the whole fleet, so a goal&rsquo;s share is its
      cost inside each interval between readings — never a figure the account attributed to it.
      {pointsPerUsd === null
        ? ' Nothing measured spent in this window, so there is no rate behind the split.'
        : ` The split rests on ${fmtPoints(pointsPerUsd)} of allowance per dollar over this window; it moves with the model mix.`}{' '}
      A reading arrives only when an agent takes a turn, so an idle stretch has none and your own Claude Code spends
      from the same account &mdash; which is what the unattributed segment is.
    </p>
  );
}

function lastAt(allowance: AllowanceInsights): string {
  return allowance.readings.at(-1)?.at ?? allowance.generatedAt;
}
