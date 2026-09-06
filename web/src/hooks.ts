import { useEffect, useState, useSyncExternalStore } from 'react';
import { subscribeThemeUnsaved, themeUnsaved } from './cockpit/theme.js';

// → docs/spec/17-cockpit.md

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function useThemeUnsaved(): boolean {
  return useSyncExternalStore(subscribeThemeUnsaved, themeUnsaved, themeUnsaved);
}
