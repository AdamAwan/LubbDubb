import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppErrorsPayload } from '../types.js';
import { api } from '../api.js';

// → docs/spec/39-app-errors.md#in-the-cockpit

const REFRESH_MS = 60_000;

export function useAppErrors(): { reading: AppErrorsPayload | null; failed: boolean } {
  const [reading, setReading] = useState<AppErrorsPayload | null>(null);
  const [failed, setFailed] = useState(false);
  const live = useRef(true);

  const reload = useCallback((): void => {
    api.getAppErrors().then(
      (payload) => {
        if (!live.current) return;
        setReading(payload);
        setFailed(false);
      },
      () => {
        if (live.current) setFailed(true);
      },
    );
  }, []);

  useEffect(() => {
    live.current = true;
    reload();
    const timer = setInterval(reload, REFRESH_MS);
    return () => {
      live.current = false;
      clearInterval(timer);
    };
  }, [reload]);

  return { reading, failed };
}
