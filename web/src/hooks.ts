import { useEffect, useState, useSyncExternalStore } from 'react';
import { subscribeThemeUnsaved, themeUnsaved } from './cockpit/theme.js';

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

/**
 * Whether the Theme section is holding an unsaved edit — the marker on the cog and
 * on the Theme tab. Subscribes to the module store in `cockpit/theme.ts`, since the
 * section that sets it is not an ancestor of either surface that draws it.
 */
export function useThemeUnsaved(): boolean {
  return useSyncExternalStore(subscribeThemeUnsaved, themeUnsaved, themeUnsaved);
}
