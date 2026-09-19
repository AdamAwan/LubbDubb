import type { JSX, ReactNode } from 'react';

// → docs/spec/17-cockpit.md#the-panes

export interface PanelTab {
  /** Also the id the tab and its panel are addressed by: `cn-tab-<id>`, `cn-pane-<id>`. */
  id: string;
  label: ReactNode;
  /** The second line: what this tab's pane says in a few words. */
  reading?: ReactNode;
  /** 0–100, or null where there is no proportion to draw. */
  meter?: number | null;
  /** A `cn-t-*` alias, which is where the tab's hue comes from. */
  tone?: string;
  title?: string;
}

/**
 * A row of tabs and the panel they select, drawn as one object.
 *
 * The tabs sit on a bar of their own and the selected one is cut out of the
 * panel below it — same ground, no bottom edge, its own top corners. That join
 * is the whole point: a row of separate cards above a separate panel reads as
 * two surfaces that happen to be stacked, and nothing about it says the row is
 * what changes what is underneath.
 *
 * A tab carries a reading and a meter as well as a name, because the goal page's
 * tabs are also its stages — where it is, not only where you can go.
 */
export function TabbedPanel({
  tabs,
  selected,
  onSelect,
  label,
  children,
}: {
  tabs: readonly PanelTab[];
  selected: string;
  onSelect: (id: string) => void;
  /** Names the row for a screen reader — what this set of tabs is about. */
  label: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="cn-tabp">
      <div className="cn-tabp-bar" role="tablist" aria-label={label}>
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`cn-tab-${t.id}`}
            aria-selected={t.id === selected}
            aria-controls={`cn-pane-${t.id}`}
            className={`cn-tabp-tab ${t.tone ?? ''} ${t.id === selected ? 'cn-on' : ''}`}
            title={t.title}
            onClick={() => onSelect(t.id)}
          >
            <span className="cn-tabp-name">{t.label}</span>
            {t.reading !== undefined && <span className="cn-tabp-read">{t.reading}</span>}
            {/* Drawn only for a tab with a proportion to draw. An empty bar under
                "no checks" would report every check outstanding, which is the one
                thing a null meter exists to keep it from saying. */}
            {t.meter !== undefined && (
              <span className={`cn-tabp-meter ${t.meter === null ? 'cn-none' : ''}`}>
                {t.meter !== null && <i style={{ width: `${t.meter}%` }} />}
              </span>
            )}
          </button>
        ))}
      </div>
      <div
        className="cn-tabp-body"
        id={`cn-pane-${selected}`}
        role="tabpanel"
        aria-labelledby={`cn-tab-${selected}`}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  );
}
