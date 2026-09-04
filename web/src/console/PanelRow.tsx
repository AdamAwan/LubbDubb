import { Fragment, type JSX, type ReactNode } from 'react';

/**
 * One row of a panel, as a value rather than as markup.
 *
 * Every card on the overview used to compose `cn-row` its own way, and the
 * classes being shared did not make the grammar shared: refs sat in the trailing
 * `cn-refs` slot on two cards and inside `cn-name` on two others, the sub-line was
 * a dot-separated concatenation whose parts differed per card, and `cn-num`
 * carried a cost on a fleet row and a `×3` on a signal row. None of that is a
 * thing `npm run check` can see — each card reads correctly on its own, and the
 * inconsistency is only visible with two of them side by side, which is how the
 * overview is always read.
 *
 * So a card no longer writes a row. It builds {@link PanelRowModel} values and
 * hands them to {@link PanelRows}, which is what moves the rule out of everyone's
 * memory and into the typechecker: {@link PanelRowModel.refs} is a required
 * field, so a card that draws no way to the thing it names has to say so in the
 * model, where it is visible, rather than by omission at a call site.
 *
 * **Two renderings, one model** ({@link PanelGrammar}). `facts` is the row as a
 * line of labelled quantities; `columns` is the card as a table whose headings
 * are those same labels. They are drawn from the same value, so the choice
 * between them is one field on the place and not a rewrite of five cards — which
 * is the whole point of the model existing before the layout is settled.
 *
 * → docs/spec/17-cockpit.md#the-row-grammar
 */
/**
 * A band a card's rows sit under, and the heading that opens it.
 *
 * Position, where a chip would have been a colour. The rack's question is *is
 * anything waiting on me* and its rows answered it one at a time, in a column of
 * words an operator has to read down; a band answers it before any row is read,
 * and it spends no hue on a card where five of them already mean five things.
 *
 * A card orders its own rows so that a band's members are contiguous — the
 * heading is drawn where {@link key} changes, so a card that interleaves two
 * groups draws the same heading twice, which is the honest rendering of rows in
 * an order that contradicts their bands rather than a silent regrouping.
 *
 * → docs/spec/17-cockpit.md#yours-then-the-fleets
 */
export interface RowGroup {
  /** What makes two adjacent rows one band. */
  key: string;
  /** The heading's word. */
  label: string;
  /** What is true of the whole band — a count, at the heading's right. */
  note?: string;
  /** `ask` where the band is your move; `quiet` is the plain heading. */
  tone?: 'ask' | 'quiet';
}

