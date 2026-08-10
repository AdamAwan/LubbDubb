import type { JSX } from 'react';
import type { PullRequest, Stack } from '../../../types.js';
import { refLink } from '../../../components/util.js';
import { Icon } from './Sprite.js';
import { AsyncButton } from '../../../components/AsyncButton.js';
import {
  conditionGlyph,
  ladderFor,
  loadedCount,
  prCourt,
  rackCount,
  rackEntries,
  rackGroup,
  rackReason,
} from '../inspection.js';
import { clip } from '../vocabulary.js';
import type { Scanner } from '../scanners.js';
import type { MergeGate, RackEntry, RackRung } from '../inspection.js';

/**
 * Parts Inspection: every open pull request as one row.
 *
 * Two groups, and the split is `attention.status` — your court first, everything
 * else below and dimmed. Neither group collapses: a fold would put a second click
 * between an operator and *is anything stuck*, and one glance is the whole claim
 * this panel makes.
 *
 * A stack is drawn **in** those groups rather than in a list beneath them, as a
 * bracketed run of the same rows. It was a section of its own once, and the cost
 * was that the rows an operator most needed the ladder and the watch/ignore toggle
 * on were the only rows that had neither.
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
  ignoreLabel,
  onToggleExclude,
  position,
  note,
  noteTone,
}: {
  pr: PullRequest;
  refUrls: Record<string, string>;
  ignoreLabel: string;
  onToggleExclude: (prNumber: number, excluded: boolean) => void;
  /** The rung's 1-based position, when this row is a rung. Drawn inside the ref cell. */
  position?: number;
  /** The rung's second line. Present only on a rung, and only when it has something to say. */
  note?: string;
  noteTone?: 'clear' | 'held';
}) {
  const court = prCourt(pr);
  const ladder = ladderFor(pr);
  const reason = rackReason(pr);
  const glyph = conditionGlyph(reason);
  // The stripe and the recess are the row's **own** severity, read from `rackGroup`
  // — the function that already answers "is this yours" — never from the court
  // chip's colour, and never from the heading the row happens to sit under. Taking
  // it from the heading was fine while a heading was the only way a row got there;
  // a stack goes whole to the group of its most urgent rung, so a queued rung would
  // wear the red stripe of the one below it. Inferring it from a tone, likewise,
  // made a palette change able to un-stripe every row needing a decision.
  const inHand = rackGroup(pr) === 'in_hand';
  const tone = inHand ? '' : pr.attention?.status === 'stalled' ? ' stalled' : ' you';
  const isExcluded = (pr.labels ?? []).includes(ignoreLabel);
  return (
    <div className={`fx-part${inHand ? ' hand' : ''}${tone}${position === undefined ? '' : ' rung'}`}>
      <span className="fx-part-stripe" />
      <Ladder scanners={ladder.scanners} gates={ladder.gates} />
      <span className="fx-ref">
        {position !== undefined && <span className="fx-part-pos">{position}</span>}
        {refLink(`#${pr.number}`, refUrls)}
      </span>
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
      {/* The rung's second line, and a grid item of its own so it spans the title and
          why columns rather than squeezing into either. Absent on every unstacked row,
          which is why the row's track count is unchanged off the rack's stacked runs. */}
      {note !== undefined && <span className={`fx-part-note ${noteTone ?? 'held'}`}>{note}</span>}
    </div>
  );
}

/**
 * A rung the snapshot carries no pull request for.
 *
 * `buildStacks` runs on the unfiltered open list so an `-ignore`d rung cannot put a
 * hole in the chain, which means the rack can be handed a rung it has no PR for. It
 * draws from the rung's own fields and asserts no health it does not have — the same
 * rule `conditionGlyph` follows in returning null rather than a confident glyph.
 */
function GhostRung({ rung, note }: { rung: RackRung; note: string }): JSX.Element {
  return (
    <div className="fx-part hand rung ghost">
      <span className="fx-part-stripe" />
      <span className="fx-lad" />
      <span className="fx-ref">
        <span className="fx-part-pos">{rung.rung.position}</span>#{rung.rung.prNumber}
      </span>
      <p className="fx-job" title={rung.rung.title}>
        {clip(rung.rung.title, 60)}
      </p>
      <span className="fx-part-why" />
      <span className="fx-court off">Not in this view</span>
      <span />
      <span className="fx-part-note held">{note}</span>
    </div>
  );
}

/**
 * The second line under a rung: where it targets, and what is in front of it.
 *
 * The base is here rather than on the head because it is a fact about the rung, and
 * "waiting on #N" names the nearest rung below still holding — read off the same
 * `ladderFor` the row above it draws, so the note and the ladder cannot disagree.
 */
function rungNote(r: RackRung, bottom: boolean): { text: string; tone: 'clear' | 'held' } {
  const base = `→ ${r.rung.base}`;
  if (r.blockedBy !== null) return { text: `${base} · waiting on #${r.blockedBy} below`, tone: 'held' };
  if (bottom && r.clear) return { text: `${base} · next to merge`, tone: 'clear' };
  return { text: base, tone: 'held' };
}

