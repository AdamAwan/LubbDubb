import { useEffect, useRef } from 'react';
import type { JSX, ReactNode } from 'react';

/**
 * The cockpit's one overlay: a backdrop, a surface, and the three ways out of it.
 *
 * It exists because thirteen surfaces hand-wrote the same three lines —
 * `<div className="plan-modal-backdrop" onClick={onClose}>`, a surface with an
 * `onClick={(e) => e.stopPropagation()}` guard, a `pm-head` and a `pm-foot` — and
 * the copy dropped something on eleven of them: **Escape closed two of the
 * thirteen.** `HatchModal` and the prompt viewer registered a key listener;
 * nothing else did, so the modal covering the goal an operator is reading could
 * only be dismissed by finding a small button, and every check the repo runs was
 * green about it. That is the failure a component removes once — the same
 * argument as [the control kit](./controls.tsx), one layer out.
 *
 * **The rules it keeps:**
 *
 * - **Three ways out, always.** The backdrop, the close control, and Escape. A
 *   thing that covers the console must not have exactly one exit.
 * - **The face is a prop, never a class string.** The `--cn-*` console family and
 *   the shared family are a real distinction, not a namespace
 *   ([17](../../../docs/spec/17-cockpit.md#tokens)), so the overlay names which
 *   face it wears and the two sheets keep their own classes. A caller cannot mint
 *   a seventh.
 * - **Escape closes the layer on top, never the one behind it.** The dismissable
 *   layers are a stack and only its last entry answers the key. A nested modal —
 *   the prompt viewer inside the settings page, the questionnaire inside a
 *   "Needs you" panel — is always the one opened last, so registration order *is*
 *   depth, and dismissing the inner sheet cannot take its host down with it.
 *   `PromptsTab` relied on nobody else listening for that; now it is a rule.
 *
 * `armDismiss` is the seam that rule is asserted through — an effect is not
 * reachable from `renderToStaticMarkup`, which is how every other cockpit
 * component is tested. → `test/modal.test.ts`
 *
 * → docs/spec/17-cockpit.md#the-modal
 */
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
  /** A modifier on the surface — `qn-modal`, `rp-modal` — never a second face. */
  className?: string;
  /** The dialog's accessible name, where the visible title is not one. */
  label?: string;
  /** Drawn as a `pm-head`. A face with a head of its own passes it as a child. */
  title?: ReactNode;
  /** Chips or refs before the title — the thing this modal is *about*. */
  lead?: ReactNode;
  /** Chips after the title — what state it is in. */
  chips?: ReactNode;
  /** The action row. Last child of the surface, so it never scrolls away. */
  foot?: ReactNode;
  onClose: () => void;
  children?: ReactNode;
}): JSX.Element {
  // Read through a ref so an inline `onClose` re-render cannot re-register the
  // layer, which would shuffle it above whatever is genuinely on top of it.
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
          <div className="pm-head">
            {lead}
            <span className="pm-title">{title}</span>
            {chips}
            <button className="btn ghost small pm-close" onClick={onClose}>
              close
            </button>
          </div>
        )}
        {children}
        {foot !== undefined && <div className="pm-foot">{foot}</div>}
      </Surface>
    </div>
  );
}

/** Which pair of classes the overlay wears — never which colours it draws in. */
type ModalFace = 'modal' | 'sheet' | 'drawer' | 'panel' | 'hatch' | 'prompt';

const FACES: Record<ModalFace, { backdrop: string; surface: string; element: 'div' | 'section' }> = {
  modal: { backdrop: 'plan-modal-backdrop', surface: 'plan-modal', element: 'div' },
  sheet: { backdrop: 'plan-modal-backdrop', surface: 'plan-sheet', element: 'div' },
  drawer: { backdrop: 'drawer-backdrop', surface: 'drawer', element: 'div' },
  panel: { backdrop: 'cn-backdrop', surface: 'cn-panel', element: 'section' },
  hatch: { backdrop: 'cn-backdrop', surface: 'cn-hatch', element: 'div' },
  prompt: { backdrop: 'prompt-backdrop', surface: 'prompt-modal', element: 'div' },
};

/** The layers a key could close, innermost last. Only the last one answers. */
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

/** Keeps a click inside the dialog from reaching the backdrop's close handler. */
function stop(event: { stopPropagation: () => void }): void {
  event.stopPropagation();
}