export interface PanelRowModel {
  /** React's identity for the row, and the card's own natural id for it. */
  key: string;
  /**
   * The band this row belongs under. Absent on every row of a card that does not
   * group — which is the shape a card takes back the moment its grouping has
   * nothing to separate, rather than heading a single band over the whole list.
   */
  group?: RowGroup;
  /**
   * Who asked, as a mark — {@link Who}, never a name and never text.
   *
   * Its own slot rather than the {@link lamp}'s, because they are two different
   * facts and a row can carry both: the lamp is the row's *state* and this is the
   * row's *person*. A card that draws it draws it on every row, since the slot's
   * whole value is being scannable down the column.
   */
  who?: ReactNode;
  /** The state lamp, where the row has a state. */
  lamp?: ReactNode;
  /**
   * A single-glyph control pinned to the *left* of the subject: whether the
   * harness is to take an interest in this row at all.
   *
   * Left rather than in {@link action} because it is not the row's work. It is the
   * same switch in the same place on every row of the card, so it belongs where an
   * eye can skip it — while {@link action} is the one thing *this* row can be told
   * to do, which is a different question and deserves the width.
   */
  toggle?: ReactNode;
  /** What the row is, in its own words. */
  title: ReactNode;
  /**
   * Opens the thing the row is about, which makes the **title** the control and
   * never the whole row: a row that also carries refs cannot be a button without
   * nesting them inside it, and a link inside a control is a second destination
   * for one click. → docs/spec/17-cockpit.md#links
   */
  open?: () => void;
  /** The hover for {@link open}, since the title alone rarely says where it goes. */
  openTitle?: string;
  /**
   * What the row *names* — `<Ref>` elements, never text and never a bare number.
   *
   * Required, and null is the way to say a row has nothing to point at. The
   * field exists so that "this row offers no way anywhere" is a decision somebody
   * made rather than a line nobody wrote: it is the cockpit's most repeated bug,
   * and every previous fix for it was a convention that the next card forgot.
   */
  refs: ReactNode;
  /**
   * The row's quantities, each said with what it is. `41m` alone is an age or a
   * remaining time depending on the card it is on; `for 41m` is neither.
   *
   * The labels are load-bearing twice over: in the `columns` grammar they *are*
   * the table's headings, so a card whose rows disagree about what to call one
   * quantity draws two columns for it.
   */
  facts?: readonly RowFact[];
  /**
   * The row's one long sentence — a queue item's `reason`, a pickup's reasons, a
   * pull request's attention verdict — held behind a marker and given up on hover
   * or focus.
   *
   * Behind a marker rather than on the glass because it is the answer to a
   * question only some readings raise, and on the glass it made the queue the one
   * card whose rows were three lines tall and whose shape every other card had to
   * be an exception to. What stays visible in its place is the structured half of
   * the same fact — the rule that queued it, and the word *held* where it is held.
   *
   * It is prose, so it is the one thing the marker ever holds: never a ref, never
   * a control. A reason naming `#412` draws it as plain text here, and the way
   * there is in {@link refs}, where every other row keeps one.
   */
  why?: string | null;
  /**
   * The word the marker wears, where the row's state has one.
   *
   * With it the marker stops being a `?` an operator has to hover to learn
   * anything at all: `question`, `limit`, `stalled` say what is going on at a
   * glance, and the sentence behind them says the rest. Without it the marker is
   * the bare `?` — the right shape for a card whose rows have no single word for
   * their state, where the label would be the same one on every row.
   *
   * A label with no {@link why} is a chip that states a fact and has nothing more
   * to add, which is allowed: `at a keyboard` on a desk run needs the sentence,
   * a plain state may not.
   */
  whyLabel?: string;
  /**
   * How the label reads: `ask` is your move (red), `hold` is the harness stopped
   * (amber), `quiet` is neither. The tones are the chip vocabulary the cockpit
   * already uses, not a third one.
   */
  whyTone?: 'ask' | 'hold' | 'quiet';
  /** The row's one graphical reading: a segment track, a CI ladder. */
  reading?: ReactNode;
  /** Verdicts, in the order the card ranks them. */
  chips?: ReactNode;
  /** The one thing this row can be told to do. */
  action?: ReactNode;
  /** Work that has ended, or a pull request nothing will touch: present, and plainly behind. */
  spent?: boolean;
  /** A row that no dispatch cut — the desk run's dashed edge and hollow lamp. */
  desk?: boolean;
  /**
   * A row the harness is working on that is not an agent yet — the same dashed
   * edge and hollow lamp, in its own tint.
   *
   * Its own flag rather than a second meaning for {@link desk}, because the two
   * say opposite things about who is doing the work: a desk run is somebody at
   * their keyboard and this is the harness itself, and a shared class would have
   * left one of them wearing the other's colour.
   */
  readying?: boolean;
  /**
   * Work is happening on this row **right now** — an agent on the branch, not a
   * verdict about it.
   *
   * The row itself carries it: a green edge and a slow sweep across the whole
   * line, rather than one more mark in one more slot. Which is the honest shape
   * for what it says — every other reading on the row is a *fact about the thing*
   * and sits in the slot for that fact, while this one is a fact about the row's
   * subject being under somebody's hands as you read it, and it is about to make
   * the rest of the row out of date. A card of rows where one is moving is
   * readable across the room; a 6px mark in the fifth column is not.
   */
  live?: boolean;
  /**
   * The card's own modifier, where the sheet already carries a rule for one —
   * `cn-goal-row`, whose track must not stretch with the title beside it. Not a
   * way for a card to restyle a row: what it names is a rule that exists.
   */
  className?: string;
  /** The row's hover, for what neither grammar can say. */
  hint?: string;
}

