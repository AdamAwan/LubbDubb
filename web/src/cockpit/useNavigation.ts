import { useCallback, useEffect, useRef, useState } from 'react';
import { NOWHERE, placeQuery, readPlace, type Place } from './place.js';
import type { UsageArrival } from '../types.js';

// → docs/spec/17-cockpit.md#the-address-bar

type PlacePatch<P> = (P & Record<Exclude<keyof P, keyof Place>, never>) | ((place: Place) => Partial<Place>);

type Go = <P extends Partial<Place>>(patch: PlacePatch<P>) => void;

export function useNavigation(): { place: Place; go: Go; arrival: UsageArrival } {
  const [place, setPlace] = useState<Place>(() =>
    typeof location === 'undefined' ? NOWHERE : readPlace(location.search),
  );
  const [arrival, setArrival] = useState<UsageArrival>('direct');
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
