import { useCallback, useRef, useState, type CSSProperties, type JSX, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

// → docs/spec/17-cockpit.md

const TIP_WIDTH = 320;

const TIP_ROOM = 220;

interface TipAnchor {
  anchor: RefObject<HTMLElement | null>;
  at: CSSProperties | null;
  open: () => void;
  close: () => void;
}

export function useTip(): TipAnchor {
  const anchor = useRef<HTMLElement>(null);
  const [at, setAt] = useState<CSSProperties | null>(null);

  const open = useCallback(() => {
    const box = anchor.current?.getBoundingClientRect();
    if (box === undefined) return;
    const left = Math.max(8, Math.min(box.left - 6, window.innerWidth - TIP_WIDTH - 8));
    const below = window.innerHeight - box.bottom;
    setAt(
      below < TIP_ROOM && box.top > below
        ? { left, bottom: window.innerHeight - box.top + 8, top: 'auto' }
        : { left, top: box.bottom + 8 },
    );
  }, []);

  const close = useCallback(() => setAt(null), []);

  return { anchor, at, open, close };
}

export function Tip({ at, children }: { at: CSSProperties; children: ReactNode }): JSX.Element {
  return createPortal(
    <span className="tip" style={at}>
      {children}
    </span>,
    document.body,
  );
}