/** One quantity, and what it is. */
interface RowFact {
  /**
   * What the value *is*: `for`, `cost`, `branch`, `queued`. Drawn beside the
   * value in the `facts` grammar, and as the column heading in `columns`.
   */
  label: string;
  value: ReactNode;
  /** Amber — this fact is the reason the row is not moving. */
  alarm?: boolean;
}

/**
 * Which slots any of a card's rows fill.
 *
 * Read once per card and shared by both grammars, because both need the same
 * answer for the same reason: a slot no row fills draws no column, and a slot one
 * row fills is held open on all of them. That is what makes a position mean
 * something — an empty cell in a column that exists says *this row has no
 * verdict*, where a row that simply closed the gap up says nothing at all and
 * moves everything after it.
 */
interface SlotsUsed {
  lamp: boolean;
  toggle: boolean;
  who: boolean;
  why: boolean;
  /** Any row wearing a word, which is what the column has to be wide enough for. */
  whyLabel: boolean;
  reading: boolean;
  chips: boolean;
  action: boolean;
  refs: boolean;
  /** Only the stacked cut reads this: on the line, facts sit under the title. */
  facts: boolean;
}

function slotsUsed(rows: readonly PanelRowModel[]): SlotsUsed {
  const asks = (row: PanelRowModel): boolean => (row.why != null && row.why !== '') || row.whyLabel !== undefined;
  return {
    lamp: rows.some((row) => row.lamp !== undefined),
    toggle: rows.some((row) => row.toggle !== undefined),
    who: rows.some((row) => row.who !== undefined),
    why: rows.some(asks),
    whyLabel: rows.some((row) => row.whyLabel !== undefined),
    reading: rows.some((row) => row.reading !== undefined),
    chips: rows.some((row) => row.chips !== undefined),
    action: rows.some((row) => row.action !== undefined),
    refs: rows.some((row) => row.refs !== null && row.refs !== undefined),
    facts: rows.some((row) => row.facts !== undefined && row.facts.length > 0),
  };
}

/**
 * The card's own grid: the subject takes what is left, and every slot after it
 * is a fixed width the sheet states once.
 *
 * Built here rather than in CSS because *which* columns exist is a fact about the
 * card's rows, and only this side can see them — but the widths stay in
 * `console.css`, so the rail is one edit for every card rather than five.
 */
/**
 * How a card's rows are cut: one line, or two.
 *
 * Not a second *reading* of the model — the table that lost
 * ([17](../../../docs/spec/17-cockpit.md#the-row-grammar)) was one of those, and
 * this is not it. Every slot, its order and its width are the same in both; the
 * only difference is where the rail wraps. `stacked` keeps the row's identity —
 * lamp, switch, who, subject, refs — on the first line and drops the row's
 * *readings* onto a second one under the subject.
 *
 * A card takes it because it is **over-subscribed**, which is a measurable fact
 * about it rather than a preference: the rack carries seven slots beside a title
 * that is a sentence, and the spec's other two fixes for that — a wider card, one
 * slot fewer — were both refused on their own merits.
 */
type RowLayout = 'line' | 'stacked';

/**
 * Every rail is a *ceiling*, not a width. Fixed, they were sized against a
 * full-width card and simply overran a half-width one.
 */
const rail = (w: string): string => `minmax(0, var(${w}))`;

/**
 * The slots that say what the row *is*, in the order they are drawn. Both
 * layouts keep them on the first line and in this order.
 */
function identityColumns(has: SlotsUsed): string[] {
  return [
    has.lamp ? 'var(--cn-w-lamp)' : '',
    has.toggle ? 'var(--cn-w-eye)' : '',
    // A mark, so it is a width and not a ceiling: it is the same glyph on every
    // row, and a column that gives way would move the subject's left edge from
    // card to card for nothing.
    has.who ? 'var(--cn-w-who)' : '',
    // And the subject has a floor, which is what makes the ceilings bite: `1fr`
    // takes what is left over, so with nothing below it the title is the one track
    // that collapses and the rails never shrink at all.
    'minmax(var(--cn-w-title), 1fr)',
  ];
}

/**
 * The slots that say how the row *stands*: the verdict, the readings, the one
 * thing it can be told to do. On the line layout they are columns after the
 * subject; on the stacked one they are the strip's own columns, in the same
 * order.
 */
