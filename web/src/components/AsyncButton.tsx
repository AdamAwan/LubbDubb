import { useCallback, useEffect, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { buttonClass } from './button.js';
import type { ButtonLook } from './button.js';

/**
 * Inline saving-feedback primitives. Every cockpit button that hits the server
 * runs through these so the user sees a request in flight (spinner + disabled,
 * which also blocks a double-fire) and a brief ✓ / ✕ flash on settle — otherwise
 * a fast server round-trip looks like nothing happened.
 *
 * **A refused click is kept, in the server's own words.** The flash alone said
 * only that something went wrong, and it faded in two seconds — so a route that
 * refuses for a reason the operator can *act on* ("note is required — validation
 * is not clear on this goal") reached them as a button that did nothing when
 * clicked. Every refusal already arrives here as an `Error` carrying the route's
 * `{error}` string (`api.ts`'s `json`), and it is thrown away at exactly one
 * place: the `catch` below. {@link useAsyncAction} keeps it until the next run,
 * and {@link AsyncButton} both hangs it off the button's own `title` — which
 * costs no layout anywhere, so every call site gains it — and hands it to
 * `onRefused` for the stations that draw it.
 */

type AsyncPhase = 'idle' | 'pending' | 'done' | 'error';

/** The border-flash class for a settled phase; layered as a box-shadow ring so it
 * works over any button background (primary/ghost/danger) without touching layout. */
function flashClass(phase: AsyncPhase): string {
  return phase === 'done' ? 'is-done' : phase === 'error' ? 'is-error' : '';
}

/**
 * What a rejection says, for the operator rather than for a log.
 *
 * Every route refuses with `{error}` and `api.ts` rethrows that as the `Error`'s
 * message, so the message *is* the refusal. The fallback is for the rejection
 * that is not one — a dropped socket, a bug in the handler — where a blank line
 * would be worse than an admission.
 */
function refusalText(err: unknown): string {
  const message = err instanceof Error ? err.message.trim() : '';
  return message.length > 0 ? message : 'That was refused, and nothing said why. Check the Errors panel.';
}

/**
 * Drives one async action's lifecycle for button feedback: `pending` while it's in
 * flight, then a transient `done`/`error` before settling back to `idle`. Ignores
 * re-entrant calls while pending; reset timers are cleared on unmount.
 *
 * `refusal` outlives the flash on purpose: the ring says *that* it failed and is
 * gone in two seconds, and the sentence is the half worth reading. It is cleared
 * when the next run starts, so what is on screen always describes the last click.
 */
export function useAsyncAction(): {
  phase: AsyncPhase;
  refusal: string | null;
  run: (fn: () => Promise<unknown> | unknown) => Promise<void>;
} {
  const [phase, setPhase] = useState<AsyncPhase>('idle');
  const [refusal, setRefusal] = useState<string | null>(null);
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
      if (mounted.current) setRefusal(null);
      try {
        await fn();
        settle('done', 1200);
      } catch (err) {
        if (mounted.current) setRefusal(refusalText(err));
        settle('error', 2200);
      } finally {
        inFlight.current = false;
      }
    },
    [settle],
  );

  return { phase, refusal, run };
}

/**
 * A button that runs an async `onClick` and shows its progress inline.
 *
 * Its look is [`Button`](./button.tsx)'s, through the same {@link buttonClass}
 * seam: `tone`, `ghost` and `size` are props and `className` is shape only. It
 * used to take the whole class string and prepend `btn` to it unconditionally,
 * which is how the nine console buttons went out wearing `class="btn cn-btn"` —
 * two base families on one element, back when there were two.
 *
 * `pendingLabel` replaces the whole label while in flight (pass a
 * bare spinner for icon-only buttons); otherwise a spinner is prepended.
 *
 * A refusal replaces the button's `title` while it stands, so the reason is one
 * hover away from *any* of these; `onRefused` is for the stations with room to
 * draw it, which is the only way an operator who cannot hover reads it.
 */
export function AsyncButton({
  onClick,
  onRefused,
  children,
  tone,
  ghost,
  size,
  className,
  disabled,
  pendingLabel,
  ...rest
}: {
  onClick: () => Promise<unknown> | unknown;
  /** The route's own words when this click was refused. Called on every rejection. */
  onRefused?: (message: string) => void;
  children: ReactNode;
  disabled?: boolean;
  pendingLabel?: ReactNode;
} & ButtonLook &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'className' | 'disabled' | 'children'>) {
  const { phase, refusal, run } = useAsyncAction();
  const cls = buttonClass({ tone, ghost, size, className }, flashClass(phase));
  return (
    <button
      type="button"
      {...rest}
      className={cls}
      title={refusal ?? rest.title}
      disabled={disabled || phase === 'pending'}
      aria-busy={phase === 'pending'}
      onClick={() =>
        void run(async () => {
          try {
            return await onClick();
          } catch (err) {
            // Reported *and* rethrown: the hook settles the flash off the same
            // rejection, and a station that swallowed it here would leave the
            // ring saying the click went through.
            onRefused?.(refusalText(err));
            throw err;
          }
        })
      }
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
  tone,
  ghost,
  size,
  className,
}: {
  phase: AsyncPhase;
  children: ReactNode;
} & ButtonLook) {
  const cls = buttonClass({ tone, ghost, size, className }, flashClass(phase));
  return (
    <button type="submit" className={cls} disabled={phase === 'pending'} aria-busy={phase === 'pending'}>
      {phase === 'pending' && <span className="spinner" aria-hidden />}
      {children}
    </button>
  );
}
