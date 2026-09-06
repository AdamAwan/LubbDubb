import { useEffect, useRef } from 'react';
import type { JSX, ReactNode } from 'react';
import { HeadRow } from './panel.js';
import { Button } from './button.js';

// → docs/spec/17-cockpit.md

export function Modal({
  face,
  className,
  label,
  title,
  lead,
  chips,
  foot,
  onClose,
  children,
}: {
  face: ModalFace;
  className?: string;
  label?: string;
  title?: ReactNode;
  lead?: ReactNode;
  chips?: ReactNode;
  foot?: ReactNode;
  onClose: () => void;
  children?: ReactNode;
}): JSX.Element {
  const latest = useRef(onClose);
  useEffect(() => {
    latest.current = onClose;
  });
  useEffect(() => armDismiss(() => latest.current()), []);

  const { backdrop, surface, element } = FACES[face];
  const Surface = element;
  const name = label ?? (typeof title === 'string' ? title : undefined);
  return (
    <div className={backdrop} role="presentation" onClick={onClose}>
      <Surface
        className={className === undefined ? surface : `${surface} ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={name}
        onClick={stop}
      >
        {title !== undefined && (
          <HeadRow className="pm-head">
            {lead}
            <span className="pm-title">{title}</span>
            {chips}
            <Button ghost size="small" className="pm-close" onClick={onClose}>
              close
            </Button>
          </HeadRow>
        )}
        {children}
        {foot !== undefined && <div className="pm-foot">{foot}</div>}
      </Surface>
    </div>
  );
}

type ModalFace = 'modal' | 'sheet' | 'drawer' | 'panel' | 'hatch' | 'prompt';

const FACES: Record<ModalFace, { backdrop: string; surface: string; element: 'div' | 'section' }> = {
  modal: { backdrop: 'plan-modal-backdrop', surface: 'plan-modal', element: 'div' },
  sheet: { backdrop: 'plan-modal-backdrop', surface: 'plan-sheet', element: 'div' },
  drawer: { backdrop: 'drawer-backdrop', surface: 'drawer', element: 'div' },
  panel: { backdrop: 'cn-backdrop', surface: 'cn-panel', element: 'section' },
  hatch: { backdrop: 'cn-backdrop', surface: 'cn-hatch', element: 'div' },
  prompt: { backdrop: 'prompt-backdrop', surface: 'prompt-modal', element: 'div' },
};

const OPEN: Array<{ close: () => void }> = [];

/**
 * Arm Escape for one layer and return its disarm.
 *
 * Exported for `test/modal.test.ts`: the stack discipline is the whole point of
 * doing this once, and a static render never runs the effect that installs it.
 *
 * @public seam — `test/modal.test.ts`
 */
export function armDismiss(close: () => void): () => void {
  const layer = { close };
  OPEN.push(layer);
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && OPEN[OPEN.length - 1] === layer) layer.close();
  };
  window.addEventListener('keydown', onKey);
  return () => {
    const at = OPEN.indexOf(layer);
    if (at >= 0) OPEN.splice(at, 1);
    window.removeEventListener('keydown', onKey);
  };
}

function stop(event: { stopPropagation: () => void }): void {
  event.stopPropagation();
}