function readingColumns(has: SlotsUsed): string[] {
  return [
    // A column of words needs the width of a word; a column of markers does not.
    has.why ? rail(has.whyLabel ? '--cn-w-state' : '--cn-w-why') : '',
    has.reading ? rail('--cn-w-read') : '',
    has.chips ? rail('--cn-w-chips') : '',
    has.action ? rail('--cn-w-act') : '',
  ];
}

function gridTemplate(has: SlotsUsed, layout: RowLayout): string {
  // The stacked cut keeps the readings off this rail entirely: they are the
  // strip's columns, under the subject, and a column held open for them here as
  // well would be a gutter nothing can ever fill.
  const columns = layout === 'stacked' ? identityColumns(has) : identityColumns(has).concat(readingColumns(has));
  return columns
    .concat(has.refs ? rail('--cn-w-refs') : '')
    .filter((part) => part !== '')
    .join(' ');
}

/**
 * The strip's own rail: the same reading slots under the subject, at the same
 * widths, so a mark sits where the card's other rows put it.
 *
 * **Ordered by how often the reading exists**, which is the one place the strip
 * departs from the line's slot order — and the reason it is worth departing:
 * a strip is a short run of boxes with a ragged end, and where the gaps fall
 * decides whether the card reads as a column or as a scatter. The
 * {@link PanelRowModel.reading} slot leads because a card that draws readings at
 * all draws them on nearly every row; the verdict, the control and the facts are
 * each true of some rows, so their absences collect at the strip's end where an
 * eye is not scanning.
 */
function stripTemplate(has: SlotsUsed): string {
  return [
    has.reading ? rail('--cn-w-read') : '',
    has.why ? rail(has.whyLabel ? '--cn-w-state' : '--cn-w-why') : '',
    has.chips ? rail('--cn-w-chips') : '',
    has.action ? rail('--cn-w-act') : '',
    has.facts ? 'minmax(0, 1fr)' : '',
  ]
    .filter((part) => part !== '')
    .join(' ');
}

/**
 * A card's rows.
 *
 * The whole set rather than one row at a time, because the rail is a fact about
 * the card and not about any row on it: which slots exist is the union of what
 * the rows carry, so they have to be seen together for an empty cell to mean
 * *this row has no verdict* rather than *this row is shorter*.
 *
 * The card named its own subject and refs columns while it was also drawn as a
 * table — `subject` and `refsLabel`, the two things nothing could derive. Both are
 * gone with the table: a heading nothing renders is a second description of every
 * card, kept in step by nobody.
 */
