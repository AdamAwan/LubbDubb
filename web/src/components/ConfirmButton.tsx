import { useEffect, useRef, useState } from 'react';
import { useAsyncAction } from './AsyncButton.js';

/**
 * Two-step button for destructive actions: the first click only *arms* it
 * (harmless), a deliberate second click fires `onConfirm`. Arming auto-resets
 * after `resetMs` so a stray click can't leave it primed indefinitely. Keeps
 * an irreversible action (e.g. Kill) out of reach of a single accidental click.
 *
 * Once confirmed, the action runs through {@link useAsyncAction} so the button
 * shows a spinner while the request is in flight and a ✓ / ✕ flash on settle.
 */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  className = '',
  title,
  pendingLabel = 'Working…',
  resetMs = 3000,
  hotkey,
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => Promise<unknown> | unknown;
  className?: string;
  title?: string;
  pendingLabel?: string;
  resetMs?: number;
  /**
   * The key a surface with a keyboard presses this button by, as a `data-kn-key`
   * attribute for that surface to find — never a listener of its own.
   *
   * The whole point of it being an attribute: a keyboard that clicks the rendered
   * button cannot fire a confirmation the button is not offering, and the two
   * presses this control exists for stay two presses on the key as well.
   */
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

  // Clear any pending reset timer on unmount.
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
      className={`btn danger ${armed ? 'armed' : ''} ${flash} ${className}`.replace(/\s+/g, ' ').trim()}
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
