import { useCallback, useEffect, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { BareButton, buttonClass } from './button.js';
import type { ButtonLook, Usage } from './button.js';
import type { ControlUsage } from '../types.js';
import { logControl, placeNow } from '../cockpit/usage.js';

// → docs/spec/17-cockpit.md

type AsyncPhase = 'idle' | 'pending' | 'done' | 'error';

function flashClass(phase: AsyncPhase): string {
  return phase === 'done' ? 'is-done' : phase === 'error' ? 'is-error' : '';
}

function refusalText(err: unknown): string {
  const message = err instanceof Error ? err.message.trim() : '';
  return message.length > 0 ? message : 'That was refused, and nothing said why. Check the Errors panel.';
}

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

/** → docs/spec/34-usage-metrics.md#every-button-names-its-event */
export async function actThenLog(usage: ControlUsage, act: () => Promise<unknown> | unknown): Promise<void> {
  const at = placeNow();
  await act();
  logControl(usage, at);
}

export function AsyncButton({
  usage,
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
  onRefused?: (message: string) => void;
  children: ReactNode;
  disabled?: boolean;
  pendingLabel?: ReactNode;
} & ButtonLook &
  Usage &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'className' | 'disabled' | 'children' | 'type'>) {
  const { phase, refusal, run } = useAsyncAction();
  const cls = buttonClass({ tone, ghost, size, className }, flashClass(phase));
  return (
    <BareButton
      {...rest}
      usage={usage}
      logs={false}
      className={cls}
      title={refusal ?? rest.title}
      disabled={disabled || phase === 'pending'}
      aria-busy={phase === 'pending'}
      onClick={() =>
        void run(async () => {
          try {
            await actThenLog(usage, onClick);
          } catch (err) {
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
    </BareButton>
  );
}

export function SubmitButton({
  usage,
  logs,
  phase,
  children,
  tone,
  ghost,
  size,
  className,
}: {
  phase: AsyncPhase;
  logs?: boolean;
  children: ReactNode;
} & ButtonLook &
  Usage) {
  const cls = buttonClass({ tone, ghost, size, className }, flashClass(phase));
  return (
    <BareButton
      usage={usage}
      logs={logs}
      type="submit"
      className={cls}
      disabled={phase === 'pending'}
      aria-busy={phase === 'pending'}
    >
      {phase === 'pending' && <span className="spinner" aria-hidden />}
      {children}
    </BareButton>
  );
}