export function PanelRows({
  rows,
  layout = 'line',
}: {
  rows: readonly PanelRowModel[];
  layout?: RowLayout;
}): JSX.Element {
  const has = slotsUsed(rows);
  // On each row, never on the list: `.cn-rows` is a flex column, and
  // `grid-template-columns` on a flex container is inherited by nothing and
  // applies to nothing. It renders exactly as it did before — which is how this
  // was wrong for a whole build without looking wrong.
  const columns = gridTemplate(has, layout);
  // The strip's own rail, read once per card for the reason the row's is: which
  // reading slots exist is a fact about the card, and a strip that closed the gap
  // up on the rows that lack one would be the packed flex line again, one line down.
  const strip = layout === 'stacked' ? stripTemplate(has) : undefined;
  // The band the last row was in, so a heading is drawn where it *changes* rather
  // than once per row. An ungrouped row clears it, which is what lets a card
  // group part of its list and leave the rest plain.
  let band: string | undefined;
  return (
    <div className="cn-rows">
      {rows.map((row) => {
        const opens = row.group !== undefined && row.group.key !== band;
        band = row.group?.key;
        return (
          <Fragment key={row.key}>
            {opens && row.group !== undefined && <GroupHead group={row.group} />}
            {strip === undefined ? (
              <FactsRow row={row} has={has} columns={columns} />
            ) : (
              <StackedRow row={row} has={has} columns={columns} strip={strip} />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

/**
 * A band's heading: the word, and what is true of the whole band.
 *
 * Not a row. It fills the card's width rather than sitting on the rail, because
 * it names the rows under it and a heading that lined its word up with the
 * subject column would read as a row whose every other slot is empty.
 */
function GroupHead({ group }: { group: RowGroup }): JSX.Element {
  return (
    <div className={group.tone === 'ask' ? 'cn-group cn-group-ask' : 'cn-group'}>
      {group.label}
      {group.note !== undefined && <span className="cn-group-n">{group.note}</span>}
    </div>
  );
}

/**
 * The row as a line of quantities, on the card's own rail.
 *
 * Slot order is fixed and the same on every card — state, switch, subject, why,
 * reading, verdict, control, refs — and since #651 so is each slot's *width*: the row is a
 * grid the card sets once, not a flex line that packs to the right. That is the
 * difference between an order and a position. Packed, the fleet card's verdict
 * sat where the pull request card's control did, every row moved when the row
 * above it grew a chip, and "always look here" was never true of anything but the
 * refs group.
 *
 * A slot the row does not fill draws an empty cell rather than closing the gap
 * up, which is what makes the column mean something: this row has no verdict, as
 * against this row said nothing.
 */
function FactsRow({ row, has, columns }: { row: PanelRowModel; has: SlotsUsed; columns: string }): JSX.Element {
  return (
    <div className={rowClass(row, 'cn-row cn-frow')} style={{ gridTemplateColumns: columns }} title={row.hint}>
      {has.lamp && <span className="cn-slot">{row.lamp}</span>}
      {has.toggle && <span className="cn-slot">{row.toggle}</span>}
      {has.who && <span className="cn-slot">{row.who}</span>}
      <Subject row={row} />
      {has.why && (
        <span className={`cn-slot ${row.whyLabel === undefined ? 'cn-slot-why' : ''}`}>
          <Why row={row} />
        </span>
      )}
      {has.reading && <span className="cn-slot cn-slot-read">{row.reading}</span>}
      {has.chips && <span className="cn-slot">{row.chips}</span>}
      {has.action && <span className="cn-slot">{row.action}</span>}
      {has.refs && <span className="cn-refs">{row.refs}</span>}
    </div>
  );
}

/**
 * The row cut in two: what it *is* on the first line, how it *stands* on the second.
 *
 * The strip sits under the subject and stops at the refs rule rather than running
 * beneath it, so the card keeps one unbroken vertical edge between what a row is
 * and what it names — and the second line is visibly the title's own rather than
 * a line belonging to the whole card.
 *
 * **The strip is drawn before the refs in the markup and after them on the
 * glass.** Both are placed by hand — the strip on the subject's column, the refs
 * on the last one — so the eye reads title → readings → refs down the row while a
 * screen reader and the keyboard get the row's state before its destinations,
 * which is the order somebody asking "what is going on with this" wants.
 *
 * Order inside the strip is {@link stripTemplate}'s — the readings, the verdict,
 * then the facts, by how often each exists. Which mark leads *within* the
 * readings is the card's own business, since {@link PanelRowModel.reading} is one
 * node: the rack puts the checks first there for the same reason.
 */
function StackedRow({
  row,
  has,
  columns,
  strip,
}: {
  row: PanelRowModel;
  has: SlotsUsed;
  columns: string;
  strip: string;
}): JSX.Element {
  // Where the subject sits on the identity rail, which is where the strip goes
  // under it. Counted rather than written down: the three slots ahead of it are
  // each drawn only where some row of the card fills them.
  const subject = 1 + [has.lamp, has.toggle, has.who].filter(Boolean).length;
  const readings = has.why || has.reading || has.chips || has.action || has.facts;
  return (
    <div className={rowClass(row, 'cn-row cn-frow cn-srow')} style={{ gridTemplateColumns: columns }} title={row.hint}>
      {has.lamp && <span className="cn-slot">{row.lamp}</span>}
      {has.toggle && <span className="cn-slot">{row.toggle}</span>}
      {has.who && <span className="cn-slot">{row.who}</span>}
      <Subject row={row} facts={false} />
      {/* A card where no row has anything to report draws no strip at all, and
          takes back the one-line shape it would have had. */}
      {readings && (
        <span
          className="cn-rowreads"
          style={{ gridColumn: `${subject} / ${subject + 1}`, gridRow: 2, gridTemplateColumns: strip }}
        >
          {has.reading && <span className="cn-slot cn-slot-read">{row.reading}</span>}
          {has.why && (
            <span className={`cn-slot ${row.whyLabel === undefined ? 'cn-slot-why' : ''}`}>
              <Why row={row} />
            </span>
          )}
          {has.chips && <span className="cn-slot">{row.chips}</span>}
          {has.action && <span className="cn-slot">{row.action}</span>}
          {has.facts && (
            <span className="cn-slot">
              <Facts facts={row.facts} />
            </span>
          )}
        </span>
      )}
      {has.refs && (
        <span className="cn-refs" style={{ gridColumn: '-2 / -1', gridRow: 1 }}>
          {row.refs}
        </span>
      )}
    </div>
  );
}

/**
 * The name, and — in the `facts` grammar — the quantities under it.
 *
 * A `button` exactly when the row opens something, so a row that offers a way in
 * says so with the affordance rather than only on hover, and the refs stay
 * outside it either way, which is the one rule a call site could otherwise get
 * wrong.
 */
function Subject({ row, facts = true }: { row: PanelRowModel; facts?: boolean }): JSX.Element {
  const inner = (
    <>
      <b className="cn-name">{row.title}</b>
      {facts && <Facts facts={row.facts} />}
    </>
  );
  return row.open === undefined ? (
    <span className="cn-grow">{inner}</span>
  ) : (
    <button type="button" className="cn-grow" onClick={row.open} title={row.openTitle}>
      {inner}
    </button>
  );
}

/** The quantities, each with its own name — the `facts` grammar's whole sub-line. */
function Facts({ facts }: { facts?: readonly RowFact[] }): JSX.Element | null {
  if (facts === undefined || facts.length === 0) return null;
  return (
    <span className="cn-facts">
      {facts.map((fact) => (
        <span className="cn-fact" key={fact.label}>
          <span className="cn-fact-k">{fact.label}</span>
          <span className={`cn-fact-v ${fact.alarm === true ? 'cn-alarm' : ''}`}>{fact.value}</span>
        </span>
      ))}
    </span>
  );
}

/**
 * What is going on with this row, and the sentence behind it.
 *
 * Wears the row's own word where it has one and a bare `?` where it does not. The
 * word is the point: a `?` says only *there is something to know here*, so a
 * column of them tells an operator scanning the card nothing until they hover
 * every row — while `question` / `limit` / `stalled` answers the question the
 * card is for, and the hover is then for the detail rather than for the fact.
 *
 * A `button` rather than a hover target either way: a reason only a pointer can
 * reach is a reason half the operators do not have, so it takes focus and the
 * bubble opens on `:focus-visible` as well as `:hover`. The bubble is a sibling of
 * the button rather than its child, since a tooltip inside a control is read out
 * as part of the control's own name.
 */
function Why({ row }: { row: PanelRowModel }): JSX.Element | null {
  const why = row.why != null && row.why !== '' ? row.why : null;
  const label = row.whyLabel;
  if (why === null && label === undefined) return null;
  const tone = label === undefined ? '' : ` cn-why-chip cn-t-${row.whyTone ?? 'quiet'}`;
  return (
    <span className="cn-why">
      <button
        type="button"
        className={`cn-why-mark${tone}`}
        aria-label={label === undefined ? 'Why this row is here' : `${label} — what this means`}
        // A label with nothing behind it is a statement, not a control: it stays a
        // button so the keyboard reaches it the same way, and simply has no bubble.
        aria-disabled={why === null ? true : undefined}
      >
        {label ?? '?'}
      </button>
      {why !== null && (
        <span className="cn-why-tip" role="tooltip">
          {why}
        </span>
      )}
    </span>
  );
}

function rowClass(row: PanelRowModel, base: string): string {
  return [
    base,
    row.spent === true ? 'cn-spent' : '',
    row.desk === true ? 'cn-desk' : '',
    row.readying === true ? 'cn-readying' : '',
    row.live === true ? 'cn-live' : '',
    row.className ?? '',
  ]
    .filter((part) => part !== '')
    .join(' ');
}
