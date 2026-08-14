import { useCallback, useEffect, useRef, useState } from 'react';
import { NOWHERE, placeQuery, readPlace, type Place } from './place.js';

/**
 * The cockpit's place, kept in the address bar so the browser's own back button
 * means what it says.
 *
 * **The query string, not the path.** The token arrives in the fragment and is
 * stripped to `pathname + search` (`api.ts`), the demo is served from wherever
 * it is published, and the harness's SPA fallback answers every non-`/api` path
 * with `index.html` — a query moves under all three without a server or a base
 * path having to agree with the console about anything.
 *
 * **Every move pushes exactly one entry, and moves made in one tick are one
 * move.** Several surfaces navigate twice on a single click — the nav clears the
 * goal and then sets the tab, an ask closes its panel and then opens the goal
 * page — and two entries there would make the back button land on a state
 * nobody was ever on. So the patches apply to a ref immediately (the next `go`
 * in the same tick sees them) and the push happens once, in a microtask, from
 * whatever the place ended up being.
 *
 * A move that changes nothing pushes nothing: clicking the tab you are on is
 * not somewhere to go back from.
 */
export function useNavigation(): { place: Place; go: (patch: Partial<Place>) => void } {
  // `location` is simply undefined under node, which is how the cockpit's
  // modules are imported by the tests — the same reason `readToken` guards.
  const [place, setPlace] = useState<Place>(() =>
    typeof location === 'undefined' ? NOWHERE : readPlace(location.search),
  );
  // What the address bar is about to say. `place` lags it by a render, and the
  // second `go` of a tick must not patch the first one's input.
  const pending = useRef(place);
  const scheduled = useRef(false);

  useEffect(() => {
    const onPop = () => {
      const next = readPlace(location.search);
      pending.current = next;
      setPlace(next);
    };
    window.addEventListener('popstate', onPop);
    // Normalise the entry we booted on — a hand-typed `?tab=bogus` reads as the
    // overview, and leaving the URL saying otherwise would make the first real
    // move look like a change when it is not.
    const query = placeQuery(pending.current);
    if (query !== location.search) history.replaceState(null, '', location.pathname + query);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const go = useCallback((patch: Partial<Place>) => {
    const next = { ...pending.current, ...patch };
    pending.current = next;
    setPlace(next);
    if (scheduled.current) return;
    scheduled.current = true;
    queueMicrotask(() => {
      scheduled.current = false;
      const query = placeQuery(pending.current);
      if (query === location.search) return;
      history.pushState(null, '', location.pathname + query);
    });
  }, []);

  return { place, go };
}
