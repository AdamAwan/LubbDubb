import { Fragment, useRef, useState, type CSSProperties, type JSX, type ReactNode } from 'react';

/**
 * One row of a panel, as a value rather than markup: a card builds
 * {@link PanelRowModel} values and hands them to {@link PanelRows}. `refs` is
 * required, so a row with no way to the thing it names says so explicitly.
 * Two renderings share one model ({@link RowLayout}). → docs/spec/17-cockpit.md#the-row-grammar
 */
/**
 * A band a card's rows sit under, and the heading that opens it. A card orders its own
 * rows so a band's members are contiguous — the heading is drawn where {@link key}
 * changes, so an interleaved card draws the same heading twice rather than silently
 * regrouping. → docs/spec/17-cockpit.md#yours-then-the-fleets
 */
export interface RowGroup {
  /** What makes two adjacent rows one band. */
  key: string;
  /** The heading's word. */
  label: string;
  /** What is true of the whole band — a count, at the heading's right. */
  note?: ReactNode;
  /** `ask` where the band is your move; `quiet` is the plain heading. */
  tone?: 'ask' | 'quiet';
  /** The band's one control, at the heading's right. */
  control?: ReactNode;
  /** The band sits at the foot of its card, whatever is above it — e.g. `Fleet`. */
  foot?: boolean;
}

export interface PanelRowModel {
  /** React's identity for the row, and the card's own natural id for it. */
  key: string;
  /** The band this row belongs under. Absent on every row of a card that does not group. */
  group?: RowGroup;
  /** Who asked, as a mark — {@link Who}, never a name and never text. Distinct from {@link lamp}: the lamp is state, this is person. */
  who?: ReactNode;
  /** The state lamp, where the row has a state. */
  lamp?: ReactNode;
  /**
   * A single-glyph control at the head of the readings: whether the harness is to take
   * an interest in this row at all — distinct from {@link action}. Leads the group as
   * the eye's anchor, drawn as the state it is in, never as the verb.
   */
  toggle?: ReactNode;
  /** What the row is, in its own words. */
  title: ReactNode;
  /** Opens the thing the row is about; makes `title` the control, never the whole row. → docs/spec/17-cockpit.md#links */
  open?: () => void;
  /** The hover for {@link open}, since the title alone rarely says where it goes. */
  openTitle?: string;
  /** What the row names — `<Ref>` elements, never text or a bare number. Required; null says explicitly it has nothing to point at. */
  refs: ReactNode;
  /** The row's quantities, each said with what it is — `41m` alone is ambiguous. In `columns` grammar the labels are the headings. */
  facts?: readonly RowFact[];
  /** The row's one long sentence, held behind a marker and given up on hover/focus rather than making the row three lines tall. Prose only — never a ref or control. */
  why?: string | null;
  /** The word the marker wears where the row's state has one, so it isn't a bare `?`. A label with no {@link why} is allowed. */
  whyLabel?: string;
  /** How the label reads: `ask` is your move (red), `hold` is the harness stopped (amber), `quiet` is neither. */
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
  /** A row the harness is working on that is not an agent yet — same dashed edge and hollow lamp, own tint. */
  readying?: boolean;
  /** Work ranked but not yet handed to the executor — one stage behind {@link readying}, dotted rather than dashed. */
  queued?: boolean;
  /** Work is happening on this row right now — a green edge and slow sweep, since the rest of the row is about to be stale. */
  live?: boolean;
  /** The card's own modifier, where the sheet already carries a rule for one — e.g. `cn-goal-row`. Names a rule that exists, not a way to restyle a row. */
  className?: string;
  /** The row's hover, for what neither grammar can say. */
  hint?: string;
}

/** Whether this row has any words under its title. Per row, since a held-open line has no column for an eye to read its absence against. */
function hasWords(row: PanelRowModel): boolean {
  return (row.why != null && row.why !== '') || (row.facts !== undefined && row.facts.length > 0);
}

/** One quantity, and what it is. */
interface RowFact {
  /** What the value is: `for`, `cost`, `branch`, `queued`. Beside the value in `facts`, column heading in `columns`. */
  label: string;
  value: ReactNode;
  /** Amber — this fact is the reason the row is not moving. */
  alarm?: boolean;
}