/**
 * A stack, on the rack, as a bracketed run of ordinary rows.
 *
 * Drawn here rather than as a belt on the line because a stack is a fact about
 * *pull requests*, and the rack is where pull requests are read — a belt would
 * have said it was a fact about scheduling, which is the confusion the plan panel
 * already risks by drawing parts as a stack.
 *
 * Rungs are listed top-first, with the one that merges next at the bottom. They are
 * the *same* `Row` every other part gets, because a rung **is** a pull request and
 * an operator reading it in two places must not get two accounts of it — which is
 * the rule the old thin rung list broke by having no ladder, no court chip and no
 * watch/ignore toggle on precisely the parts most likely to be stuck.
 */
function StackCluster({
  entry,
  refUrls,
  ignoreLabel,
  onToggleExclude,
}: {
  entry: Extract<RackEntry, { kind: 'stack' }>;
  refUrls: Record<string, string>;
  ignoreLabel: string;
  onToggleExclude: (prNumber: number, excluded: boolean) => void;
}): JSX.Element {
  const { stack, rungs } = entry;
  const topFirst = [...rungs].reverse();
  return (
    <div className="fx-stack">
      <p className="fx-stack-head">
        {stack.issueNumber !== null && refLink(`#${stack.issueNumber}`, refUrls)}{' '}
        <span>{stack.issueTitle ?? 'Stacked pull requests'}</span>
        <span className="fx-stack-ref">
          {stack.planId ? 'from plan' : 'observed'} · {stack.rungs.length} PRs · merges bottom-up
        </span>
      </p>
      <div className="fx-stack-rungs">
        {topFirst.map((r) => {
          const note = rungNote(r, r.rung.position === 1);
          return r.pr ? (
            <Row
              key={r.rung.prNumber}
              pr={r.pr}
              refUrls={refUrls}
              ignoreLabel={ignoreLabel}
              onToggleExclude={onToggleExclude}
              position={r.rung.position}
              note={note.text}
              noteTone={note.tone}
            />
          ) : (
            <GhostRung key={r.rung.prNumber} rung={r} note={note.text} />
          );
        })}
      </div>
    </div>
  );
}

/** One entry, whichever kind it is. */
function Entry({
  entry,
  refUrls,
  ignoreLabel,
  onToggleExclude,
}: {
  entry: RackEntry;
  refUrls: Record<string, string>;
  ignoreLabel: string;
  onToggleExclude: (prNumber: number, excluded: boolean) => void;
}): JSX.Element {
  return entry.kind === 'stack' ? (
    <StackCluster entry={entry} refUrls={refUrls} ignoreLabel={ignoreLabel} onToggleExclude={onToggleExclude} />
  ) : (
    <Row pr={entry.pr} refUrls={refUrls} ignoreLabel={ignoreLabel} onToggleExclude={onToggleExclude} />
  );
}

export function Inspection({
  prs,
  closed,
  stacks,
  refUrls,
  ignoreLabel,
  onToggleExclude,
}: {
  prs: PullRequest[];
  closed: PullRequest[];
  /** Chains of stacked PRs, drawn on the rack because a stack is a fact about pull requests. */
  stacks: Stack[];
  refUrls: Record<string, string>;
  ignoreLabel: string;
  onToggleExclude: (prNumber: number, excluded: boolean) => void;
}): JSX.Element {
  const { yours, inHand } = rackEntries(prs, stacks);
  const loaded = loadedCount(closed);

  return (
    <div className="fx-rack">
      {/* Empty still draws. A surface that vanishes when quiet is indistinguishable
          from one that broke — the rule the fault gauge is kept muted-but-present for. */}
      {prs.length === 0 && <p className="fx-empty">Nothing on the rack — no open pull requests.</p>}

      {/* The counts are pull requests, not entries — a three-rung stack under this
          heading is three parts to read, and counting it as one would understate the
          only number the heading is there to give. */}
      {yours.length > 0 && (
        <>
          <p className="fx-sub">Your court · {rackCount(yours)}</p>
          <div className="fx-parts">
            {yours.map((entry) => (
              <Entry
                key={entry.kind === 'stack' ? entry.stack.ref : entry.pr.id}
                entry={entry}
                refUrls={refUrls}
                ignoreLabel={ignoreLabel}
                onToggleExclude={onToggleExclude}
              />
            ))}
          </div>
        </>
      )}

      {inHand.length > 0 && (
        <>
          <p className="fx-sub">In hand · {rackCount(inHand)}</p>
          <div className="fx-parts">
            {inHand.map((entry) => (
              <Entry
                key={entry.kind === 'stack' ? entry.stack.ref : entry.pr.id}
                entry={entry}
                refUrls={refUrls}
                ignoreLabel={ignoreLabel}
                onToggleExclude={onToggleExclude}
              />
            ))}
          </div>
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
