import type { JSX } from 'react';
import type { LessonInsights, LessonRow } from '../types.js';
import { relTime } from './util.js';
import { fmtShare } from './insightsFormat.js';
import { Ref } from './refs.js';
import { Tag, type TagTone } from './tag.js';
import { MethodNote } from './insightsMethod.js';

// → docs/spec/17-cockpit.md#causes, docs/spec/41-repo-lessons.md#did-it-work

const STATUS_TONE: Record<LessonRow['status'], TagTone> = {
  pending: 'grey',
  dispatched: 'blue',
  'pr-open': 'amber',
  adopted: 'green',
  declined: 'grey',
  filed: 'violet',
  nothing: 'grey',
  unanswered: 'red',
};

const VERDICT: Record<NonNullable<LessonRow['verdict']>, { label: string; tone: TagTone }> = {
  working: { label: 'working', tone: 'green' },
  'not-working': { label: 'not working', tone: 'red' },
  'too-early': { label: 'too early', tone: 'grey' },
};

export function Lessons({ lessons }: { lessons: LessonInsights }): JSX.Element {
  const adopted = lessons.drafts.filter((d) => d.status === 'adopted');
  return (
    <>
      <p className="sp-sub">Repo lessons, since lessons began</p>
      {adopted.length > 0 && (
        <table className="sp-tbl wide">
          <thead>
            <tr>
              <th>Did it work</th>
              <th>Merged</th>
              <th className="n">30 days before</th>
              <th className="n">30 days after</th>
              <th>Verdict</th>
            </tr>
          </thead>
          <tbody>
            {adopted.map((d) => (
              <tr key={d.id}>
                <td>
                  <LessonName lesson={d} />
                </td>
                <td>{d.mergedAt === null ? <span className="dim">&mdash;</span> : relTime(d.mergedAt)}</td>
                <td className="n">
                  <LessonPeriodCell period={d.before} fromRetros={d.fromRetros?.before ?? null} kind={d.kind} />
                </td>
                <td className="n">
                  <LessonPeriodCell period={d.after} fromRetros={d.fromRetros?.after ?? null} kind={d.kind} />
                </td>
                <td>{d.verdict !== null && <Tag tone={VERDICT[d.verdict].tone}>{VERDICT[d.verdict].label}</Tag>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <table className="sp-tbl wide">
        <thead>
          <tr>
            <th>Draft</th>
            <th>Status</th>
            <th>Fix</th>
            <th className="n">Goals</th>
            <th>Opened</th>
          </tr>
        </thead>
        <tbody>
          {lessons.drafts.map((d) => (
            <tr key={d.id}>
              <td>
                <LessonName lesson={d} />
              </td>
              <td>
                <Tag tone={STATUS_TONE[d.status]}>{d.status}</Tag>
              </td>
              <td>{d.fix ?? <span className="dim">&mdash;</span>}</td>
              <td className="n">{d.goals}</td>
              <td>{relTime(d.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="sp-note">
        {lessons.adopted} adopted &middot; {lessons.working} working &middot; {lessons.notWorking} not working &middot;{' '}
        {lessons.tooEarly} too early to tell
      </p>
      <LessonMethodNote />
    </>
  );
}

function LessonMethodNote(): JSX.Element {
  return (
    <MethodNote>
      <p>
        <b>Not windowed by the bar above.</b> Every draft is listed, and each adopted lesson is read over the 30 days
        either side of its merge, whatever window is chosen.
      </p>
      <p>
        <b>A miss is a goal, and the rate is misses per return dispatch of the same kind</b> &mdash; CI fixes for a CI
        lesson, review rounds and retrospectives written for a review one &mdash; so a busier month does not read as a
        worse one. A review lesson&rsquo;s misses include goals a retrospective recorded, counted as <i>from retros</i>.
        The after side stays empty until 30 days have passed since the merge.
      </p>
      <p>
        <b>Working</b> is no miss after the merge, or a lower rate than before. Anything else is <b>not working</b>: the
        miss keeps coming back with the lesson in place.
      </p>
    </MethodNote>
  );
}

function LessonName({ lesson }: { lesson: LessonRow }): JSX.Element {
  return (
    <>
      <span className="nm" title={lesson.groupKey}>
        {lesson.title ?? lesson.causeLabel}
      </span>
      <span className="bl mono">
        {lesson.kind} &middot; {lesson.where}
      </span>
      {lesson.prRef !== null && <Ref to={lesson.prRef} />}
      {lesson.ticketRef !== null && <Ref to={lesson.ticketRef} />}
    </>
  );
}

function LessonPeriodCell({
  period,
  fromRetros,
  kind,
}: {
  period: LessonRow['before'];
  fromRetros: number | null;
  kind: LessonRow['kind'];
}): JSX.Element {
  if (period === null || fromRetros === null) return <span className="dim">&mdash;</span>;
  const retros = fromRetros > 0 ? `, ${fromRetros} recorded by a retrospective` : '';
  return (
    <span
      title={`${period.misses} goal${period.misses === 1 ? '' : 's'} missed${retros}, in ${period.returns} return dispatches${kind === 'review' ? ' and retrospectives' : ''}`}
    >
      {period.misses} in {period.returns}
      {period.returns > 0 ? ` (${fmtShare(period.misses, period.returns)})` : ''}
      {fromRetros > 0 && <span className="bl"> {fromRetros} from retros</span>}
    </span>
  );
}
