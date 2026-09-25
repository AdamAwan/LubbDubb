import type { JSX } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { GoalPageView } from '../view/goalPage.js';
import { GOAL_ANCHOR } from '../view/goalPage.js';
import type { Issue } from '../types.js';
import { AsyncButton } from '../components/AsyncButton.js';
import { renderRichText } from '../components/richText.js';
import { fmtUsd } from '../components/util.js';
import { Ref } from '../components/refs.js';
import { waitingOnThis, waitsOn, waveOf, wavesOf } from '../view/sequence.js';
import { CONTROL_CLASS } from '../components/controls.js';
import { WorkRecord } from '../components/WorkRecord.js';
import { Disclosure, type Fold } from './goalFold.js';

// → docs/spec/17-cockpit.md

export function Instructions({ issue, actions }: { issue: Issue; actions: CockpitActions }): JSX.Element | null {
  if (issue.instructions.length === 0) return null;
  return (
    <section className="cn-card">
      <h3>
        What you’ve asked for <span className="cn-more">standing until an agent concludes this goal</span>
      </h3>
      <div className="cn-rows">
        {issue.instructions.map((instruction) => (
          <div className="cn-row" key={instruction.id}>
            <span className="cn-grow">
              <b className="cn-name">{instruction.text}</b>
              <span className="cn-sub">{instruction.createdAt}</span>
            </span>
            <AsyncButton
              className={CONTROL_CLASS}
              onClick={() => actions.withdrawInstruction(issue.number, instruction.id)}
              title="Take this back — it stops being sent to the next agent"
            >
              Withdraw
            </AsyncButton>
          </div>
        ))}
      </div>
    </section>
  );
}

export function Ticket({ issue, refUrls }: { issue: Issue; refUrls: Record<string, string> }): JSX.Element {
  return (
    <section className="cn-card" id="cn-ticket">
      <h3>
        The ticket
        <span className="cn-more">as it stood at pickup</span>
      </h3>
      <div className="cn-tick">
        {issue.body.trim() === '' ? <p className="cn-empty">The ticket has no description.</p> : null}
        {renderRichText(issue.body, refUrls)}
      </div>
    </section>
  );
}

export function Sequence({ page, fold }: { page: GoalPageView; fold: Fold }): JSX.Element | null {
  const sequence = page.sequence;
  const parent = page.issue.parent?.number;
  if (sequence === null || parent === undefined) return null;
  const me = page.issue.number;
  const waves = wavesOf([...new Set([me, ...sequence.edges.flatMap((e) => [e.issue, e.dependsOn])])], sequence.edges);
  const mine = waveOf(me, sequence.edges);
  const behind = waitsOn(me, sequence.edges);
  const ahead = waitingOnThis(me, sequence.edges);
  return (
    <section className="cn-card">
      <h3>
        <Disclosure open={fold.open} onToggle={fold.onToggle} label="Sequence" />
        <i className="cn-n">
          wave {mine + 1} of {waves.length}
          {ahead.length === 0 ? '' : ` · ${ahead.length} waiting on this`}
        </i>
        <span className="cn-refs">
          <Ref to={`issue:${parent}`} />
        </span>
      </h3>
      {fold.open && (
        <div className="cn-rows">
          {/* Either side of this goal, and nothing else: the whole order belongs
              on the Feature, and repeating it here would be a second list of the
              same stories with no way to act on it. */}
          <SequenceSide label="This waits on" issues={behind} empty="nothing — it is in the first wave" />
          <SequenceSide label="Waiting on this" issues={ahead} empty="nothing" />
        </div>
      )}
    </section>
  );
}

function SequenceSide({
  label,
  issues,
  empty,
}: {
  label: string;
  issues: readonly number[];
  empty: string;
}): JSX.Element {
  return (
    <div className="cn-row">
      <span className="cn-grow">
        <b className="cn-name">{label}</b>
        {issues.length === 0 ? (
          <span className="cn-sub">{empty}</span>
        ) : (
          <span className="cn-refs">
            {issues.map((n) => (
              <Ref key={n} to={`issue:${n}`} />
            ))}
          </span>
        )}
      </span>
    </div>
  );
}

