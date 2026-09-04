import { useCallback, useEffect, useRef, useState } from 'react';
import { NOWHERE, placeQuery, readPlace, type Place } from './place.js';
import type { UsageArrival } from '../types.js';

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
/**
 * A move, either stated outright or derived from where you already are.
 *
 * The updater arm exists for the moves that *edit* a place rather than replace
 * one — folding a backlog feature adds to a list the place already holds. It is
 * handed `pending.current` rather than the rendered `place`, so two folds in a
 * tick compose instead of the second dropping the first, which is the same
 * guarantee the patch arm already had.
 */
type PlacePatch<P> = (P & Record<Exclude<keyof P, keyof Place>, never>) | ((place: Place) => Partial<Place>);

/**
 * A move, typed so that a key `Place` does not have is a **type error at the
 * call site** rather than a field written onto the place and read by nothing.
 *
 * `Partial<Place>` alone does not get this: every caller here builds its patch
 * by spreading a partial in (`go({ tab: 'insights', ...where })`), and a spread
 * is precisely where TypeScript stops checking for excess properties. So
 * `openInsights` shipped for a release passing `{ view, window }` against a
 * place whose fields are `insightsView` and `insightsWindow` — every tab and
 * every window button on that page changed nothing, pushed no history entry,
 * and looked exactly like a page whose controls were not wired up at all.
 *
 * The generic makes the excess key `never`, which no value satisfies, and the
 * updater arm falls back to the constraint so `go((current) => …)` is unchanged.
 */
type Go = <P extends Partial<Place>>(patch: PlacePatch<P>) => void;

export function useNavigation(): { place: Place; go: Go; arrival: UsageArrival } {
  // `location` is simply undefined under node, which is how the cockpit's
  // modules are imported by the tests — the same reason `readToken` guards.
  const [place, setPlace] = useState<Place>(() =>
    typeof location === 'undefined' ? NOWHERE : readPlace(location.search),
  );
  /**
   * How the *current* place was arrived at, which is the fifth column of a
   * surface-reach row and the whole of what tells `never-linked` from
   * `linked-never-visited` (`docs/spec/34-usage-metrics.md#surface-reach`).
   *
   * `direct` to begin with, because the first place of a session is whatever the
   * address bar said — a typed URL, a reload, a bookmark, a link somebody was
   * sent — and none of those is the cockpit having carried anybody anywhere. A
   * `go` is `linked` by construction: every one of them comes off a control the
   * product drew. A `popstate` is `direct` for the boot's reason exactly: the
   * back button is the browser's navigation and not the cockpit's, so counting it
   * as a link would report that the product routes to a surface it in fact only
   * ever routes *away* from.
   */
  const [arrival, setArrival] = useState<UsageArrival>('direct');
  // What the address bar is about to say. `place` lags it by a render, and the
  // second `go` of a tick must not patch the first one's input.
  const pending = useRef(place);
  const scheduled = useRef(false);

  useEffect(() => {
    const onPop = () => {
      const next = readPlace(location.search);
      pending.current = next;
      setPlace(next);
      setArrival('direct');
    };
    window.addEventListener('popstate', onPop);
    // Normalise the entry we booted on — a hand-typed `?tab=bogus` reads as the
    // overview, and leaving the URL saying otherwise would make the first real
    // move look like a change when it is not.
    const query = placeQuery(pending.current);
    if (query !== location.search) history.replaceState(null, '', location.pathname + query);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const go = useCallback<Go>((patch) => {
    const next = { ...pending.current, ...(typeof patch === 'function' ? patch(pending.current) : patch) };
    pending.current = next;
    setPlace(next);
    setArrival('linked');
    if (scheduled.current) return;
    scheduled.current = true;
    queueMicrotask(() => {
      scheduled.current = false;
      const query = placeQuery(pending.current);
      if (query === location.search) return;
      history.pushState(null, '', location.pathname + query);
    });
  }, []);

  return { place, go, arrival };
}
