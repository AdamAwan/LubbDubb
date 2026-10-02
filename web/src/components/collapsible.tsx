import { useId, useState, type JSX, type ReactNode } from 'react';
import type { ControlUsage, UsageSubject } from '../types.js';
import { BareButton } from './button.js';

// → docs/spec/17-cockpit.md

export type FoldSubject = {
  [S in UsageSubject]: `${S}.expand` | `${S}.close` extends ControlUsage ? S : never;
}[UsageSubject];

/**
 * The one way a fold is pressed: a boxed chevron, the label, and a hint saying what a press does.
 * Drawn bare so it can sit inside a heading that carries other things beside it.
 */
export function FoldToggle({
  subject,
  open,
  onToggle,
  label,
  hint = true,
  logClose = true,
  controls,
  className,
  title,
}: {
  subject: FoldSubject;
  open: boolean;
  onToggle: (open: boolean) => void;
  label: ReactNode;
  /** False drops the hide/show word, where the chevron is the whole control. */
  hint?: boolean;
  /** False where only an opening is a reading. */
  logClose?: boolean;
  controls?: string;
  className?: string;
  title?: string;
}): JSX.Element {
  return (
    <BareButton
      usage={open ? `${subject}.close` : `${subject}.expand`}
      logs={!open || logClose}
      title={title}
      className={className === undefined ? 'fold-toggle' : `fold-toggle ${className}`}
      aria-expanded={open}
      aria-controls={controls}
      onClick={() => onToggle(!open)}
    >
      <i className={open ? 'fold-caret open' : 'fold-caret'} aria-hidden="true">
        ›
      </i>
      <span className="fold-label">{label}</span>
      {hint && <span className="fold-hint">{open ? 'hide' : 'show'}</span>}
    </BareButton>
  );
}

/**
 * A titled block whose body can be folded away. `panel` is a bordered box with a header strip, for
 * a group that owns the rows under it; `inline` is a quiet reveal inside running content. Held by
 * the caller when `open` is passed, by itself otherwise. The body stays mounted while shut, as a
 * `<details>` keeps it, so a fold holding a live stream does not drop it.
 */
export function Collapsible({
  subject,
  title,
  aside,
  look = 'inline',
  open: held,
  defaultOpen = false,
  onToggle,
  logClose,
  className,
  children,
}: {
  subject: FoldSubject;
  title: ReactNode;
  aside?: ReactNode;
  look?: 'panel' | 'inline';
  open?: boolean;
  defaultOpen?: boolean;
  onToggle?: (open: boolean) => void;
  logClose?: boolean;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  const [own, setOwn] = useState(defaultOpen);
  const open = held ?? own;
  const bodyId = useId();
  const flip = (next: boolean) => {
    if (held === undefined) setOwn(next);
    onToggle?.(next);
  };
  const classes = ['fold', `fold-${look}`, open ? 'is-open' : 'is-shut', className].filter(Boolean).join(' ');
  return (
    <section className={classes}>
      <header className="fold-head">
        <FoldToggle subject={subject} open={open} onToggle={flip} label={title} logClose={logClose} controls={bodyId} />
        {aside !== undefined && <div className="fold-aside">{aside}</div>}
      </header>
      <div className="fold-body" id={bodyId} hidden={!open}>
        {children}
      </div>
    </section>
  );
}
