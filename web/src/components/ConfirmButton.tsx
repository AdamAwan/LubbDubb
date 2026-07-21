import { useEffect, useRef, useState } from 'react';

/**
 * Two-step button for destructive actions: the first click only *arms* it
 * (harmless), a deliberate second click fires `onConfirm`. Arming auto-resets
 * after `resetMs` so a stray click can't leave it primed indefinitely. Keeps
 * an irreversible action (e.g. Kill) out of reach of a single accidental click.
 */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  className = '',
  title,
  resetMs = 3000,
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  className?: string;
  title?: string;
  resetMs?: number;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const disarm = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setArmed(false);
  };

  // Clear any pending reset timer on unmount.
  useEffect(() => () => disarm(), []);

  const handleClick = () => {
    if (armed) {
      disarm();
      onConfirm();
      return;
    }
    setArmed(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      setArmed(false);
    }, resetMs);
  };

  return (
    <button
      className={`btn danger ${armed ? 'armed' : ''} ${className}`.trim()}
      onClick={handleClick}
      onBlur={disarm}
      title={armed ? 'Click again to confirm' : title}
      aria-label={armed ? confirmLabel : label}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}
