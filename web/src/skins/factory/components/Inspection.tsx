import type { JSX } from 'react';
import type { PullRequest, Stack, StackLandingView } from '../../../types.js';
import { refLink } from '../../../components/util.js';
import { Icon } from './Sprite.js';
import { AsyncButton } from '../../../components/AsyncButton.js';
import { conditionGlyph, ladderFor, loadedCount, prCourt, rack, rackReason } from '../inspection.js';
import { clip } from '../vocabulary.js';
import type { Scanner } from '../scanners.js';
import type { MergeGate } from '../inspection.js';

/**
 * Parts Inspection: every open pull request as one row.
 *
 * Two groups, and the split is `attention.status` — your court first, everything
 * else below and dimmed. Neither group collapses: a fold would put a second click
 * between an operator and *is anything stuck*, and one glance is the whole claim
 * this panel makes.
 */

/**
 * The ladder. Scanners on the left in a track of fixed width, the three human gates
 * on the right at a fixed x.
 *
 * The left group's cells **share** their track — three checks give three fat cells
 * and nine give nine thin ones — so a repository with a big CI matrix does not push
 * the gates out of column, and the strip stays readable downward. That is why the
 * scanners are a flex row inside a grid cell rather than grid columns of their own.
 *
 * Every cell's title is its own sentence, so the shape is scannable and the detail
 * is one hover away. The names come off the verdict; none is written here.
 */
function Ladder({ scanners, gates }: { scanners: Scanner[]; gates: MergeGate[] }): JSX.Element {
  const met = gates.filter((g) => g.met).length;
  const green = scanners.filter((s) => s.state === 'pass').length;
  return (
    <span
      className="fx-lad"
      role="img"
      aria-label={`${green} of ${scanners.length} checks passing, ${met} of ${gates.length} merge gates met`}
    >
      <span className="fx-lad-scan">
        {scanners.map((s) => (
          <i key={s.name} className={s.state} title={`${s.name} — ${s.status.word}`} />
        ))}
      </span>
      <i className="fx-lad-div" />
      {gates.map((g) => (
        <i key={g.label} className={g.met ? 'pass' : 'unmet'} title={`${g.label} — ${g.met ? 'met' : 'not met'}`} />
      ))}
    </span>
  );
}

function Row({
  pr,
  refUrls,
  inHand,
  ignoreLabel,
  onToggleExclude,
}: {
  pr: PullRequest;
  refUrls: Record<string, string>;
  inHand: boolean;
  ignoreLabel: string;
  onToggleExclude: (prNumber: number, excluded: boolean) => void;
}) {
  const court = prCourt(pr);
  const ladder = ladderFor(pr);
  const reason = rackReason(pr);
  const glyph = conditionGlyph(reason);
  // The stripe is the row's own severity, and it is read from the group — the
  // function that already answers "is this yours" — never from the court chip's
  // colour. Inferring it from a tone made a palette change able to un-stripe every
  // row needing a decision.
  const tone = inHand ? '' : pr.attention?.status === 'stalled' ? ' stalled' : ' you';
  const isExcluded = (pr.labels ?? []).includes(ignoreLabel);
  return (
    <div className={`fx-part${inHand ? ' hand' : ''}${tone}`}>
      <span className="fx-part-stripe" />
      <Ladder scanners={ladder.scanners} gates={ladder.gates} />
      <span className="fx-ref">{refLink(`#${pr.number}`, refUrls)}</span>
      <p className="fx-job" title={pr.title}>
        {clip(pr.title, 60)}
      </p>
      {/* The glyph leads the sentence the server wrote; the sentence is unchanged and
          still the full reading, in the `title` when the 34ch track truncates it. The
          cap here is the track, not a count — a row with four conditions shows what
          fits, exactly as it does today. The sentence keeps its own span so the
          ellipsis still lands on it now the cell is a flex row. */}
      <span className="fx-part-why" title={reason}>
        {glyph && <Icon name={glyph} className="sm" />}
        <span className="fx-part-said">{reason}</span>
      </span>
      <span className={`fx-court ${court.tone}`}>{court.label}</span>
      {/* The watch/ignore toggle — the same label write `WorldSummary` carries in
          the classic skin, restored here because the factory skin draws PRs on the
          rack instead of in The Yard, so this is their only home. Disabled with no
          configured ignore label (the gate is off), for the reason the button reads
          nothing to toggle. */}
      {!pr.merged && (
        <AsyncButton
          className="ghost fx-part-toggle"
          disabled={ignoreLabel === ''}
          onClick={() => onToggleExclude(pr.number, !isExcluded)}
          title={
            ignoreLabel === ''
              ? 'No ignore label configured — the watch/ignore gate is off'
              : isExcluded
                ? `Remove the "${ignoreLabel}" tag and let the harness work this PR again`
                : `Tag this PR "${ignoreLabel}" so the harness leaves it alone (for a PR blocked on something it can't fix)`
          }
        >
          {isExcluded ? 'watch' : 'ignore'}
        </AsyncButton>
      )}
    </div>
  );
}

/**
 * A stack, on the rack.
 *
 * Drawn here rather than as a belt on the line because a stack is a fact about
 * *pull requests*, and the rack is where pull requests are read — a belt would
 * have said it was a fact about scheduling, which is the confusion the plan panel
 * already risks by drawing parts as a stack.
 *
 * Rungs are listed top-first, with the one that merges next at the bottom, and the
 * base of each named beneath it so the chain is legible without the reader holding
 * branch names in their head.
 */