/**
 * Which slots any of a card's rows fill. Read once per card and shared by both
 * grammars: a slot no row fills draws no column, and a slot one row fills is held open
 * on all of them, which is what makes an empty cell mean "no verdict" rather than nothing.
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
 * How a card's rows are cut: one line, or two. Every slot, its order and its width are
 * the same in both — only the wrap differs. `stacked` keeps identity (lamp, switch,
 * who, subject, refs) on the first line and drops readings to a second line under the
 * subject. `stacked` is a ceiling, not a shape: a stacked card carries both templates
 * and `console.css` picks on a container query — see {@link unstackedTemplate}.
 * → [17](../../../docs/spec/17-cockpit.md#the-row-grammar)
 */
type RowLayout = 'line' | 'stacked';

/**
 * Where a row's words go. `marker` (default) hides the sentence behind a `?`, right
 * where the sentence is a paragraph. `subline` draws them under the title instead,
 * right where the sentence is a clause — a fact about what the server writes, not a
 * layout preference. → [17](../../../docs/spec/17-cockpit.md#the-row-grammar)
 */
type RowWords = 'marker' | 'subline';

/** Every rail is a ceiling, not a width — fixed, they were sized against a full-width card and overran a half-width one. */
const rail = (w: string): string => `minmax(0, var(${w}))`;

/** The slots that say what the row is. Both layouts keep them on the first line, in this order. */
function identityColumns(has: SlotsUsed): string[] {
  return [
    has.lamp ? 'var(--cn-w-lamp)' : '',
    // A width, not a ceiling: the same glyph on every row, so it fixes the subject's left edge.
    has.who ? 'var(--cn-w-who)' : '',
    // The subject has a floor: `1fr` takes what's left, so with nothing below it the rails never shrink.
    'minmax(var(--cn-w-title), 1fr)',
  ];
}

/** The slots that say how the row stands — columns after the subject on line layout, the strip's own columns on stacked. */
function readingColumns(has: SlotsUsed): string[] {
  return [
    // A width rather than a ceiling: the same glyph on every row, so it is the group's fixed left edge.
    has.toggle ? 'var(--cn-w-eye)' : '',
    has.why ? rail(has.whyLabel ? '--cn-w-state' : '--cn-w-why') : '',
    has.reading ? rail('--cn-w-read') : '',
    has.chips ? rail('--cn-w-chips') : '',
    has.action ? rail('--cn-w-act') : '',
  ];
}

function gridTemplate(has: SlotsUsed, layout: RowLayout): string {
  // The stacked cut keeps readings off this rail entirely — they are the strip's own columns.
  const columns = layout === 'stacked' ? identityColumns(has) : identityColumns(has).concat(readingColumns(has));
  return columns
    .concat(has.refs ? rail('--cn-w-refs') : '')
    .filter((part) => part !== '')
    .join(' ');
}

/** The readings' slots, at a width the caller chooses. Ordered by how often the reading exists, so the ragged end collects where an eye is not scanning. */
function stripColumns(has: SlotsUsed, width: (token: string) => string, facts: string): string[] {
  return [
    has.toggle ? 'var(--cn-w-eye)' : '',
    has.reading ? width('--cn-w-read') : '',
    has.why ? width(has.whyLabel ? '--cn-w-state' : '--cn-w-why') : '',
    has.chips ? width('--cn-w-chips') : '',
    has.action ? width('--cn-w-act') : '',
    has.facts ? facts : '',
  ];
}

function stripTemplate(has: SlotsUsed): string {
  return stripColumns(has, rail, 'minmax(0, 1fr)')
    .filter((part) => part !== '')
    .join(' ');
}

/** A rail at its width, for the cut where giving any of it back moves a column. */
const fixed = (w: string): string => `var(${w})`;

/**
 * The stacked row's other rail: the strip's own slots laid out beside the subject, for
 * a card wide enough to hold them on one line. In the strip's order, not
 * {@link readingColumns}'s, because the wide cut is `display: contents` and drops its
 * children into the row's grid where they already stand. Every track here is a width,
 * not a ceiling, because each row is its own grid element.
 */
function unstackedTemplate(has: SlotsUsed): string {
  return identityColumns(has)
    .concat(stripColumns(has, fixed, 'var(--cn-w-facts)'))
    .concat(has.refs ? fixed('--cn-w-refs') : '')
    .filter((part) => part !== '')
    .join(' ');
}

