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
 * So a card no longer writes a row. It builds a {@link PanelRowModel} and hands it
 * here, which is what moves the rule out of everyone's memory and into the
 * typechecker: {@link PanelRowModel.refs} is a required field, so a card that
 * draws no way to the thing it names has to say so in the model, where it is
 * visible, rather than by omission at a call site.
 *
 * **Two renderings, one model** ({@link PanelGrammar}). `facts` is the row as a
 * line of labelled quantities; `claim` is the row as a sentence with its evidence
 * ruled off underneath. They are drawn from the same value, so the choice between
 * them is one field on the place and not a rewrite of five cards — which is the
 * whole point of the model existing before the layout is settled.
 *
 * → docs/spec/17-cockpit.md#the-row-grammar
 */
export interface PanelRowModel {
  /** The state lamp, where the row has a state. */
  lamp?: ReactNode;
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
   * The card's own modifier, where the sheet already carries a rule for one —
   * `cn-goal-row`, whose track must not stretch with the title beside it. Not a
   * way for a card to restyle a row: what it names is a rule that exists.
   */
  className?: string;
  /** The row's hover, for what neither band can say. */
  hint?: string;
}

/** One quantity, and what it is. */
interface RowFact {
  /** What the value *is*, drawn beside it: `for`, `cost`, `branch`, `queued`. */
  label: string;
  value: ReactNode;
  /** Amber — this fact is the reason the row is not moving. */
  alarm?: boolean;
}

/**
 * How a row is drawn. Two grammars over one model, chosen on the place so both
 * are reachable from a link while the choice between them is open.
 *
 * - `facts` — the title, then its quantities as labelled pairs.
 * - `claim` — the title as a sentence, then a ruled evidence band under it.
 */
type PanelGrammar = 'facts' | 'claim';

export function PanelRow({ row, grammar }: { row: PanelRowModel; grammar: PanelGrammar }): JSX.Element {
  return grammar === 'claim' ? <ClaimRow row={row} /> : <FactsRow row={row} />;
}

/**
 * The row as a line of quantities.
 *
 * Slot order is fixed and is the same on every card: state, subject, why,
 * reading, verdict, control, refs. The refs group stays last and keeps its rule,
 * which is where it already was on two of the five cards and is the position the
 * whole treatment was argued for — a token says *this is a way somewhere*, and
 * only a position says *this is where you look for one*.
 */
function FactsRow({ row }: { row: PanelRowModel }): JSX.Element {
  return (
    <div className={rowClass(row)} title={row.hint}>
      {row.lamp}
      <Subject row={row} facts />
      {row.why != null && row.why !== '' && <Why why={row.why} />}
      {row.reading}
      {row.chips}
      {row.action}
      <span className="cn-refs">{row.refs}</span>
    </div>
  );
}

/**
 * The row as a sentence with its evidence under it.
 *
 * The claim band carries the lamp, the words and the why marker; the evidence
 * band carries everything that is looked up rather than read, always in one order
 * — refs, facts, then the reading, the verdict and the control at its end. The
 * refs group drops its rule here and keeps its position: a hairline inside a band
 * that is already ruled off from the claim above it is two rules for one grouping.
 */
function ClaimRow({ row }: { row: PanelRowModel }): JSX.Element {
  return (
    <div className={`${rowClass(row)} cn-claim-row`} title={row.hint}>
      <span className="cn-claim">
        {row.lamp}
        {/* The facts belong to the evidence band here, so the subject draws the
            words alone — the same model, read in the other order. */}
        <Subject row={row} facts={false} />
        {row.why != null && row.why !== '' && <Why why={row.why} />}
      </span>
      <span className="cn-evidence">
        <span className="cn-refs cn-refs-flat">{row.refs}</span>
        <Facts facts={row.facts} />
        <span className="cn-ev-gap" />
        {row.reading}
        {row.chips}
        {row.action}
      </span>
    </div>
  );
}

/**
 * The name, and the facts under it on the grammar that puts them there.
 *
 * A `button` exactly when the row opens something, so a row that offers a way in
 * says so with the affordance rather than only on hover — and the refs stay
 * outside it either way, which is the one rule a call site could otherwise get
 * wrong.
 */
function Subject({ row, facts }: { row: PanelRowModel; facts: boolean }): JSX.Element {
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

/**
 * The quantities, each with its own name.
 *
 * Drawn in the claim grammar too, in the evidence band, where the labels are what
 * stop the strip from being the same dot-separated soup one rule lower down.
 */
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
 * The marker, and the sentence it holds.
 *
 * A `button` rather than a hover target: a reason only a pointer can reach is a
 * reason half the operators do not have, so it takes focus and the bubble opens on
 * `:focus-visible` as well as `:hover`. `aria-label` names what it is for, because
 * `?` alone reads as help rather than as *why this row*.
 *
 * The bubble is a sibling of the button rather than its child, since a tooltip
 * inside a control is read out as part of the control's own name.
 */
function Why({ why }: { why: string }): JSX.Element {
  return (
    <span className="cn-why">
      <button type="button" className="cn-why-mark" aria-label="Why this row is here">
        ?
      </button>
      <span className="cn-why-tip" role="tooltip">
        {why}
      </span>
    </span>
  );
}

function rowClass(row: PanelRowModel): string {
  return ['cn-row', row.spent === true ? 'cn-spent' : '', row.desk === true ? 'cn-desk' : '', row.className ?? '']
    .filter((part) => part !== '')
    .join(' ');
}
