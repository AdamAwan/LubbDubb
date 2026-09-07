import { Fragment, useRef, useState, type CSSProperties, type JSX, type ReactNode } from 'react';

// → docs/spec/17-cockpit.md

export interface RowGroup {
  key: string;
  label: string;
  note?: ReactNode;
  tone?: 'ask' | 'quiet';
  control?: ReactNode;
  foot?: boolean;
}

export interface PanelRowModel {
  key: string;
  group?: RowGroup;
  who?: ReactNode;
  lamp?: ReactNode;
  toggle?: ReactNode;
  title: ReactNode;
  open?: () => void;
  openTitle?: string;
  refs: ReactNode;
  facts?: readonly RowFact[];
  why?: string | null;
  whyLabel?: string;
  whyTone?: 'ask' | 'hold' | 'quiet';
  reading?: ReactNode;
  chips?: ReactNode;
  action?: ReactNode;
  spent?: boolean;
  desk?: boolean;
  ejected?: boolean;
  readying?: boolean;
  queued?: boolean;
  live?: boolean;
  className?: string;
  hint?: string;
}

function hasWords(row: PanelRowModel): boolean {
  return (row.why != null && row.why !== '') || (row.facts !== undefined && row.facts.length > 0);
}

interface RowFact {
  label: string;
  value: ReactNode;
  alarm?: boolean;
}

interface SlotsUsed {
  lamp: boolean;
  toggle: boolean;
  who: boolean;
  why: boolean;
  whyLabel: boolean;
  reading: boolean;
  chips: boolean;
  action: boolean;
  refs: boolean;
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

type RowLayout = 'line' | 'stacked';

type RowWords = 'marker' | 'subline';

const rail = (w: string): string => `minmax(0, var(${w}))`;

function identityColumns(has: SlotsUsed): string[] {
  return [has.lamp ? 'var(--cn-w-lamp)' : '', has.who ? 'var(--cn-w-who)' : '', 'minmax(var(--cn-w-title), 1fr)'];
}

function readingColumns(has: SlotsUsed): string[] {
  return [
    has.toggle ? 'var(--cn-w-eye)' : '',
    has.why ? rail(has.whyLabel ? '--cn-w-state' : '--cn-w-why') : '',
    has.reading ? rail('--cn-w-read') : '',
    has.chips ? rail('--cn-w-chips') : '',
    has.action ? rail('--cn-w-act') : '',
  ];
}

function gridTemplate(has: SlotsUsed, layout: RowLayout): string {
  const columns = layout === 'stacked' ? identityColumns(has) : identityColumns(has).concat(readingColumns(has));
  return columns
    .concat(has.refs ? rail('--cn-w-refs') : '')
    .filter((part) => part !== '')
    .join(' ');
}

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

const fixed = (w: string): string => `var(${w})`;

function unstackedTemplate(has: SlotsUsed): string {
  return identityColumns(has)
    .concat(stripColumns(has, fixed, 'var(--cn-w-facts)'))
    .concat(has.refs ? fixed('--cn-w-refs') : '')
    .filter((part) => part !== '')
    .join(' ');
}

export function PanelRows({
  rows,
  layout = 'line',
  rail,
  words = 'marker',
}: {
  rows: readonly PanelRowModel[];
  layout?: RowLayout;
  rail?: readonly PanelRowModel[];
  words?: RowWords;
}): JSX.Element {
  const has = slotsUsed(rail ?? rows);
  const rails = words === 'subline' ? { ...has, why: false, whyLabel: false, facts: false } : has;
  const sub = words === 'subline';
  const columns = gridTemplate(rails, layout);
  const strip = layout === 'stacked' ? stripTemplate(rails) : undefined;
  const line = layout === 'stacked' ? unstackedTemplate(rails) : undefined;
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

const WHY_TONE: Record<string, string> = { ask: ' t-red tag-fill', hold: ' t-amber tag-fill', quiet: '' };

function Why({ row }: { row: PanelRowModel }): JSX.Element | null {
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

const TIP_ROOM = 140;

function noRoomBelow(at: HTMLElement | null): boolean {
  if (at === null || typeof window === 'undefined') return false;
  const mark = at.getBoundingClientRect();
  const clip = scroller(at);
  const bottom = clip === null ? window.innerHeight : clip.getBoundingClientRect().bottom;
  const top = clip === null ? 0 : clip.getBoundingClientRect().top;
  return mark.bottom + TIP_ROOM > bottom && mark.top - TIP_ROOM >= top;
}

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
    row.ejected === true ? 'cn-ejected' : '',
    row.readying === true ? 'cn-readying' : '',
    row.queued === true ? 'cn-queued' : '',
    row.live === true ? 'cn-live' : '',
    row.className ?? '',
  ]
    .filter((part) => part !== '')
    .join(' ');
}
