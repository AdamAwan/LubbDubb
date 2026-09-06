import { useEffect, useRef, useState } from 'react';
import { useAsyncAction } from './AsyncButton.js';
import { buttonClass } from './button.js';
import type { ButtonSize } from './button.js';

// → docs/spec/17-cockpit.md

export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  ghost,
  size,
  className,
  title,
  pendingLabel = 'Working…',
  resetMs = 3000,
  hotkey,
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => Promise<unknown> | unknown;
  ghost?: boolean;
  size?: ButtonSize;
  className?: string;
  title?: string;
  pendingLabel?: string;
  resetMs?: number;
  hotkey?: string;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { phase, run } = useAsyncAction();

  const disarm = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setArmed(false);
  };

  useEffect(() => () => disarm(), []);

  const handleClick = () => {
    if (phase === 'pending') return;
    if (armed) {
      disarm();
      void run(onConfirm);
      return;
    }
    setArmed(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      setArmed(false);
    }, resetMs);
  };

  const flash = phase === 'done' ? 'is-done' : phase === 'error' ? 'is-error' : '';

  return (
    <button
      data-kn-key={hotkey}
      className={buttonClass({ tone: 'danger', ghost, size, className }, armed ? 'armed' : '', flash)}
      onClick={handleClick}
      onBlur={disarm}
      disabled={phase === 'pending'}
      aria-busy={phase === 'pending'}
      title={armed ? 'Click again to confirm' : title}
      aria-label={armed ? confirmLabel : label}
    >
      {phase === 'pending' ? (
        <>
          <span className="spinner" aria-hidden />
          {pendingLabel}
        </>
      ) : armed ? (
        confirmLabel
      ) : (
        label
      )}
    </button>
  );
}
