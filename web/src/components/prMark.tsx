import type { HTMLAttributes, JSX, RefObject } from 'react';
import { BareButton } from './button.js';

// → docs/spec/17-cockpit.md

type Face = Pick<
  HTMLAttributes<HTMLElement>,
  'className' | 'aria-label' | 'onMouseEnter' | 'onFocus' | 'onMouseLeave' | 'onBlur' | 'children'
>;

/** A pull request's mark: a press into its page when `onOpen` is given, a focusable reading when not. */
export function PrMark({
  anchor,
  onOpen,
  idleRole,
  ...face
}: Face & { anchor: RefObject<HTMLElement | null>; onOpen: (() => void) | undefined; idleRole?: 'img' }): JSX.Element {
  return onOpen === undefined ? (
    <span ref={anchor as RefObject<HTMLSpanElement>} tabIndex={0} role={idleRole} {...face} />
  ) : (
    <BareButton
      buttonRef={anchor as RefObject<HTMLButtonElement>}
      usage={{ counted: 'pr.view' }}
      onClick={onOpen}
      {...face}
    />
  );
}
