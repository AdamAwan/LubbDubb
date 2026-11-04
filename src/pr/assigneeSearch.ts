import type { PrPerson } from '../types.js';

const MAX_MATCHES = 20;
const LOGINS_TTL_MS = 5 * 60_000;

/** The ids a search names, best first: an exact id, then a prefix, then anywhere in it. */
function matchingPeople(ids: readonly string[], query: string): string[] {
  const wanted = query.trim().toLowerCase();
  const rank = (id: string): number => {
    const lower = id.toLowerCase();
    if (lower === wanted) return 0;
    if (lower.startsWith(wanted)) return 1;
    return lower.includes(wanted) ? 2 : 3;
  };
  return ids
    .map((id) => ({ id, r: rank(id) }))
    .filter((e) => e.r < 3)
    .sort((a, b) => a.r - b.r || a.id.localeCompare(b.id))
    .slice(0, MAX_MATCHES)
    .map((e) => e.id);
}

export function loginPeople(logins: readonly string[]): PrPerson[] {
  return logins.map((login) => ({ id: login, name: login }));
}

/** Logins a search names, as people: a login is both a GitHub user's id and their name. */
export function searchLogins(logins: readonly string[], query: string): PrPerson[] {
  return query.trim() === '' ? [] : loginPeople(matchingPeople(logins, query));
}

/** One list for every search for a while: a list of logins is a paginated read, and a search is a keystroke. */
export function cachedLogins(load: () => Promise<string[]>, now: () => number = Date.now): () => Promise<string[]> {
  let held: { at: number; logins: Promise<string[]> } | null = null;
  return () => {
    if (held === null || now() - held.at > LOGINS_TTL_MS) {
      const logins = load();
      held = { at: now(), logins };
      logins.then(undefined, () => {
        if (held?.logins === logins) held = null;
      });
    }
    return held.logins;
  };
}
