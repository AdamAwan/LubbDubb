import { useCallback, useEffect, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * Inline saving-feedback primitives. Every cockpit button that hits the server
 * runs through these so the user sees a request in flight (spinner + disabled,
 * which also blocks a double-fire) and a brief ✓ / ✕ flash on settle — otherwise
 * a fast server round-trip looks like nothing happened.
 */

type AsyncPhase = 'idle' | 'pending' | 'done' | 'error';

/** The border-flash class for a settled phase; layered as a box-shadow ring so it
 * works over any button background (primary/ghost/danger) without touching layout. */
function flashClass(phase: AsyncPhase): string {
  return phase === 'done' ? 'is-done' : phase === 'error' ? 'is-error' : '';
}

/**
 * Drives one async action's lifecycle for button feedback: `pending` while it's in
 * flight, then a transient `done`/`error` before settling back to `idle`. Ignores
 * re-entrant calls while pending; reset timers are cleared on unmount.
 */
export function useAsyncAction(): {
  phase: AsyncPhase;
  run: (fn: () => Promise<unknown> | unknown) => Promise<void>;
} {
  const [phase, setPhase] = useState<AsyncPhase>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const settle = useCallback((next: AsyncPhase, holdMs: number) => {
    if (!mounted.current) return;
    setPhase(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      if (mounted.current) setPhase('idle');
    }, holdMs);
  }, []);

  const run = useCallback(
    async (fn: () => Promise<unknown> | unknown) => {
      if (inFlight.current) return;
      inFlight.current = true;
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      if (mounted.current) setPhase('pending');
      try {
        await fn();
        settle('done', 1200);
      } catch {
        settle('error', 2200);
      } finally {
        inFlight.current = false;
      }
    },
    [settle],
  );

  return { phase, run };
}

/**
 * A button that runs an async `onClick` and shows its progress inline. `className`
 * is the set of `.btn` modifiers (e.g. `primary`, `ghost`) — the base `btn` class
 * is applied here. `pendingLabel` replaces the whole label while in flight (pass a
 * bare spinner for icon-only buttons); otherwise a spinner is prepended.
 */
export function AsyncButton({
  onClick,
  children,
  className = '',
  disabled,
  pendingLabel,
  ...rest
}: {
  onClick: () => Promise<unknown> | unknown;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  pendingLabel?: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'className' | 'disabled' | 'children'>) {
  const { phase, run } = useAsyncAction();
  const cls = ['btn', className, flashClass(phase)].filter(Boolean).join(' ');
  return (
    <button
      type="button"
      {...rest}
      className={cls}
      disabled={disabled || phase === 'pending'}
      aria-busy={phase === 'pending'}
      onClick={() => void run(onClick)}
    >
      {phase === 'pending' ? (
        (pendingLabel ?? (
          <>
            <span className="spinner" aria-hidden />
            {children}
          </>
        ))
      ) : (
        <>{children}</>
      )}
    </button>
  );
}

/**
 * A `type="submit"` button that reflects an externally-driven {@link useAsyncAction}
 * phase — for forms where the action fires on submit (Enter or click), so the button
 * can't own the async call itself. Wire the form's `onSubmit` to the same `run`.
 */
export function SubmitButton({
  phase,
  children,
  className = '',
}: {
  phase: AsyncPhase;
  children: ReactNode;
  className?: string;
}) {
  const cls = ['btn', className, flashClass(phase)].filter(Boolean).join(' ');
  return (
    <button type="submit" className={cls} disabled={phase === 'pending'} aria-busy={phase === 'pending'}>
      {phase === 'pending' && <span className="spinner" aria-hidden />}
      {children}
    </button>
  );
}
