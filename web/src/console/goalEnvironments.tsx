import { useState, type JSX } from 'react';
import type { CockpitActions } from '../cockpit/actions.js';
import type { GoalPageView } from '../view/goalPage.js';
import { GOAL_ANCHOR, reachCount } from '../view/goalPage.js';
import { reachBands } from '../view/goalStages.js';
import type {
  EnvironmentGate,
  GoalReachStatus,
  GoalWatchCheckView,
  GoalWatchView,
  WatchCheckVerdict,
} from '../types.js';
import { AsyncButton } from '../components/AsyncButton.js';
import { GateReleaseModal } from '../components/GateReleaseModal.js';
import { Tag, type TagTone } from '../components/tag.js';
import { relTime } from '../components/util.js';
import { Button } from '../components/button.js';
import { Disclosure, type Fold } from './goalFold.js';

// → docs/spec/17-cockpit.md

export function Environments({
  page,
  actions,
  now,
  fold,
  only = null,
}: {
  page: GoalPageView;
  actions: CockpitActions;
  now: number;
  fold: Fold;
  /** Draw only this environment's row. The pane above picks it; null draws them all. */
  only?: string | null;
}): JSX.Element | null {
  const [releasing, setReleasing] = useState(false);
  if (page.environments.length === 0) return null;
  const number = page.issue.number;
  const bands = reachBands(page);
  /* Counted in places rather than in commands: three regions of production are one place,
     and a card reading "1/3 reached" for a group that has arrived nowhere would be counting
     the configuration instead of the deployment. */
  const reached = bands.filter((b) => b.status === 'reached').length;
  return (
    <section className="cn-card" id={GOAL_ANCHOR.environments}>
      <h3>
        <Disclosure open={fold.open} onToggle={fold.onToggle} label="Environments" />
        {/* The count folded away is the whole reading: a card shut on "0/3
            reached" says what the rows would have, and one shut on "2/3" is the
            reason to open it. */}
        <i className="cn-n">
          {reached}/{bands.length} reached
        </i>
      </h3>
      {fold.open && <EnvironmentRows page={page} only={only} />}
      {/* The hold, said out loud. Drawn whether or not the card is folded, for the
          reason it is drawn at all: nothing is filed while a gate holds, so a
          delivered goal with an empty bench is indistinguishable from a finished
          one, and a fold is not a reason to stop saying so. Nothing is filed while a gate holds, so without
          The control beside it is the escape for work that is never going to
          reach an environment at all. */}
      {page.gateHold !== null && (
        <div className="cn-criteria">
          <p>{page.gateHold}</p>
          <Button ghost onClick={() => setReleasing(true)}>
            not waiting on an environment
          </Button>
        </div>
      )}
      {page.gateRelease !== null && (
        <div className="cn-criteria">
          <p>
            Not waiting on an environment — “{page.gateRelease.note}”
            <span className="cn-sub"> · {relTime(page.gateRelease.releasedAt, now)}</span>
          </p>
          <Button ghost onClick={() => void actions.releaseEnvironmentGate(number, false)}>
            wait for one after all
          </Button>
        </div>
      )}
      {releasing && page.gateHold !== null && (
        <GateReleaseModal
          issueNumber={number}
          issueTitle={page.issue.title}
          hold={page.gateHold}
          onSubmit={(note) => actions.releaseEnvironmentGate(number, true, note)}
          onClose={() => setReleasing(false)}
        />
      )}
    </section>
  );
}