export function Reference({ page, view, fold }: { page: GoalPageView; view: CockpitView; fold: Fold }): JSX.Element {
  const ref = `issue:${page.issue.number}`;
  return (
    <div className="cn-refs-foot">
      {/* Embedded exactly as the work tree and the launch desk are: it reaches its
          own route, which `console/` may not, but rendering a component that does
          is not reaching — the import ban is on `api.js` and still holds.

          Its disclosure is *its own* rather than one of ours, because the count in
          its heading is: only it knows how many nodes there are, and a heading
          drawn out here would either carry no count or carry a stale one. Folded
          away it also fetches nothing, which is what keeps "on open, never polled"
          true now that the card no longer opens with the page. */}
      <section className="cn-card">
        <WorkRecord goalRef={ref} now={view.now} open={fold.open} onToggle={fold.onToggle} />
      </section>
    </div>
  );
}

export function Spend({ issue }: { issue: Issue }): JSX.Element | null {
  const spend = issue.spend;
  if (spend === null) return null;
  return (
    <section className="cn-card">
      <h3>Spend</h3>
      <div className="cn-rows">
        <div className="cn-kv">
          <span>Total</span>
          <b>{fmtUsd(spend.costUsd)}</b>
        </div>
        <div className="cn-kv">
          <span>Agents</span>
          <b>{spend.agents}</b>
        </div>
        {/* Named separately because the row above says "Agents" and a local run is
            not one. The total already holds its money. */}
        {spend.localRuns > 0 && (
          <div className="cn-kv">
            <span>Local runs</span>
            <b>{spend.localRuns}</b>
          </div>
        )}
        <div className="cn-kv">
          <span>Tokens</span>
          <b>
            {spend.inputTokens}→{spend.outputTokens}
          </b>
        </div>
      </div>
    </section>
  );
}

export function Tail({ issue, actions, fold }: { issue: Issue; actions: CockpitActions; fold: Fold }): JSX.Element {
  const check = issue.delivery?.summary ?? issue.shortfall?.summary ?? null;
  return (
    <section className="cn-card" id={GOAL_ANCHOR.tail}>
      <h3>
        <Disclosure open={fold.open} onToggle={fold.onToggle} label="The tail" />
        <i className="cn-n">{issue.state === 'open' ? 'ticket open' : issue.state}</i>
      </h3>
      {fold.open && <TailRows issue={issue} check={check} actions={actions} />}
    </section>
  );
}

function TailRows({
  issue,
  check,
  actions,
}: {
  issue: Issue;
  check: string | null;
  actions: CockpitActions;
}): JSX.Element {
  const ref = `issue:${issue.number}`;
  return (
    <div className="cn-rows">
      <div className="cn-row">
        <i className={`cn-lamp ${check === null ? 'cn-off' : issue.delivery ? 'cn-run' : 'cn-wait'}`} />
        <span className="cn-grow">
          <b className="cn-name">Goal check</b>
          <span className="cn-sub">{check ?? 'has not run'}</span>
        </span>
      </div>
      <div className="cn-row">
        <i className={`cn-lamp ${issue.retrospective === null ? 'cn-off' : 'cn-run'}`} />
        <span className="cn-grow">
          <b className="cn-name">Write-up</b>
          <span className="cn-sub">{issue.retrospective?.summary ?? 'not written'}</span>
        </span>
        {issue.retrospective !== null && (
          <button type="button" className={CONTROL_CLASS} onClick={() => actions.viewRetro(ref)}>
            Read
          </button>
        )}
      </div>
      <div className="cn-row">
        <i className={`cn-lamp ${issue.state === 'open' ? 'cn-off' : 'cn-run'}`} />
        <span className="cn-grow">
          <b className="cn-name">Close the ticket</b>
          <span className="cn-sub">{issue.state === 'open' ? 'still open' : issue.state}</span>
        </span>
      </div>
      <div className="cn-row">
        <i className={`cn-lamp ${issue.scratchpad === null ? 'cn-off' : 'cn-run'}`} />
        <span className="cn-grow">
          <b className="cn-name">Notes</b>
          <span className="cn-sub">
            {issue.scratchpad === null ? 'nothing written' : `${issue.scratchpad.entries} entries`}
          </span>
        </span>
        {issue.scratchpad !== null && (
          <button type="button" className={CONTROL_CLASS} onClick={() => actions.viewScratchpad(ref)}>
            Open
          </button>
        )}
      </div>
    </div>
  );
}
