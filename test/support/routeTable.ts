// The server's route table, read out of `app.ts`'s source rather than kept as a
// list beside it. Two tests walk the whole table — the auth guard and the demo
// backend's parity — and both want the property a hand-maintained list cannot
// have: a route added later is covered on the day it is written.
//
// Lifted here rather than copied a second time. If `app.ts` is ever split into
// `src/server/routes/`, this is the one place that learns where the table lives.
import { readFileSync } from 'node:fs';

/** One declared route: the path as written, and the same path with params filled in. */
export interface DeclaredRoute {
  method: 'GET' | 'POST' | 'DELETE';
  /** As declared, params and all — `/api/issues/:number/watch`. */
  path: string;
  /** Injectable — `/api/issues/1/watch`. */
  url: string;
}

/**
 * Every `app.get`/`app.post`/`app.delete` declared in `app.ts`.
 *
 * The whitespace allowed between the paren and the path is deliberate: a route
 * whose options make Prettier break the argument list onto its own line
 * (`/api/prompts` is one) is still a route, and a matcher that missed it would
 * drop it from every assertion built on this — silently, which is the failure
 * mode the assertions exist to close.
 */
export function declaredRoutes(): DeclaredRoute[] {
  const source = readFileSync(new URL('../../src/server/app.ts', import.meta.url), 'utf8');
  const routes: DeclaredRoute[] = [];
  for (const [, method, path] of source.matchAll(/\bapp\.(get|post|delete)\(\s*'([^']+)'/g)) {
    if (!method || !path) continue;
    routes.push({
      method: method.toUpperCase() as DeclaredRoute['method'],
      path,
      url: path.replace(/:[A-Za-z]+/g, '1'),
    });
  }
  return routes;
}