function EnvironmentRows({ page, only }: { page: GoalPageView; only: string | null }): JSX.Element {
  const grouped = new Set(page.groups.flatMap((g) => g.environments));
  const rows = only == null ? page.environments : page.environments.filter((e) => e.environment === only);
  /* A band is drawn only where one of its environments is: the pane that picks a single
     environment is asking about that one, and a group heading over nothing is a place the
     card claims to be saying something about. */
  const shown = new Set(rows.map((e) => e.environment));
  const groups = page.groups.filter((g) => g.environments.some((name) => shown.has(name)));
  return (
    <div className="cn-rows">
      {groups.map((group) => (
        <div className="cn-env cn-env-group" key={`group:${group.group}`}>
          <div className="cn-row">
            <span className="cn-grow">
              <b className="cn-name">{group.group}</b>
              <span className="cn-sub">
                {REACH_SAID[group.status]}
                {group.opens.length > 0 && ` · opens ${group.opens.map((g) => GATE_SAID[g]).join(' and ')}`}
                {` · ${group.environments.join(', ')}`}
              </span>
            </span>
            {group.status !== 'reached' && (
              <i className="cn-n">
                {group.landed}/{group.total}
              </i>
            )}
            <Tag tone={REACH_TONE[group.status]} fill={REACH_TONE[group.status] !== undefined}>
              {group.status}
            </Tag>
          </div>
        </div>
      ))}
      {rows.map((env) => (
        <div className={`cn-env${grouped.has(env.environment) ? ' cn-env-member' : ''}`} key={env.environment}>
          <div className="cn-row">
            <span className="cn-grow">
              <b className="cn-name">{env.environment}</b>
              <span className="cn-sub">
                {REACH_SAID[env.status]}
                {/* What arriving here does, on the row that would do it. An
                    operator reading a held goal asks "waiting for what" exactly
                    once, and the answer is configuration they wrote weeks ago. */}
                {env.opens.length > 0 && ` · opens ${env.opens.map((g) => GATE_SAID[g]).join(' and ')}`}
                {/* Folded on the server, off the same rows the sheet card above draws. Worked
                        out here instead it would be a second opinion beside the reading it
                        describes. → 36-remote-validation.md#the-cockpit */}
                {env.sheet !== null && ` · ${env.sheet}`}
              </span>
            </span>
            {(env.status !== 'reached' || env.unplaced > 0) && <i className="cn-n">{reachCount(env)}</i>}
            <Tag tone={REACH_TONE[env.status]} fill={REACH_TONE[env.status] !== undefined}>
              {env.status}
            </Tag>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The window one environment's arrival opened, as a card of its own on the pane that *is*
 * that obligation. It was drawn inside the environment's own row while the environments and
 * the watch shared a pane, so that the two surfaces could not disagree about which
 * environment a reading came from; the heading carries that now — a watch reading is never
 * drawn without the environment it was read in.
 * → docs/spec/29-post-deploy-watch.md#in-the-cockpit
 */
export function WatchWindow({
  watch,
  environment,
  issueNumber,
  now,
  actions,
}: {
  watch: GoalWatchView | undefined;
  /** The environment this pane is showing — named even where its window has not opened. */
  environment: string | null;
  issueNumber: number;
  now: number;
  actions: CockpitActions;
}): JSX.Element | null {
  if (environment === null) return null;
  return (
    <section className="cn-card" id="cn-watch">
      <h3>
        Watch · {environment}
        <span className="cn-more">
          asked of {environment} for as long as the window this goal&rsquo;s arrival opened
        </span>
      </h3>
      {watch === undefined || watch.checks.length === 0 ? (
        /* Not an empty list of readings: a window that never opened and one that opened and
           read nothing are different answers, and only the second is about the work. */
        <p className="cn-sub">No window has opened here — nothing of this goal has arrived in {environment} yet.</p>
      ) : (
        <Watch watch={watch} issueNumber={issueNumber} now={now} actions={actions} />
      )}
    </section>
  );
}

function Watch({
  watch,
  issueNumber,
  now,
  actions,
}: {
  watch: GoalWatchView;
  issueNumber: number;
  now: number;
  actions: CockpitActions;
}): JSX.Element {
  return (
    <div className="cn-watch">
      <span className="cn-watch-head">
        {watch.settledAt === null
          ? `watching until ${relTime(watch.settlesAt, now)}`
          : `settled ${relTime(watch.settledAt, now)}`}
        {/* Said whether it is open or settled: an extension is why a window's end
            is not the one the arrival sized, and without it the card states a
            length nothing in the configuration would produce. */}
        {watch.extendedAt !== null && ` · extended ${relTime(watch.extendedAt, now)}`}
        {/* The honest answer for a window that closed before the weekly job ran.
            It re-opens this window rather than opening a second one, so the
            readings below stay where they are — and it is a click because putting
            a settled verdict back in play is not a thing the harness decides. */}
        <AsyncButton
          className="cn-watch-more"
          onClick={() => actions.extendWatch(issueNumber, watch.environment)}
          title={
            watch.settledAt === null
              ? 'Give this window more time — it runs on from now for this environment’s own window length'
              : 'Re-open this settled window and watch on from now. The readings it already took stay where they are.'
          }
        >
          extend
        </AsyncButton>
      </span>
      {watch.checks.map((check) => (
        <div className={`cn-watch-row ${check.reading?.verdict ?? 'unread'}`} key={check.checkId}>
          <span className="cn-grow">
            <b className="cn-name">{check.title}</b>
            {/* An `unknown` says why, in words, and never in the vocabulary of a
                clean one: a failed observation, a timeout and a presence query
                answering zero are the watch failing to *read* the environment, and
                only a reading that came back can say anything about the work. */}
            <span className="cn-sub">{watchSaid(check)}</span>
          </span>
          <Tag
            tone={WATCH_TONE[check.reading?.verdict ?? 'unread']}
            fill={WATCH_TONE[check.reading?.verdict ?? 'unread'] !== undefined}
          >
            {check.reading?.verdict ?? 'not read'}
          </Tag>
        </div>
      ))}
    </div>
  );
}

function watchSaid(check: GoalWatchCheckView): string {
  const reading = check.reading;
  if (reading === null) return 'Not yet put to this environment. Nothing has been read.';
  if (reading.detail !== null) return reading.detail;
  if (check.kind === 'measure') return measureSaid(check, reading.value);
  return check.tolerate === 0
    ? 'No matching rows at all, which is what it declared.'
    : `${String(reading.rows ?? 0)} matching rows, within the ${String(check.tolerate)} it declared.`;
}

function measureSaid(check: GoalWatchCheckView, value: number | null): string {
  const unit = check.unit === null ? '' : ` ${check.unit}`;
  const expected: string[] = [];
  if (check.expectUnder !== null) expected.push(`under ${String(check.expectUnder)}${unit}`);
  if (check.expectOver !== null) expected.push(`over ${String(check.expectOver)}${unit}`);
  if (check.expectBaseline) expected.push('no worse than its baseline');
  const before = check.baselineValue === null ? 'before: never taken' : `before ${String(check.baselineValue)}${unit}`;
  const now = value === null ? 'now: nothing read' : `now ${String(value)}${unit}`;
  return `Expected ${expected.join(' and ')} · ${before} · ${now}.`;
}

const WATCH_TONE: Record<WatchCheckVerdict | 'unread', TagTone | undefined> = {
  clean: 'green',
  regressed: 'red',
  unknown: 'amber',
  unread: undefined,
};

const GATE_SAID: Record<EnvironmentGate, string> = {
  validate: 'the checks',
  close_out: 'the close-out',
};

export const REACH_TONE: Record<GoalReachStatus, TagTone | undefined> = {
  reached: 'green',
  partial: 'red',
  unknown: 'amber',
  absent: undefined,
};

const REACH_SAID: Record<GoalReachStatus, string> = {
  reached: 'all of this goal’s work is here',
  partial: 'some of this goal’s work is here',
  absent: 'none of this goal’s work is here yet',
  unknown: 'nothing here could be confirmed — check the probe, not the deploy',
};
