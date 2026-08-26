import type { JSX, ReactNode } from 'react';

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
export interface PanelRowModel {
  /** React's identity for the row, and the card's own natural id for it. */
  key: string;
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
  why: boolean;
  /** Any row wearing a word, which is what the column has to be wide enough for. */
  whyLabel: boolean;
  reading: boolean;
  chips: boolean;
  action: boolean;
  refs: boolean;
}

function slotsUsed(rows: readonly PanelRowModel[]): SlotsUsed {
  const asks = (row: PanelRowModel): boolean => (row.why != null && row.why !== '') || row.whyLabel !== undefined;
  return {
    lamp: rows.some((row) => row.lamp !== undefined),
    toggle: rows.some((row) => row.toggle !== undefined),
    why: rows.some(asks),
    whyLabel: rows.some((row) => row.whyLabel !== undefined),
    reading: rows.some((row) => row.reading !== undefined),
    chips: rows.some((row) => row.chips !== undefined),
    action: rows.some((row) => row.action !== undefined),
    refs: rows.some((row) => row.refs !== null && row.refs !== undefined),
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
function gridTemplate(has: SlotsUsed): string {
  // Every rail is a *ceiling*, not a width. Fixed, they were sized against a
  // full-width card and simply overran a half-width one: six slots on the Up next
  // card left its titles 80px of 534 and clipped every one of them to a word,
  // while World signals — same width, four slots — gave its own 277. A rail that
  // gives way keeps the row's shape on a wide card and costs the slots, not the
  // subject, on a narrow one.
  const rail = (w: string): string => `minmax(0, var(${w}))`;
  return [
    has.lamp ? 'var(--cn-w-lamp)' : '',
    has.toggle ? 'var(--cn-w-eye)' : '',
    // And the subject has a floor, which is what makes the ceilings bite: `1fr`
    // takes what is left over, so with nothing below it the title is the one track
    // that collapses and the rails never shrink at all.
    'minmax(var(--cn-w-title), 1fr)',
    // A column of words needs the width of a word; a column of markers does not.
    has.why ? rail(has.whyLabel ? '--cn-w-state' : '--cn-w-why') : '',
    has.reading ? rail('--cn-w-read') : '',
    has.chips ? rail('--cn-w-chips') : '',
    has.action ? rail('--cn-w-act') : '',
    has.refs ? rail('--cn-w-refs') : '',
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
export function PanelRows({ rows }: { rows: readonly PanelRowModel[] }): JSX.Element {
  const has = slotsUsed(rows);
  // On each row, never on the list: `.cn-rows` is a flex column, and
  // `grid-template-columns` on a flex container is inherited by nothing and
  // applies to nothing. It renders exactly as it did before — which is how this
  // was wrong for a whole build without looking wrong.
  const columns = gridTemplate(has);
  return (
    <div className="cn-rows">
      {rows.map((row) => (
        <FactsRow key={row.key} row={row} has={has} columns={columns} />
      ))}
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
      <Subject row={row} />
      {has.why && (
        <span className={`cn-slot ${row.whyLabel === undefined ? 'cn-slot-why' : ''}`}>
          <Why row={row} />
        </span>
      )}
      {has.reading && <span className="cn-slot">{row.reading}</span>}
      {has.chips && <span className="cn-slot">{row.chips}</span>}
      {has.action && <span className="cn-slot">{row.action}</span>}
      {has.refs && <span className="cn-refs">{row.refs}</span>}
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
function Subject({ row }: { row: PanelRowModel }): JSX.Element {
  const inner = (
    <>
      <b className="cn-name">{row.title}</b>
      <Facts facts={row.facts} />
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
    row.live === true ? 'cn-live' : '',
    row.className ?? '',
  ]
    .filter((part) => part !== '')
    .join(' ');
}