/** A card's rows — the whole set, because which slots exist is a union across the rows and they must be seen together. */
export function PanelRows({
  rows,
  layout = 'line',
  rail,
  words = 'marker',
}: {
  rows: readonly PanelRowModel[];
  layout?: RowLayout;
  /** The rows the rail is measured from, where a card draws its list in more than one call — measuring per call would let one band re-cut another's columns. */
  rail?: readonly PanelRowModel[];
  words?: RowWords;
}): JSX.Element {
  const has = slotsUsed(rail ?? rows);
  // A card whose words went to the sub-line holds open no column for them.
  const rails = words === 'subline' ? { ...has, why: false, whyLabel: false, facts: false } : has;
  const sub = words === 'subline';
  // On each row, never on the list: `.cn-rows` is a flex column, and grid-template-columns applies to nothing there.
  const columns = gridTemplate(rails, layout);
  const strip = layout === 'stacked' ? stripTemplate(rails) : undefined;
  // Carried alongside rather than instead: only the sheet can see the card's width. → unstackedTemplate
  const line = layout === 'stacked' ? unstackedTemplate(rails) : undefined;
  // The band the last row was in, so a heading is drawn where it changes.
  let band: string | undefined;
  return (
    <div className="cn-rows">
      {rows.map((row) => {
        const opens = row.group !== undefined && row.group.key !== band;
        band = row.group?.key;
        return (
          <Fragment key={row.key}>
            {opens && row.group !== undefined && <GroupHead group={row.group} />}
            {strip === undefined || line === undefined ? (
              <FactsRow row={row} has={rails} columns={columns} sub={sub} />
            ) : (
              <StackedRow row={row} has={rails} columns={columns} line={line} strip={strip} sub={sub} />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

/**
 * A band's heading. Not a row — it fills the card's width rather than sitting on the
 * rail. Exported because a band can have no rows and still have a heading (see
 * {@link RowGroup.foot}); the same component either way, so the two cannot drift.
 */
export function GroupHead({ group }: { group: RowGroup }): JSX.Element {
  const cls = ['cn-group', group.tone === 'ask' ? 'cn-group-ask' : '', group.foot === true ? 'cn-group-foot' : '']
    .filter((part) => part !== '')
    .join(' ');
  return (
    <div className={cls}>
      {group.label}
      {group.note !== undefined && <span className="cn-group-n">{group.note}</span>}
      {group.control}
    </div>
  );
}

/** The row as a line of quantities on the card's own rail — same slot order and width on every card. A slot the row does not fill draws an empty cell, which is what makes it mean "no verdict". */
function FactsRow({
  row,
  has,
  columns,
  sub,
}: {
  row: PanelRowModel;
  has: SlotsUsed;
  columns: string;
  sub: boolean;
}): JSX.Element {
  return (
    <div
      className={rowClass(row, `cn-row cn-frow${sub && hasWords(row) ? ' cn-subrow' : ''}`)}
      style={{ gridTemplateColumns: columns }}
      title={row.hint}
    >
      {has.lamp && <span className="cn-slot">{row.lamp}</span>}
      {has.who && <span className="cn-slot">{row.who}</span>}
      <Subject row={row} facts={!sub} />
      {has.toggle && <span className="cn-slot">{row.toggle}</span>}
      {has.why && (
        <span className={`cn-slot ${row.whyLabel === undefined ? 'cn-slot-why' : ''}`}>
          <Why row={row} />
        </span>
      )}
      {has.reading && <span className="cn-slot cn-slot-read">{row.reading}</span>}
      {has.chips && <span className="cn-slot">{row.chips}</span>}
      {has.action && <span className="cn-slot">{row.action}</span>}
      {has.refs && <span className="cn-refs">{row.refs}</span>}
      {sub && <SubLine row={row} />}
    </div>
  );
}

/** The row's words, under its title: quantities lead, sentence follows, on one wrapping line. The sentence is the server's verbatim text and wraps rather than ellipsizing. → {@link RowWords} */
function SubLine({ row }: { row: PanelRowModel }): JSX.Element | null {
  const why = row.why != null && row.why !== '' ? row.why : null;
  const facts = row.facts !== undefined && row.facts.length > 0;
  if (!facts && why === null) return null;
  return (
    <span className="cn-rowsub">
      <Facts facts={row.facts} />
      {why !== null && <span className="cn-said">{why}</span>}
    </span>
  );
}

/**
 * The row cut in two: what it is on the first line, how it stands on the second. The
 * strip sits under the subject and stops at the refs rule. It is drawn before the refs
 * in the markup and after them on the glass — both placed by hand, so a screen reader
 * gets the row's state before its destinations. Nothing here is placed by an inline
 * style: both rails and the subject's column index ride as custom properties, because
 * an inline `grid-template-columns` is the one declaration a container query cannot
 * outrank, and the query is what makes the cut a ceiling rather than a shape.
 */
function StackedRow({
  row,
  has,
  columns,
  line,
  strip,
  sub,
}: {
  row: PanelRowModel;
  has: SlotsUsed;
  columns: string;
  line: string;
  strip: string;
  sub: boolean;
}): JSX.Element {
  // Where the subject sits on the identity rail; counted since the slots ahead are each drawn only where filled.
  const subject = 1 + [has.lamp, has.who].filter(Boolean).length;
  const readings = has.toggle || has.why || has.reading || has.chips || has.action || has.facts;
  const rails = {
    '--cn-cols-stacked': columns,
    '--cn-cols-line': line,
    '--cn-strip-cols': strip,
    '--cn-subject': String(subject),
  } as CSSProperties;
  return (
    <div
      className={rowClass(row, `cn-row cn-frow cn-srow${sub && hasWords(row) ? ' cn-subrow' : ''}`)}
      style={rails}
      title={row.hint}
    >
      {has.lamp && <span className="cn-slot">{row.lamp}</span>}
      {has.who && <span className="cn-slot">{row.who}</span>}
      <Subject row={row} facts={false} />
      {/* A card where no row has anything to report draws no strip, keeping the one-line shape. */}
      {readings && (
        <span className="cn-rowreads">
          {has.toggle && <span className="cn-slot">{row.toggle}</span>}
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
      {has.refs && <span className="cn-refs">{row.refs}</span>}
      {sub && <SubLine row={row} />}
    </div>
  );
}

/** The name, and — in `facts` grammar — the quantities under it. A `button` exactly when the row opens something; refs stay outside it either way. */
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

/** The three readings a row's own word can carry: something asked of you, something held, or the row simply going. `quiet` is the absence of a verdict, not a fourth one. */
const WHY_TONE: Record<string, string> = { ask: ' t-red tag-fill', hold: ' t-amber tag-fill', quiet: '' };

/**
 * What is going on with this row, and the sentence behind it. A `button` rather than a
 * hover target, so the bubble opens on `:focus-visible` too. The bubble is a sibling of
 * the button, never its child, since a tooltip inside a control is read as part of its name.
 */
function Why({ row }: { row: PanelRowModel }): JSX.Element | null {
  // Which side the bubble opens on, held per marker since the answer depends on scroll position.
  const [above, setAbove] = useState(false);
  const at = useRef<HTMLSpanElement>(null);
  const why = row.why != null && row.why !== '' ? row.why : null;
  const label = row.whyLabel;
  if (why === null && label === undefined) return null;
  const tone = label === undefined ? '' : ` cn-why-chip tag${WHY_TONE[row.whyTone ?? 'quiet']}`;
  const place = (): void => setAbove(noRoomBelow(at.current));
  return (
    <span className={above ? 'cn-why cn-why-above' : 'cn-why'} ref={at} onMouseEnter={place} onFocus={place}>
      <button
        type="button"
        className={`cn-why-mark${tone}`}
        aria-label={label === undefined ? 'Why this row is here' : `${label} — what this means`}
        // A label with nothing behind it is still a button (keyboard-reachable), but with no bubble.
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

/** Roughly what the bubble needs under the row, in pixels — an estimate, since the bubble is `display: none` until wanted. */
const TIP_ROOM = 140;

/** Whether the marker's bubble would be clipped where it normally opens. Measured against the nearest scroller, or the viewport with none. */
function noRoomBelow(at: HTMLElement | null): boolean {
  if (at === null || typeof window === 'undefined') return false;
  const mark = at.getBoundingClientRect();
  const clip = scroller(at);
  const bottom = clip === null ? window.innerHeight : clip.getBoundingClientRect().bottom;
  const top = clip === null ? 0 : clip.getBoundingClientRect().top;
  // Only flip where flipping helps: a box too short either way keeps its usual side.
  return mark.bottom + TIP_ROOM > bottom && mark.top - TIP_ROOM >= top;
}

/** The nearest ancestor that clips its overflow, or null for the viewport. */
function scroller(from: HTMLElement): HTMLElement | null {
  for (let at = from.parentElement; at !== null; at = at.parentElement) {
    const overflow = getComputedStyle(at).overflowY;
    if (overflow === 'auto' || overflow === 'scroll' || overflow === 'hidden') return at;
  }
  return null;
}

function rowClass(row: PanelRowModel, base: string): string {
  return [
    base,
    row.spent === true ? 'cn-spent' : '',
    row.desk === true ? 'cn-desk' : '',
    row.readying === true ? 'cn-readying' : '',
    row.queued === true ? 'cn-queued' : '',
    row.live === true ? 'cn-live' : '',
    row.className ?? '',
  ]
    .filter((part) => part !== '')
    .join(' ');
}