function StackRun({
  stack,
  landing,
  refUrls,
  onLand,
}: {
  stack: Stack;
  /** The control's state for this chain, as the server decided it. Absent on an older snapshot. */
  landing: StackLandingView | undefined;
  refUrls: Record<string, string>;
  onLand: (ref: string, land: boolean) => void;
}): JSX.Element {
  const topFirst = [...stack.rungs].reverse();
  const intent = landing?.landing ?? null;
  const standing = intent?.status === 'standing';
  const stopped = intent?.status === 'stopped';
  return (
    <div className={`fx-stack${standing ? ' landing' : ''}${stopped ? ' stopped' : ''}`}>
      <p className="fx-stack-head">
        {stack.issueNumber !== null && refLink(`#${stack.issueNumber}`, refUrls)}{' '}
        <span>{stack.issueTitle ?? 'Stacked pull requests'}</span>
        <span className="fx-stack-ref">
          {stack.planId ? 'from plan' : 'observed'} · {stack.rungs.length} PRs
        </span>
        {/* The click's whole effect arrives over the next several cycles, so the head
            line has to carry it: without a standing state the button reads as having
            done nothing. The count is the intent's own — the derived stack shrinks as
            rungs land, so it cannot supply the denominator. */}
        {intent && (
          <span className={`fx-stack-state ${standing ? 'landing' : 'stopped'}`}>
            {standing ? '◆ landing' : '▲ stopped'} · {landing?.landed ?? 0} of {intent.rungs.length}
          </span>
        )}
        {standing ? (
          <AsyncButton
            className="ghost fx-stack-land"
            onClick={() => onLand(stack.ref, false)}
            title="Stop landing this stack — nothing further merges without you"
          >
            stop
          </AsyncButton>
        ) : (
          <AsyncButton
            className="ghost fx-stack-land"
            disabled={!landing?.offer}
            onClick={() => onLand(stack.ref, true)}
            title={
              landing?.offer
                ? 'Merge this whole chain bottom-up, one rung per cycle, without asking again'
                : `Every rung must be green first — ${landing?.blockedBy ?? 'a rung is not ready'}`
            }
          >
            land the stack
          </AsyncButton>
        )}
      </p>
      {/* Why the button is withheld, or why the chain stopped — in the server's own
          words. A disabled control that says nothing is one an operator can only
          guess at, and guessing is what a stop must never leave them doing. */}
      {(stopped || (!standing && landing && !landing.offer)) && (
        <p className="fx-stack-why">{stopped ? intent?.reason : landing?.blockedBy}</p>
      )}
      <div className="fx-stack-rungs">
        {topFirst.map((rung) => (
          <div key={rung.prNumber} className={`fx-stack-rung${rung.position === 1 ? ' bottom' : ''}`}>
            <span className="fx-stack-pos">{rung.position}</span>
            {refLink(`#${rung.prNumber}`, refUrls)}
            <span className="fx-stack-title">{rung.title}</span>
            <span className="fx-stack-base">&rarr; {rung.base}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Inspection({
  prs,
  closed,
  stacks,
  stackLandings,
  refUrls,
  ignoreLabel,
  onToggleExclude,
  onLandStack,
}: {
  prs: PullRequest[];
  closed: PullRequest[];
  /** Chains of stacked PRs, drawn on the rack because a stack is a fact about pull requests. */
  stacks: Stack[];
  /** The "land the stack" control's state per chain — offered, standing, or stopped. */
  stackLandings: StackLandingView[];
  refUrls: Record<string, string>;
  ignoreLabel: string;
  onToggleExclude: (prNumber: number, excluded: boolean) => void;
  onLandStack: (ref: string, land: boolean) => void;
}): JSX.Element {
  const { yours, inHand } = rack(prs);
  const loaded = loadedCount(closed);

  return (
    <div className="fx-rack">
      {/* Empty still draws. A surface that vanishes when quiet is indistinguishable
          from one that broke — the rule the fault gauge is kept muted-but-present for. */}
      {prs.length === 0 && <p className="fx-empty">Nothing on the rack — no open pull requests.</p>}

      {yours.length > 0 && (
        <>
          <p className="fx-sub">Your court · {yours.length}</p>
          <div className="fx-parts">
            {yours.map((pr) => (
              <Row
                key={pr.id}
                pr={pr}
                refUrls={refUrls}
                inHand={false}
                ignoreLabel={ignoreLabel}
                onToggleExclude={onToggleExclude}
              />
            ))}
          </div>
        </>
      )}

      {inHand.length > 0 && (
        <>
          <p className="fx-sub">In hand · {inHand.length}</p>
          <div className="fx-parts">
            {inHand.map((pr) => (
              <Row
                key={pr.id}
                pr={pr}
                refUrls={refUrls}
                inHand
                ignoreLabel={ignoreLabel}
                onToggleExclude={onToggleExclude}
              />
            ))}
          </div>
        </>
      )}

      {stacks.length > 0 && (
        <>
          <p className="fx-sub">Stacked &middot; {stacks.length}</p>
          {stacks.map((stack) => (
            <StackRun
              key={stack.ref}
              stack={stack}
              landing={stackLandings.find((l) => l.ref === stack.ref)}
              refUrls={refUrls}
              onLand={onLandStack}
            />
          ))}
        </>
      )}

      {prs.length > 0 && (
        <p className="fx-lad-key">
          <span>
            <i className="pass" /> passing
          </span>
          <span>
            <i className="damaged" /> failing · a bot is coming
          </span>
          <span>
            <i className="not_ours" /> failing · policy holds it
          </span>
          <span>
            <i className="muted" /> muted by policy
          </span>
          <span>
            <i className="awaiting" /> not reported yet
          </span>
          <span className="fx-lad-key-tail">checks · then approved · comments · conflicts</span>
        </p>
      )}
      {loaded > 0 && (
        <p className="fx-empty">
          {loaded} part{loaded === 1 ? '' : 's'} loaded into the silo in the retained window.
        </p>
      )}
    </div>
  );
}
