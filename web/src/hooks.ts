import { useEffect, useState } from 'react';

/**
 * A clock that re-renders the caller every `intervalMs`. Used for live "elapsed"
 * counters and the heartbeat countdown, which must tick even when no server
 * event has arrived. Returns the current epoch-ms.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
