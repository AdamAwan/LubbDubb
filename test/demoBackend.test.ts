import { test } from 'node:test';
import assert from 'node:assert/strict';
import { declaredRoutes } from './support/routeTable.js';
import { demoApi } from '../web/src/demo/demoBackend.js';
import { DEMO_ROUTES } from '../web/src/demo/routes.js';

// ---------------------------------------------------------------------------
// The demo backend is a second implementation of the whole server surface, and
// it is invisible: `VITE_DEMO` is statically false in the real build, so Rollup
// drops it and nothing about day-to-day work ever exercises it. Add a route to
// `app.ts`, wire it into `web/src/api.ts`, forget the demo arm, and every one of
// the six `npm run check` gates stays green — the Pages build breaks after
// deploy, on the surface whose whole job is being the thing people see first.
//
// So the parity is asserted here, against the route table read out of `app.ts`.
// What is owed is coverage, not fidelity: `web/src/demo/routes.ts` may answer a
// route with a constant or declare it `absent` with a reason. What it may not do
// is not mention it.
// ---------------------------------------------------------------------------

test('every route the server declares is answered or declared absent by the demo', () => {
  const routes = declaredRoutes();
  // Guards the guard: a matcher that silently stopped matching would make the
  // comparison below vacuous in the safe direction.
  assert.ok(routes.length >= 40, `expected to find the route table, found ${routes.length} routes`);
  assert.ok(routes.some((r) => r.path === '/api/state'));

  const missing = routes.map((r) => `${r.method} ${r.path}`).filter((key) => !(key in DEMO_ROUTES));
  assert.deepEqual(
    missing,
    [],
    'these routes exist on the server and the demo has never heard of them — add each to ' +
      'web/src/demo/routes.ts, either against the demoApi method that answers it or as ' +
      '`{ absent: "why" }`',
  );
});

test('the demo declares no route the server does not', () => {
  const real = new Set(declaredRoutes().map((r) => `${r.method} ${r.path}`));
  const stale = Object.keys(DEMO_ROUTES).filter((key) => !real.has(key));
  assert.deepEqual(stale, [], 'these entries name a route app.ts no longer declares');
});

test('every route the demo claims to answer resolves to a callable demoApi method', () => {
  const api = demoApi as unknown as Record<string, unknown>;
  for (const [route, answer] of Object.entries(DEMO_ROUTES)) {
    if (typeof answer !== 'string') {
      // The declared-absent arm still has to say something: a bare `{absent: ''}`
      // is the gap this table exists to make impossible, wearing a decision's
      // clothes.
      assert.ok(answer.absent.trim().length > 20, `${route} is declared absent without a reason`);
      continue;
    }
    assert.equal(typeof api[answer], 'function', `${route} names demoApi.${answer}, which is not a function`);
  }
});

test('no demoApi method is orphaned — each one answers a route', () => {
  const answering = new Set<string>(Object.values(DEMO_ROUTES).filter((a) => typeof a === 'string'));
  const orphans = Object.keys(demoApi).filter((name) => !answering.has(name));
  assert.deepEqual(
    orphans,
    [],
    'these demoApi methods answer no route in app.ts — the route was removed and its demo arm ' +
      'was left behind, or the entry in web/src/demo/routes.ts is missing',
  );
});
