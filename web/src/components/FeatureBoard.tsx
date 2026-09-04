import { Fragment, useCallback, useEffect, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { api } from '../api.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { CockpitView } from '../view/viewModel.js';
import { Ref } from './refs.js';
import { AsyncButton } from './AsyncButton.js';
import { heldByAccepting, waitsOn, wavesOf } from '../view/sequence.js';
import { fmtUsd, relAge } from './util.js';
import type {
  FeatureBlockKind,
  FeatureBlockRow,
  FeatureBoardPayload,
  FeatureBriefing,
  FeatureChildRow,
  FeatureChildStanding,
  FeatureCounts,
  FeatureReach,
  FeatureReportRow,
  FeatureRollup,
  FeatureSequence,
  FeatureSummary,
  FeatureWorkingRow,
} from '../types.js';
import { HeadRow, Panel } from './panel.js';
import { Tag, type TagTone } from './tag.js';

/**
 * The feature board — the fleet's work read one tier up (issue #—).
 *
 * The tab exists because a fleet worked at the story level answers "is #583 done"
 * and never "how is the Environments work going", and the second question is the
 * one anybody outside the fleet actually asks. Everything here is a roll-up of
 * readings the harness already holds; the goal pages and the Tickets tab are one
 * click down and remain where an operator *acts*.
 *
 * **Fetched on open, never polled**, exactly as the Tickets tab is: `/api/features`
 * reads the whole mirror, and the cockpit's snapshot comes round every couple of
 * seconds.
 *
 * Two things it deliberately does not draw:
 *
 * - **No verdict about a Feature** — no "at risk", no "on track", no forecast date.
 *   Each would be a policy no config file states and no module owns, and a card
 *   asserting one would be exactly the second opinion `src/features/featureBoard.ts`
 *   is arranged to avoid. What it draws instead is {@link wantsYou}: a count of
 *   facts, phrased.
 * - **No age judgement.** `lastLandingAt` is drawn as an age and nothing is said
 *   about whether it is too old.
 *
 * It sits in `components/` rather than `console/` for the Tickets tab's reason: it
 * rides its own route, and **nothing under `console/` imports `api.js`** — asserted
 * structurally in `test/console.test.ts`. The console embeds it like any other
 * shared component. → `docs/spec/17-cockpit.md#layers`
 */
export function FeatureBoard({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const [board, setBoard] = useState<FeatureBoardPayload | null>(null);
  const [failed, setFailed] = useState(false);

  const read = useCallback(async () => {
    try {
      setBoard(await api.getFeatures());
    } catch {
      // The one refusal worth drawing: the route is gated on the same predicate the
      // tab is, so a 404 here means the deployment lost its board between the
      // snapshot and this fetch — a config change, live. Saying so beats a
      // spinner that never resolves.
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void read();
  }, [read]);

  if (failed) return <p className="muted">This deployment has no feature board.</p>;
  if (board === null) return <p className="muted">Reading the tracker’s hierarchy…</p>;

  const { features, orphans, unresolved } = board;
  if (features.length === 0 && orphans === null) {
    return (
      <p className="muted">
        {board.backfilling
          ? 'Still reading the tracker — the board fills as the first sweep lands.'
          : 'Nothing in the tracker hangs off a container yet.'}
      </p>
    );
  }

  return (
    <div className="cn-fb">
      <div className="cn-fb-head">
        <h2>Features</h2>
        <span className="cn-psub">
          {features.length} {features.length === 1 ? 'feature' : 'features'} · rolled up from the tracker’s hierarchy
          {board.backfilling ? ' · still filling' : ''}
        </span>
      </div>

      <Legend />

      {features.map((feature) => (
        <FeatureCard
          key={feature.number}
          feature={feature}
          view={view}
          actions={actions}
          onAnswered={() => void read()}
        />
      ))}

      {orphans !== null && (
        <Panel density="padded" className="cn-fb-card cn-fb-orphans">
          <div className="cn-fb-top">
            <h3>Work that rolls up nowhere</h3>
            <span className="cn-psub">the tracker says these hang off no container</span>
          </div>
          <Bar counts={orphans.counts} />
          <Counts counts={orphans.counts} />
          <p className="cn-fb-attn">
            {money(orphans.costUsd)} spent under no Feature — so every roll-up above understates its own.
          </p>
          <Briefing briefing={orphans.briefing} now={view.now} actions={actions} />
          {/* No order: the orphan bucket is not a Feature, and an order is a
              statement about the stories under one. */}
          <Children rows={orphans.children} total={orphans.counts.total} actions={actions} sequence={null} />
        </Panel>
      )}

      {unresolved > 0 && (
        // Its own line and never folded into the orphans, for the reason
        // `TicketRow.parent` is optional rather than nullable: "the tracker says
        // there is no parent" and "nobody could tell" are different facts, and the
        // second one drawn as the first is a board quietly asserting a hierarchy.
        <p className="cn-psub cn-fb-unresolved">
          {unresolved} {unresolved === 1 ? 'item’s' : 'items’'} parent link could not be read, so{' '}
          {unresolved === 1 ? 'it is' : 'they are'} counted nowhere above.
        </p>
      )}
    </div>
  );
}

function FeatureCard({
  feature,
  view,
  actions,
  onAnswered,
}: {
  feature: FeatureRollup;
  view: CockpitView;
  actions: CockpitActions;
  onAnswered: () => void;
}): JSX.Element {
  const now = view.now;
  const attention = wantsYou(feature, view);
  return (
    <Panel density="padded" className={`cn-fb-card${attention === null ? '' : ' cn-fb-wants'}`}>
      <div className="cn-fb-top">
        {/* The `f<slot>` class is the Tickets tab's own ladder, reused rather than
            re-declared: the slot is persisted per feature, so one Feature is one
            colour across both surfaces and a second ladder here would drift. */}
        <i className={`cn-fb-hue f${feature.slot}`} aria-hidden="true" />
        <h3>{feature.title}</h3>
        {/* Never inside the heading: a reference is drawn with `Ref` and a row that
            carries both draws its name as the control and the ref beside it.
            → docs/spec/17-cockpit.md#links */}
        <span className="cn-refs">
          <Ref to={`issue:${feature.number}`} />
        </span>
        {feature.workItemState !== null && <Tag>{feature.workItemState}</Tag>}
      </div>

      <Bar counts={feature.counts} />
      <Counts counts={feature.counts} />

      {attention !== null && <p className="cn-fb-attn">{attention}</p>}

      <Summary summary={feature.summary} now={now} />

      <Sequence feature={feature} view={view} onAnswered={onAnswered} />

      <Briefing briefing={feature.briefing} now={now} actions={actions} />

      <div className="cn-fb-side">
        {feature.reach.length > 0 && <Reach reach={feature.reach} />}
        <span className="cn-fb-reading">
          <b>Spend</b> {money(feature.costUsd)}
        </span>
        <span className="cn-fb-reading">
          <b>Last landing</b>{' '}
          {feature.lastLandingAt === null ? <i className="cn-fb-never">never</i> : relAge(feature.lastLandingAt, now)}
        </span>
      </div>

      <Children rows={feature.children} total={feature.counts.total} actions={actions} sequence={held(feature)} />
    </Panel>
  );
}

/**
 * Where this Feature is, in the words of the agent rule `feature-summary` sent to
 * say so.
 *
 * **Quoted whole, and it is the only prose on the card.** The lists below it are
 * evidence — one sentence each, from the person or agent who wrote it, about one
 * goal — and this is the one reading that is *about the Feature*. It sits above
 * them because it is the answer to the question the card is opened with, exactly
 * as the briefing sits above the child rows for the same reason.
 *
 * Four blocks rather than a paragraph, because they are four questions and a
 * reader must not have to find each one inside prose. A block whose field came
 * back null is **absent**, never an empty heading: nothing usable yet, nothing
 * blocked and nothing left are ordinary states, and the summary's own lede is
 * where an agent says so.
 *
 * Absent entirely on a Feature nobody has summarised yet, which is every Feature
 * on the pulse after this ships and any whose summariser has not landed. The
 * board beneath is unchanged by its absence — nothing here gates anything.
 * → docs/spec/17-cockpit.md#the-feature-summary
 */
/**
 * The order that is actually holding work, or null.
 *
 * Only `accepted` groups the children into waves. A proposal nobody has answered
 * holds nothing, so drawing the list under it as though it did would show an
 * operator the shape of a decision they have not taken — and a declined order is
 * one they have taken the other way.
 */
function held(feature: FeatureRollup): FeatureSequence | null {
  return feature.sequence?.status === 'accepted' ? feature.sequence : null;
}

/**
 * The order the stories under this Feature go in — the proposal while nobody has
 * answered it, and the one line that says so once somebody has.
 *
 * The **waves themselves are not drawn here**. They group the children list that
 * is already on the card ({@link Children}), because a second list of the same
 * stories in a different order is two answers to "what is under this Feature" and
 * a reader would have to work out which one to believe.
 *
 * A Feature with no order draws none of this, which is every Feature until
 * `issueSequencing` is switched on. → `docs/spec/33-story-sequencing.md#the-cockpit`
 */
function Sequence({
  feature,
  view,
  onAnswered,
}: {
  feature: FeatureRollup;
  view: CockpitView;
  onAnswered: () => void;
}): JSX.Element | null {
  const sequence = feature.sequence;
  if (sequence === null) return null;
  const open = feature.children.map((c) => c.number);
  const waves = wavesOf(open, sequence.edges);

  if (sequence.status !== 'proposed') {
    // Answered, either way: one line, because the answer's whole consequence is
    // already visible — an accepted order is the wave rail below, and a declined
    // one is its absence. Said rather than left silent so an operator can see the
    // fleet is not going to ask again.
    return (
      <p className="cn-psub cn-fb-seq-said">
        {sequence.status === 'accepted'
          ? `Order accepted — ${waves.length} wave${waves.length === 1 ? '' : 's'}`
          : 'You said run them all — the fleet will not propose an order again until this Feature gains or loses a story'}
        {sequence.answeredBy === null ? '' : ` · ${sequence.answeredBy}`}
      </p>
    );
  }

  const wouldHold = heldByAccepting(open, sequence.edges);
  return (
    <div className="cn-fb-seq">
      <h4>Proposed order</h4>
      <p className="cn-fb-seq-why">{sequence.reason}</p>
      {sequence.unsure !== null && (
        // The edge it would most like argued with. `openQuestions`' job on the plan
        // document: an order with no stated doubt is one nobody can disagree with
        // usefully, and somebody is being asked to accept this one.
        <p className="cn-fb-seq-unsure">
          <b>Least sure about</b> {sequence.unsure}
        </p>
      )}
      <div className="cn-fb-seq-waves">
        {waves.map((wave) => (
          <HeadRow key={wave.depth} align="baseline">
            <b>Wave {wave.depth + 1}</b>
            <span className="cn-refs">
              {wave.issues.map((n) => (
                <Ref key={n} to={`issue:${n}`} />
              ))}
            </span>
          </HeadRow>
        ))}
      </div>
      <Edges sequence={sequence} />
      {/* What accepting costs. Without it the operator is agreeing to a hold whose
          size is not on the card. */}
      <p className="cn-psub">
        {wouldHold === 0
          ? 'Accepting holds nothing right now — everything this order puts later is already settled or in flight.'
          : `Accepting holds ${wouldHold} of these ${open.length} stories until what they wait on has a branch.`}
      </p>
      <div className="cn-fb-seq-ctrls">
        <AsyncButton
          tone="primary"
          size="small"
          onClick={async () => {
            await api.answerFeatureSequence(feature.number, 'accepted', view.state.config.desktopFolder || 'you');
            onAnswered();
          }}
        >
          Accept
        </AsyncButton>
        <AsyncButton
          ghost
          size="small"
          onClick={async () => {
            await api.answerFeatureSequence(feature.number, 'declined', view.state.config.desktopFolder || 'you');
            onAnswered();
          }}
        >
          Run them all
        </AsyncButton>
      </div>
    </div>
  );
}

/**
 * Every edge, with **where it came from marked**.
 *
 * The mark is not decoration. `link` is a statement somebody made on their own
 * board and `inferred` is one agent's reading of the items' text, and a card that
 * drew the two the same way would invite an operator to accept the second thinking
 * it was the first. → `docs/spec/33-story-sequencing.md#where-the-order-comes-from`
 */
function Edges({ sequence }: { sequence: FeatureSequence }): JSX.Element | null {
  if (sequence.edges.length === 0) {
    return <p className="cn-psub">No story waits on another — the sequencer found these independent.</p>;
  }
  return (
    <ul className="cn-fb-seq-edges">
      {sequence.edges.map((edge) => (
        <li key={`${edge.issue}>${edge.dependsOn}`}>
          <span className="cn-refs">
            <Ref to={`issue:${edge.issue}`} />
          </span>{' '}
          waits on{' '}
          <span className="cn-refs">
            <Ref to={`issue:${edge.dependsOn}`} />
          </span>
          <Tag>{edge.source === 'link' ? 'tracker link' : 'inferred'}</Tag>
          {edge.reason !== null && <span className="cn-fb-seq-edge-why">{edge.reason}</span>}
        </li>
      ))}
    </ul>
  );
}

function Summary({ summary, now }: { summary: FeatureSummary | null; now: number }): JSX.Element | null {
  if (summary === null) return null;
  return (
    <div className="cn-fb-summary">
      <p className="cn-fb-standing">{summary.standing}</p>
      <SummaryBlock title="Usable now" body={summary.usable} />
      <SummaryBlock title="Blocking" body={summary.blocked} tone="blocked" />
      <SummaryBlock title="Left to do" body={summary.remaining} />
      {/* The stamp, drawn as an age and never judged: how old a summary may be
          before it is stale is a policy no config file states, and the rule that
          rewrites it fires on movement rather than on a clock. */}
      <p className="cn-psub cn-fb-stamp">written {relAge(summary.updatedAt, now)}</p>
    </div>
  );
}

function SummaryBlock({
  title,
  body,
  tone,
}: {
  title: string;
  body: string | null;
  tone?: 'blocked';
}): JSX.Element | null {
  if (body === null) return null;
  return (
    <div className={`cn-fb-sum-block${tone === undefined ? '' : ` cn-fb-sum-${tone}`}`}>
      <h4>{title}</h4>
      <p>{body}</p>
    </div>
  );
}

/**
 * The briefing: what is happening, what is done, and what is stopping the rest.
 *
 * The three lists are the questions somebody outside the fleet asks in order —
 * _is this moving, what of it is usable, what is in the way_ — and the card
 * answers them **in the words of whoever said it**. A delivery line is the
 * summary its author wrote, a blocked line is the agent's own question or the
 * assessor's shortfall, and nothing here is composed from the counts above.
 *
 * That is the same discipline as {@link wantsYou} one line up, arrived at from the
 * other side: that line counts facts and phrases them, this one quotes sentences
 * and phrases nothing. Neither ever says a Feature is on track, at risk or late,
 * because no module owns those words.
 *
 * Absent entirely on a Feature with nothing worked, nothing delivered and nothing
 * blocked — the bar has already said so, and an empty heading three times over
 * would be the card's loudest element saying nothing.
 */
function Briefing({
  briefing,
  now,
  actions,
}: {
  briefing: FeatureBriefing;
  now: number;
  actions: CockpitActions;
}): JSX.Element | null {
  const { working, delivered, blocking } = briefing;
  if (working.length === 0 && delivered.length === 0 && blocking.length === 0) return null;

  return (
    <div className="cn-fb-brief">
      {blocking.length > 0 && (
        // First, because it is the only one of the three that is asking for
        // something. Delivered work needs nobody.
        <BriefList title="In the way" total={briefing.blockingTotal} shown={blocking.length}>
          {blocking.map((row) => (
            <BlockedLine key={`${row.kind}:${row.number}`} row={row} now={now} actions={actions} />
          ))}
        </BriefList>
      )}
      {working.length > 0 && (
        <BriefList title="Being worked" total={briefing.workingTotal} shown={working.length}>
          {working.map((row) => (
            <WorkingLine key={row.number} row={row} now={now} actions={actions} />
          ))}
        </BriefList>
      )}
      {delivered.length > 0 && (
        <BriefList title="Delivered" total={briefing.deliveredTotal} shown={delivered.length}>
          {delivered.map((row) => (
            <DeliveredLine key={row.number} row={row} now={now} actions={actions} />
          ))}
        </BriefList>
      )}
    </div>
  );
}

/**
 * One list, with what it stood for.
 *
 * The count is drawn whenever it exceeds the rows, never trimmed silently: three
 * of eleven blocked items read as three blocked items, which is the one number on
 * this card somebody would act on being wrong about.
 */
function BriefList({
  title,
  total,
  shown,
  children,
}: {
  title: string;
  total: number;
  shown: number;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="cn-fb-brief-list">
      <h4>
        {title} <span className="cn-psub">{total > shown ? `${shown} of ${total}` : total}</span>
      </h4>
      <ul>{children}</ul>
    </section>
  );
}

function WorkingLine({
  row,
  now,
  actions,
}: {
  row: FeatureWorkingRow;
  now: number;
  actions: CockpitActions;
}): JSX.Element {
  return (
    <li>
      <GoalLink number={row.number} title={row.title} actions={actions} />{' '}
      {/* The run's age, and nothing about whether it is too long: how long is too
          long is a policy no config file states. → docs/spec/17-cockpit.md#the-briefing */}
      <span className="cn-psub">for {relAge(row.since, now)}</span>
    </li>
  );
}

function DeliveredLine({
  row,
  now,
  actions,
}: {
  row: FeatureReportRow;
  now: number;
  actions: CockpitActions;
}): JSX.Element {
  return (
    <li>
      <GoalLink number={row.number} title={row.title} actions={actions} />
      {/* Quoted, and attributed, because the two together are what make it
          checkable: a sentence with no author is the board's own claim. */}
      <span className="cn-fb-said">“{row.summary}”</span>
      <span className="cn-psub">
        — {row.by}, {relAge(row.at, now)}
      </span>
    </li>
  );
}

const BLOCK_WORD: Record<FeatureBlockKind, string> = {
  question: 'asked',
  fellShort: 'fell short',
};

/** An agent stopped waiting is a fault; a decision nobody has made is a gate. */
const BLOCK_TONE: Record<FeatureBlockKind, TagTone> = {
  question: 'red',
  fellShort: 'amber',
};

function BlockedLine({
  row,
  now,
  actions,
}: {
  row: FeatureBlockRow;
  now: number;
  actions: CockpitActions;
}): JSX.Element {
  return (
    <li>
      {/* Two words and not one: `asked` is an agent stopped waiting for a reply,
          `fell short` is a decision nobody has made. A reader owes each a
          different thing. */}
      <Tag tone={BLOCK_TONE[row.kind]} fill>
        {BLOCK_WORD[row.kind]}
      </Tag>{' '}
      <GoalLink number={row.number} title={row.title} actions={actions} />
      <span className="cn-fb-said">“{row.summary}”</span>
      <span className="cn-psub">{relAge(row.since, now)}</span>
    </li>
  );
}

/** The goal as a control, with its reference beside it — never one inside the other. */
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

/**
 * The one line on a card that says what is waiting on a person — or nothing.
 *
 * **A count of facts, never a judgement.** Each clause below is something a module
 * already decided: the watch tag (`src/watchLabels.ts`), the shortfall verdict, the
 * appraisal verdict off the live world, and the three-valued reach. Nothing here
 * infers that a Feature is late, at risk or slipping, because no module owns those
 * words and a card inventing one is the second opinion this whole surface avoids.
 *
 * Ordered hardest-first and **stops at the first thing that bites**, rather than
 * listing everything: a card that says four things says none of them.
 */
function wantsYou(feature: FeatureRollup, view: CockpitView): ReactNode {
  const { counts } = feature;

  // Read off the live world by number, exactly as the Tickets tab overlays it: the
  // appraisal verdict is the server's own reading and a second derivation here
  // would be a second opinion about it.
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

/** A short run of issue references, drawn as references rather than as text. */
function Refs({ numbers }: { numbers: readonly number[] }): JSX.Element {
  // Capped, because the sentence is the point: a card naming eleven items has
  // stopped being a line somebody reads.
  const shown = numbers.slice(0, 3);
  return (
    <span className="cn-refs">
      {shown.map((n) => (
        <Ref key={n} to={`issue:${n}`} />
      ))}
      {numbers.length > shown.length && <span className="cn-psub">+{numbers.length - shown.length}</span>}
    </span>
  );
}

/**
 * The segmented roll-up — the card's primary reading.
 *
 * Six segments and not two, because the four that are not "delivered" are the ones
 * a reader acts on differently. `unwatched` is drawn hatched rather than as a
 * colour: it is the absence of the fleet having looked, and a solid block would
 * read as a fifth kind of progress.
 */
function Bar({ counts }: { counts: FeatureCounts }): JSX.Element {
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

const STANDING_WORD: Record<FeatureChildStanding, string> = {
  delivered: 'delivered',
  inFlight: 'in flight',
  fellShort: 'fell short',
  settled: 'settled',
  queued: 'queued',
  unwatched: 'not watched',
};

/**
 * The same four hues the standing's own word takes in the legend below, now on the
 * chip itself. It had none: `cn-fb-c-*` tints a `b` and the chip wearing it was
 * plain, so the column that says how a child stood said it in one colour.
 */
const STANDING_TONE: Record<FeatureChildStanding, TagTone | undefined> = {
  delivered: 'green',
  inFlight: 'blue',
  fellShort: 'red',
  settled: undefined,
  queued: undefined,
  unwatched: 'amber',
};

function barLabel(counts: FeatureCounts): string {
  const parts = (Object.keys(STANDING_WORD) as FeatureChildStanding[])
    .filter((s) => counts[s] > 0)
    .map((s) => `${counts[s]} ${STANDING_WORD[s]}`);
  return `${parts.join(', ')} — ${counts.total} in all`;
}

function Counts({ counts }: { counts: FeatureCounts }): JSX.Element {
  return (
    <p className="cn-fb-counts">
      {(Object.keys(STANDING_WORD) as FeatureChildStanding[])
        .filter((s) => counts[s] > 0)
        .map((s) => (
          <span key={s} className={`cn-fb-count cn-fb-c-${s}`}>
            <b>{counts[s]}</b> {STANDING_WORD[s]}
          </span>
        ))}
      <span className="cn-fb-count cn-psub">{counts.total} in all</span>
    </p>
  );
}

function Legend(): JSX.Element {
  return (
    <p className="cn-fb-legend">
      {(Object.keys(STANDING_WORD) as FeatureChildStanding[]).map((s) => (
        <span key={s}>
          <i className={`cn-fb-swatch cn-fb-${s}`} /> {STANDING_WORD[s]}
        </span>
      ))}
    </p>
  );
}

/**
 * Where the Feature's work has got to, per environment.
 *
 * **Four values drawn four ways**, and `unknown` never as `absent`: an expired
 * credential and work that genuinely has not shipped read identically otherwise,
 * and only one of them is about deployment.
 * → `docs/spec/24-environments.md#the-three-verdicts`
 */
function Reach({ reach }: { reach: readonly FeatureReach[] }): JSX.Element {
  return (
    <span className="cn-fb-reach">
      {reach.map((env) => (
        <i
          key={env.environment}
          className={`cn-fb-env cn-fb-r-${env.status}`}
          title={
            env.status === 'unknown'
              ? `${env.environment}: the probe could not say — not the same as “hasn’t shipped”`
              : `${env.environment}: ${env.goals} of ${env.total} goals confirmed`
          }
        >
          {env.environment}
          {env.status === 'unknown' ? '?' : ''}
        </i>
      ))}
    </span>
  );
}

/**
 * The children list, grouped into waves when an order holds.
 *
 * **It groups the list that is already here; it never adds a second one.** Two
 * lists of the same stories in different orders are two answers to "what is under
 * this Feature", and a reader would have to work out which to believe. The
 * board's own ordering (`orderChildren`) is kept *within* a wave, because a
 * sequence says which stories go together and has no opinion about which of two
 * that can both start is the more interesting to look at.
 */
function Children({
  rows,
  total,
  actions,
  sequence,
}: {
  rows: readonly FeatureChildRow[];
  total: number;
  actions: CockpitActions;
  /** The **accepted** order, or null. A proposal nobody has answered groups nothing. */
  sequence: FeatureSequence | null;
}): JSX.Element | null {
  if (rows.length === 0) return null;
  const groups =
    sequence === null
      ? [{ depth: -1, rows }]
      : wavesOf(
          rows.map((r) => r.number),
          sequence.edges,
        ).map((wave) => ({ depth: wave.depth, rows: rows.filter((r) => wave.issues.includes(r.number)) }));
  return (
    <div className="cn-fb-kids">
      <table>
        <tbody>
          {groups.map((group) => (
            <Fragment key={group.depth}>
              {group.depth >= 0 && (
                <tr className="cn-fb-wave">
                  <td colSpan={6}>
                    Wave {group.depth + 1}
                    {group.depth === 0 ? ' — waits on nothing' : ''}
                  </td>
                </tr>
              )}
              {group.rows.map((row) => (
                <ChildRow key={row.number} row={row} actions={actions} sequence={sequence} />
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
      {total > rows.length && (
        // Said rather than silently cut: a list that simply stopped would read as
        // the whole Feature.
        <p className="cn-psub">
          {rows.length} of {total} shown — the rest are on the Tickets tab.
        </p>
      )}
    </div>
  );
}

/** One story, and — under it, when an order holds — what it waits behind. */
function ChildRow({
  row,
  actions,
  sequence,
}: {
  row: FeatureChildRow;
  actions: CockpitActions;
  sequence: FeatureSequence | null;
}): JSX.Element {
  const waiting = sequence === null ? [] : waitsOn(row.number, sequence.edges);
  return (
    <Fragment>
      <tr>
        <td className="cn-fb-kind">{row.issueType ?? '—'}</td>
        <td className="cn-refs">
          <Ref to={`issue:${row.number}`} />
        </td>
        {/* The title is the control and the ref sits beside it: one click
            cannot have two destinations. → docs/spec/17-cockpit.md#links */}
        <td className="cn-fb-title">
          <button type="button" onClick={() => actions.selectGoal(`issue:${row.number}`)}>
            {row.title}
          </button>
        </td>
        <td>
          <Tag tone={STANDING_TONE[row.standing]} fill={STANDING_TONE[row.standing] !== undefined}>
            {STANDING_WORD[row.standing]}
          </Tag>
        </td>
        {/* The harness's own outcome word, beside the standing rather than
            instead of it: a re-picked goal is in flight and still carries
            `fell short`. Blank where it never reached a verdict, which is
            most rows. */}
        <td className="cn-psub">
          {row.outcome === null || row.outcome === STANDING_WORD[row.standing] ? '' : row.outcome}
        </td>
        <td className="cn-fb-num">{money(row.costUsd)}</td>
      </tr>
      {/* What it waits behind, on its own row under it: the columns beside a
          story are about the story, and a prerequisite is about the order. */}
      {waiting.length > 0 && (
        <tr className="cn-fb-waits">
          <td />
          <td colSpan={5}>
            waits on{' '}
            <span className="cn-refs">
              {waiting.map((n) => (
                <Ref key={n} to={`issue:${n}`} />
              ))}
            </span>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

/**
 * Dollars, or the word for never having measured any.
 *
 * `not measured` rather than `$0.00`, for `TicketRow.costUsd`'s reason: PTY agents
 * report no usage at all, so a Feature worked entirely that way has no spend row
 * anywhere — and a zero would report free work where the truth is unmeasured work.
 */
function money(usd: number | null): ReactNode {
  return usd === null ? <i className="cn-fb-never">not measured</i> : fmtUsd(usd);
}
