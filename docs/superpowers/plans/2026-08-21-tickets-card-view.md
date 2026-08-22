# Tickets Card View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a card/board view to the Tickets tab — one column per tracker state, each scrolling on its own — where dragging a card between columns writes the state back to the tracker.

**Architecture:** The board is a peer of the existing table inside `TicketsPanel`, which keeps the filter rail and the fetch shaping. Columns come from a new `issueBoardStates` config key, falling back to the state facets the route already ships. Each column issues its own paged `/api/tickets` request with `state=<its column>`, so no list route changes. The write goes through a new `POST /api/issues/:number/state` onto the `ActionSink.setWorkItemState` seam that already exists, patching both the world baseline and the ticket mirror exactly as the watch route does. Every board decision that is not markup — which columns exist, what a card's reason line says, what a drop costs — is a pure function in `web/src/ticketBoard.ts`, unit-tested without a render.

**Tech Stack:** TypeScript (ESM, `nodenext`, explicit `.js` import extensions), Node's built-in `node:test` + `node:assert/strict`, Fastify + Zod on the server, React 18 in `web/`, better-sqlite3, Vite.

**Spec:** [`docs/superpowers/specs/2026-08-21-tickets-card-view-design.md`](../specs/2026-08-21-tickets-card-view-design.md)

## Global Constraints

Every task's requirements implicitly include all of these. They are drawn from
[`CLAUDE.md`](../../../CLAUDE.md) and from reading the code the tasks touch; each one is a failure
`npm run check` will either catch loudly or miss silently.

- **ESM with explicit `.js` import extensions**, even from `.ts` sources: `import { Store } from './store/store.js';`. New files must follow this or module resolution breaks.
- **`npm run check` must pass** before every commit: `format:check`, `lint`, `typecheck`, `typecheck:web`, `knip`, `test`. Two typecheckers — a change spanning `src/` and `web/` must satisfy both.
- **On Windows, `check` is red before you start.** A clean tree reports every source file unformatted (line endings) and a block of failing tests that have nothing to do with this work. **Take a baseline first** — run `npm run check` on the untouched branch and keep the output — then read each task's `check` step as "no _new_ failures against that baseline". Never run `prettier --write` across the repo to make `format:check` pass; it rewrites every file and buries the change. The per-task `npx tsx --test <file>` commands are the real signal, and they are exact.
- **knip runs with every rule at `error`.** `test/**/*.test.ts` is an entry point, so an export consumed only by a test is used. But `files: "error"` means **a new source file nothing imports fails the build** — a new component must land in the same commit as the import that renders it.
- **Comments explain _why_, not _what_.** Match the existing terse, high-signal style. Do not add comments restating the code.
- **Domain types live in `src/types.ts`; the shapes the HTTP routes ship live in `src/wire.ts`**, which `web/src/types.ts` re-exports. `test/wireContract.test.ts` enforces that `src/wire.ts` is the only server module anything under `web/src/` names.
- **A route handler never reads the request.** Wrap it in `checked(schemas, handler)` from `src/server/validation.ts` and take `{params, body, req, reply}` already parsed. A refusal is a returned value and a 400, never a throw.
- **A new route goes in the module under `src/server/routes/` that owns its group.** `POST /api/issues/:number/state` belongs in `src/server/routes/issues.ts`.
- **Do not add swallowed `catch`es.** Route every caught failure through `errors.record(...)` (`src/errorLog.ts`).
- **No colour literal outside a `--custom-property` declaration**, in any of `web/src/styles.css`, `web/src/console/console.css`, `web/src/theme.css`. `test/cockpitTheme.test.ts` is the only thing in `check` that reads CSS, and it asserts this with no allow-list.
- **A new `:root` token whose value is a bare `#literal` must be answered by all five theme presets in `web/src/theme.css` AND by the print block in `styles.css`** — `test/cockpitTheme.test.ts` derives the required set by rule. A token declared as a `color-mix(...)` of an existing core token needs none of that, which is why **every new colour in this plan is a `color-mix`**.
- **Every `:root` token must appear in `web/src/cockpit/tokens.ts`, and every registry entry must name a declared token** — asserted in both directions.
- **A new piece of "where am I" state goes on `Place`** (`web/src/cockpit/place.ts`), never a `useState` in `useCockpit`.
- **A reference is drawn with `<Ref to={ref}/>`** (`web/src/components/refs.tsx`), never as text, and **never inside a button**.
- **Tests build a whole `System`** via `buildSystem(config, opts)` with `dbPath: ':memory:'` and fakes injected. A test that dispatches a code agent **must** inject `worktrees: new FakeWorktreeManager()` or it cuts a real branch in the working checkout. Tests build config with `loadConfig`, never `loadDeploymentConfig`.
- **When you change behaviour, update the spec document that owns it in the same change.** Each task below names its spec sections. This is the repo's one documentation rule.

---

### Task 1: The pickup mark reads the effective pickup states

`TicketStateFacet.pickup` is built in `src/server/routes/tickets.ts` from `config.issuePickupStates`
raw. The dispatcher gates on `effectivePickupStates`, which folds `issueInProgressState` in — and
`src/config.ts` says that state should **not** be listed in `issuePickupStates`. So today the State
tier's ▲ mark is missing on the in-progress state. Cosmetic in a table; on the board it decides which
columns warn that the fleet will stop, so it is fixed first and on its own.

**Files:**

- Modify: `src/server/routes/tickets.ts:100` (the `pickupStates:` argument to `buildTicketPage`)
- Test: `test/tickets.test.ts` (append)
- Docs: `docs/spec/17-cockpit.md` — the `### Three axes, because they are three questions` section, where the ▲ mark is described

**Interfaces:**

- Consumes: `effectivePickupStates(policy)` from `src/dispatcher/issuePickup.js` — signature `(policy: IssuePickupPolicy) => string[] | undefined`, where the fields used here are `{ pickupStates?: string[]; inProgressState?: string }`.
- Produces: nothing new. `TicketStateFacet.pickup` now means what the dispatcher means.

- [ ] **Step 1: Write the failing test**

Append to `test/tickets.test.ts`:

```ts
test('the pickup mark on a state facet is the dispatcher’s effective set, not the raw list', async () => {
  const config = loadConfig({
    auth: { enabled: false } as never,
    dbPath: ':memory:',
    labelPrefix: 'lubbdubb',
    agentMode: 'raw',
    heartbeatIntervalMs: 999_999,
    startPaused: true,
    // "Doing" is deliberately absent from the pickup list: `effectivePickupStates`
    // folds the in-progress state in, and src/config.ts says it should not be
    // listed. A facet built from the raw list therefore marks it not-pickup, which
    // is the bug.
    issuePickupStates: ['Ready'],
    issueInProgressState: 'Doing',
  });
  const system = buildSystem(config, {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });

  system.connector.inject({ kind: 'new_issue', number: 20, title: 'Waiting' });
  system.connector.inject({ kind: 'new_issue', number: 21, title: 'In flight' });
  // The fake has no way to inject a native state, so it is written through the
  // provider seam the harness itself uses — which is also the only path that puts
  // the state into the world the sweep then mirrors.
  await system.connector.setWorkItemState({ number: 20, state: 'Ready' });
  await system.connector.setWorkItemState({ number: 21, state: 'Doing' });
  await system.harness.runCycle('manual');

  const { app } = await buildApp(system);
  const page = await app.inject({ method: 'GET', url: '/api/tickets' });
  const body = page.json() as TicketsPayload;
  const byState = new Map(body.states.map((facet) => [facet.state, facet.pickup]));

  assert.equal(byState.get('Ready'), true, 'a listed pickup state is marked');
  assert.equal(byState.get('Doing'), true, 'and so is the in-progress state the dispatcher folds in');
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
npx tsx --test test/tickets.test.ts
```

Expected: FAIL on the second assertion — `Doing` comes back `false`.

- [ ] **Step 3: Make the route quote the dispatcher's own function**

In `src/server/routes/tickets.ts`, add to the imports:

```ts
import { effectivePickupStates } from '../../dispatcher/issuePickup.js';
```

and replace the `pickupStates` argument to `buildTicketPage` (currently
`pickupStates: config.issuePickupStates ?? []`) with:

```ts
        // The dispatcher's own effective set, not the raw list: `issueInProgressState`
        // is folded in there and deliberately not listed here, so a facet built from
        // the raw key marks the in-progress state as one the harness will not work.
        // A lens quoting a decision made elsewhere, which is the allowed direction.
        pickupStates:
          effectivePickupStates({
            pickupStates: config.issuePickupStates,
            inProgressState: config.issueInProgressState,
          }) ?? [],
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
npx tsx --test test/tickets.test.ts
```

Expected: PASS, and every pre-existing test in the file still passes.

- [ ] **Step 5: Update the spec**

In `docs/spec/17-cockpit.md`, in `### Three axes, because they are three questions`, find the sentence
describing the ▲ mark on a state chip and make it state which set the mark is: the dispatcher's
**effective** pickup states, `issueInProgressState` included even when `issuePickupStates` does not name
it. One or two sentences, in the surrounding voice, saying why: the mark is read as "the harness will
work this", and the raw key is not that set.

- [ ] **Step 6: Run the full check**

```bash
npm run check
```

- [ ] **Step 7: Commit**

```bash
git add src/server/routes/tickets.ts test/tickets.test.ts docs/spec/17-cockpit.md
git commit -m "Mark a state chip from the pickup set the dispatcher actually gates on"
```

---

### Task 2: The `issueBoardStates` config key, through to the cockpit

The ordered list of columns. It is an operator policy the harness never reads, so it follows
`issueStateColours` in every respect: a `stringList` field, a live apply arm that assigns onto the
running config, and a value shipped on the state snapshot.

`test/configFields.test.ts` already asserts structurally that every config key is declared, grouped,
and that liveness matches an arm — so a half-wired key fails `check` without a new test. The new test
here is for the part those cannot see: that the value reaches the cockpit.

**Files:**

- Modify: `src/config.ts` (the `issueStateColours` neighbourhood, ~line 117 and the `DEFAULTS` at ~line 636)
- Modify: `src/configFields.ts` (~line 279, beside the `issueStateColours` entry)
- Modify: `src/configApply.ts` (~line 84, beside the `issueStateColours` arm)
- Modify: `src/server/runningConfig.ts` (~line 130, the Integrations group key list)
- Modify: `src/wire.ts` (`CockpitConfig`, after `stateColours` at ~line 627)
- Modify: `src/server/stateSnapshot.ts` (~line 513, beside `stateColours`)
- Test: `test/tickets.test.ts` (append)
- Docs: `docs/spec/02-configuration.md` — `### Item selection (labels, priority, states)`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `Config.issueBoardStates: string[]` (default `[]`) and `CockpitConfig.boardStates: string[]`, read in the cockpit as `view.state.config.boardStates`.

- [ ] **Step 1: Write the failing test**

Append to `test/tickets.test.ts`:

```ts
test('the board column order is an operator policy, shipped to the cockpit as it was written', async () => {
  const config = loadConfig({
    auth: { enabled: false } as never,
    dbPath: ':memory:',
    labelPrefix: 'lubbdubb',
    agentMode: 'raw',
    heartbeatIntervalMs: 999_999,
    startPaused: true,
    // Not alphabetical and not count order: the whole point of the key is that the
    // order is a judgement only the operator can make.
    issueBoardStates: ['New', 'Ready', 'Doing', 'In Review', 'Closed'],
  });
  const system = buildSystem(config, {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
  await system.harness.runCycle('manual');

  const { app } = await buildApp(system);
  const state = await app.inject({ method: 'GET', url: '/api/state' });
  assert.equal(state.statusCode, 200);
  const body = state.json() as AppState;
  assert.deepEqual(
    body.config.boardStates,
    ['New', 'Ready', 'Doing', 'In Review', 'Closed'],
    'the list arrives in the order the file states it',
  );
});

test('a deployment that configures no board states ships an empty list, not a guess', async () => {
  const config = loadConfig({
    auth: { enabled: false } as never,
    dbPath: ':memory:',
    agentMode: 'raw',
    heartbeatIntervalMs: 999_999,
    startPaused: true,
  });
  const system = buildSystem(config, {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
  await system.harness.runCycle('manual');
  const { app } = await buildApp(system);
  const body = (await app.inject({ method: 'GET', url: '/api/state' })).json() as AppState;
  // Empty means "fall back to the facets", which the cockpit decides. The server
  // inventing an order here would be a policy no file states.
  assert.deepEqual(body.config.boardStates, []);
});
```

Add `AppState` to the type imports at the top of `test/tickets.test.ts`:

```ts
import type { AppState, TicketsPayload } from '../src/wire.js';
```

(replacing the existing `import type { TicketsPayload } from '../src/wire.js';`)

- [ ] **Step 2: Run the tests and watch them fail**

```bash
npx tsx --test test/tickets.test.ts
```

Expected: FAIL at compile — `issueBoardStates` is not a `Config` key and `boardStates` is not on
`CockpitConfig`.

- [ ] **Step 3: Declare the config key**

In `src/config.ts`, immediately after the `issueStateColours` declaration, add:

```ts
  /**
   * The tracker's own state words, in the left-to-right order the Tickets tab's
   * card view draws them as columns. Empty (the default) = every state the mirror
   * carries, in the facets' own count order.
   *
   * An order rather than a set, because that is the part nothing else knows: the
   * facets carry the words and their counts, `issuePickupStates` is a set, and no
   * provider reports its process template's column order. Listing a state the
   * tracker has nothing in still draws its column — naming a column is the operator
   * saying they expect work there — and a state the mirror carries that this omits
   * is reported under the board rather than silently dropped.
   */
  issueBoardStates: string[];
```

In the `DEFAULTS` object, beside `issueStateColours: {}`, add:

```ts
  issueBoardStates: [],
```

- [ ] **Step 4: Declare the field, its group and its arm**

In `src/configFields.ts`, immediately after the `issueStateColours` entry:

```ts
  {
    path: 'issueBoardStates',
    type: 'stringList',
    access: 'plain',
    why: 'Tracker states as board columns, left to right. Empty = every state the mirror carries.',
  },
```

In `src/server/runningConfig.ts`, add `'issueBoardStates',` to the Integrations group's `keys` array,
immediately after `'issueStateColours',`.

In `src/configApply.ts`, immediately after the `issueStateColours` arm:

```ts
  // `buildStateSnapshot` reads the running config by reference at every poll, so
  // assigning onto it *is* the arm — a column reordered on the config page is on
  // the board a heartbeat later. Nothing in the harness reads this, so there is no
  // consumer to re-seat and no second copy it could disagree with.
  issueBoardStates: (next, deps) => {
    deps.running.issueBoardStates = next.issueBoardStates;
  },
```

- [ ] **Step 5: Ship it to the cockpit**

In `src/wire.ts`, in `CockpitConfig`, immediately after `stateColours`:

```ts
  /**
   * `issueBoardStates` — the tracker's state words in the order the card view draws
   * them as columns. Empty means the cockpit falls back to the facets' own order,
   * which is the one thing the server must not decide for it: the fallback is a
   * statement about a screen, and an order invented here would be a policy no
   * config file states.
   */
  boardStates: string[];
```

In `src/server/stateSnapshot.ts`, immediately after `stateColours: { ...config.issueStateColours },`:

```ts
      boardStates: [...config.issueBoardStates],
```

- [ ] **Step 6: Run the tests and watch them pass**

```bash
npx tsx --test test/tickets.test.ts test/configFields.test.ts test/configApply.test.ts test/runningConfig.test.ts
```

Expected: PASS. The `configFields` structural tests are what confirm the key is declared, grouped and
armed consistently.

- [ ] **Step 7: Update the spec**

In `docs/spec/02-configuration.md`, in `### Item selection (labels, priority, states)`, add
`issueBoardStates` alongside `issuePickupStates` and `issueStateColours`: what it is, that it is an
order and not a gate, that empty falls back to the facets, that a listed state with no items still
draws a column, and that an omitted state is reported under the board rather than hidden. Match the
surrounding entries' shape.

- [ ] **Step 8: Run the full check**

```bash
npm run check
```

- [ ] **Step 9: Commit**

```bash
git add src/config.ts src/configFields.ts src/configApply.ts src/server/runningConfig.ts src/wire.ts src/server/stateSnapshot.ts test/tickets.test.ts docs/spec/02-configuration.md
git commit -m "Let the operator order the board's columns, and ship that order to the cockpit"
```

---

### Task 3: Whether the provider can write a state, and the states the rules own

Two more facts the board needs and nothing on the wire carries: whether a drag can write at all, and
which state words the three work-item rules act on, so a column header can say what dropping there
costs.

**The capability must be asked of the connector, not guessed from the provider name.**
`CompositeConnector.setWorkItemState` **throws** when no integration is `WorkItemStateCapable`, so
there is no way to ask it without trying. The connector therefore gains a predicate — the same shape
as the existing `canFileTickets` flag, and for the same stated reason: the one place that decides is
the one the route asks.

> **Refines the spec.** The design doc says `canSetWorkItemState` is resolved "from
> `isWorkItemStateCapable(connector)`". That is not reachable — `isWorkItemStateCapable` tests an
> _integration_, and the route holds a connector. The predicate below is the same fact asked at the
> seam that can answer it.

**Files:**

- Modify: `src/sink/actionSink.ts` (the `ActionSink` interface, beside `setWorkItemState` at ~line 182)
- Modify: `src/integrations/compositeConnector.ts` (~line 206, beside `setWorkItemState`)
- Modify: `src/connector/fakeConnector.ts` (~line 70, beside `setWorkItemState`)
- Modify: `src/wire.ts` (`CockpitConfig`, after `boardStates`)
- Modify: `src/server/stateSnapshot.ts` (beside `boardStates`)
- Test: `test/tickets.test.ts` (append)
- Docs: `docs/spec/17-cockpit.md` — `## The tickets tab`

**Interfaces:**

- Consumes: `Config.issueBoardStates` and `CockpitConfig.boardStates` from Task 2 (for placement only).
- Produces:

  - `ActionSink.canSetWorkItemState(): boolean`
  - `CockpitConfig.canSetWorkItemState: boolean`
  - `CockpitConfig.stateRules: { pickup: string[]; inProgress: string | null; inReview: string | null; returnsTo: string | null } | null`

- [ ] **Step 1: Write the failing test**

Append to `test/tickets.test.ts`:

```ts
test('the cockpit is told whether a state can be written, and which states the rules own', async () => {
  const config = loadConfig({
    auth: { enabled: false } as never,
    dbPath: ':memory:',
    agentMode: 'raw',
    heartbeatIntervalMs: 999_999,
    startPaused: true,
    issuePickupStates: ['Ready', 'Queued'],
    issueInProgressState: 'Doing',
    issueInReviewState: 'In Review',
  });
  const system = buildSystem(config, {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
  await system.harness.runCycle('manual');
  const { app } = await buildApp(system);
  const body = (await app.inject({ method: 'GET', url: '/api/state' })).json() as AppState;

  assert.equal(body.config.canSetWorkItemState, true, 'the fake issues provider can write states');
  assert.deepEqual(body.config.stateRules, {
    // The *effective* set, so the in-progress state is in it — the same list the
    // dispatcher gates on, quoted rather than re-derived in the browser.
    pickup: ['Ready', 'Queued', 'Doing'],
    inProgress: 'Doing',
    inReview: 'In Review',
    // Where `work-item-back-to-pickup` returns an item: the first pickup state,
    // which is the operator's own "start here".
    returnsTo: 'Ready',
  });
});

test('with no state gate configured there are no rules to report, and null says so', async () => {
  const config = loadConfig({
    auth: { enabled: false } as never,
    dbPath: ':memory:',
    agentMode: 'raw',
    heartbeatIntervalMs: 999_999,
    startPaused: true,
  });
  const system = buildSystem(config, {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
  await system.harness.runCycle('manual');
  const { app } = await buildApp(system);
  const body = (await app.inject({ method: 'GET', url: '/api/state' })).json() as AppState;
  // Null rather than an object of nulls: without `issuePickupStates` all three
  // work-item rules are switched out by the registry's `workItemStates` condition,
  // so there is nothing for a drop to disturb. That is the same fact the dispatcher
  // acts on, not a second reading of it.
  assert.equal(body.config.stateRules, null);
});
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
npx tsx --test test/tickets.test.ts
```

Expected: FAIL at compile — neither field exists on `CockpitConfig`.

- [ ] **Step 3: Add the capability predicate to the sink and both connectors**

In `src/sink/actionSink.ts`, in the `ActionSink` interface, immediately **above** `setWorkItemState`:

```ts
  /**
   * Whether any configured integration can write a work item's state at all.
   *
   * Asked rather than inferred, because {@link setWorkItemState} *throws* when
   * nothing implements it — so a caller that wants to offer the operation rather
   * than attempt it has no other way to find out. GitHub issues carry no such
   * state and answer false.
   */
  canSetWorkItemState(): boolean;
```

In `src/integrations/compositeConnector.ts`, immediately above `setWorkItemState`:

```ts
  canSetWorkItemState(): boolean {
    return this.integrations.some(isWorkItemStateCapable);
  }
```

In `src/connector/fakeConnector.ts`, immediately above its `setWorkItemState`:

```ts
  canSetWorkItemState(): boolean {
    return this.composite.canSetWorkItemState();
  }
```

- [ ] **Step 4: Ship both facts on the snapshot**

In `src/wire.ts`, in `CockpitConfig`, immediately after `boardStates`:

```ts
  /**
   * Whether the provider can write a work item's state — the board's drag, and
   * nothing else, depends on it.
   *
   * A flag rather than left to the cockpit to infer from the provider name, for
   * `canFileTickets`' reason: the one place that decides is the one the route asks.
   * False means no card is draggable and the board says so once, rather than every
   * drag failing separately and teaching nothing five times over.
   */
  canSetWorkItemState: boolean;
  /**
   * The state words the three work-item rules act on, so a column header can say
   * what dropping there disturbs.
   *
   * `pickup` is the **effective** set (`effectivePickupStates`), which is what makes
   * this a quotation of the dispatcher's gate rather than a second opinion about it.
   * `returnsTo` is where `work-item-back-to-pickup` sends an item — the first pickup
   * state, the operator's own "start here".
   *
   * Null when `issuePickupStates` is unset, because all three rules are switched out
   * entirely by the registry's `workItemStates` condition then: there is nothing a
   * drop can disturb, and an object of nulls would invite the board to imply there is.
   */
  stateRules: { pickup: string[]; inProgress: string | null; inReview: string | null; returnsTo: string | null } | null;
```

In `src/server/stateSnapshot.ts`, add `effectivePickupStates` to the imports:

```ts
import { effectivePickupStates } from '../dispatcher/issuePickup.js';
```

and immediately after `boardStates: [...config.issueBoardStates],`:

```ts
      canSetWorkItemState: connector.canSetWorkItemState(),
      stateRules: workItemStateRules(config),
```

Then, at the bottom of `src/server/stateSnapshot.ts`, add the helper:

```ts
/**
 * The state words the work-item rules act on, or null where they are all switched off.
 *
 * Pure and beside the snapshot rather than inline, so the one thing worth getting
 * right is readable: `pickup` is the effective set the dispatcher gates on, which
 * folds `issueInProgressState` in. Built from the raw key it would tell the board
 * that dropping onto the in-progress state stops the fleet, which is the opposite
 * of true.
 */
function workItemStateRules(config: Config): CockpitConfig['stateRules'] {
  const pickup = effectivePickupStates({
    pickupStates: config.issuePickupStates,
    inProgressState: config.issueInProgressState,
  });
  if (pickup === undefined || pickup.length === 0) return null;
  return {
    pickup,
    inProgress: config.issueInProgressState ?? null,
    inReview: config.issueInReviewState ?? null,
    // Where the back-off rule returns an item, read the way the rule reads it:
    // the *first* configured pickup state, not the first of the effective list,
    // which the in-progress fold could otherwise reorder.
    returnsTo: config.issuePickupStates?.[0] ?? null,
  };
}
```

If `Config` or `CockpitConfig` is not already imported as a type in `stateSnapshot.ts`, add whichever
is missing to its existing type imports.

- [ ] **Step 5: Run the tests and watch them pass**

```bash
npx tsx --test test/tickets.test.ts test/fakeConnector.test.ts
```

Expected: PASS.

- [ ] **Step 6: Update the spec**

In `docs/spec/17-cockpit.md`, under `## The tickets tab`, add a short paragraph stating that the tab is
told two things about state writes — whether the provider can make one at all, and which states the
work-item rules act on — and why both are the server's to say rather than the cockpit's to infer.

- [ ] **Step 7: Run the full check**

```bash
npm run check
```

- [ ] **Step 8: Commit**

```bash
git add src/sink/actionSink.ts src/integrations/compositeConnector.ts src/connector/fakeConnector.ts src/wire.ts src/server/stateSnapshot.ts test/tickets.test.ts docs/spec/17-cockpit.md
git commit -m "Tell the cockpit whether a state can be written, and which states the rules own"
```

---

### Task 4: Fold a confirmed state write onto the baseline and the mirror

The two store patches the route will need. They are siblings of `patchWorldLabels` and
`patchTicketLabels` in every respect — same modules, same "observed fact arriving early rather than a
guess" contract, same skip-what-we-do-not-hold rule. No schema change: `world_baseline` holds the whole
snapshot and `tracker_items` already has a `work_item_state` column.

**Files:**

- Modify: `src/store/world.ts` (after `patchWorldLabels`, ~line 135)
- Modify: `src/store/tickets.ts` (after `patchTicketLabels`, ~line 377)
- Modify: `src/store/store.ts` (delegations, beside `patchWorldLabels` ~line 972 and `patchTicketLabels` ~line 1077)
- Test: `test/issueState.test.ts` (new)
- Docs: `docs/spec/14-persistence.md` (the store method lists at ~line 631 and ~line 825), `docs/spec/04-harness-cycle.md` (~line 203, the baseline's other writers)

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces:

  - `Store.patchWorldState(patch: { number: number; state: string }): void`
  - `Store.patchTicketState(patch: { number: number; state: string }): void`

- [ ] **Step 1: Write the failing test**

Create `test/issueState.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import type { TrackerItem, WorldSnapshot } from '../src/types.js';

/**
 * The two halves of one confirmed state write — the baseline `/api/state` serves,
 * and the mirror the Tickets tab is built from.
 *
 * Both are patched for the reason the label pair documents: the baseline is what the
 * cockpit redraws from, and the sweep that would carry the mirror runs last in a
 * cycle that coalesces away while another is in flight. Only ever called for a write
 * the provider took, so each is observed fact arriving early rather than a guess.
 */

const SINCE = '2026-07-01T00:00:00.000Z';

function item(over: Partial<TrackerItem> & Pick<TrackerItem, 'number'>): TrackerItem {
  return {
    title: `Ticket ${over.number}`,
    labels: [],
    state: 'open',
    workItemState: null,
    url: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    changedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

function world(): WorldSnapshot {
  return {
    takenAt: '2026-08-01T00:00:00.000Z',
    issues: [
      { id: 'issue_a', number: 5, title: 'Five', body: '', labels: [], state: 'open', linkedPrNumber: null },
      { id: 'issue_b', number: 6, title: 'Six', body: '', labels: [], state: 'open', linkedPrNumber: null },
    ],
    pullRequests: [],
  } as unknown as WorldSnapshot;
}

test('a confirmed state lands on the baseline, and only on the item named', () => {
  const store = new Store(':memory:');
  store.setWorldBaseline(world());

  store.patchWorldState({ number: 5, state: 'In Review' });

  const after = store.getWorldBaseline();
  assert.equal(after?.issues.find((i) => i.number === 5)?.workItemState, 'In Review');
  assert.equal(
    after?.issues.find((i) => i.number === 6)?.workItemState,
    undefined,
    'an item nobody moved is untouched',
  );
  store.close();
});

test('an item the baseline no longer holds is skipped rather than invented', () => {
  const store = new Store(':memory:');
  store.setWorldBaseline(world());
  // The world this came from has aged out. Inventing a row would put an issue in
  // the cockpit that no snapshot ever described.
  store.patchWorldState({ number: 99, state: 'Doing' });
  assert.equal(store.getWorldBaseline()?.issues.length, 2);
  store.close();
});

test('the same write lands on the mirror, which is what the Tickets tab reads', () => {
  const store = new Store(':memory:');
  store.ensureTrackerSweep(30 * 24 * 60 * 60 * 1000);
  store.recordSweep(SINCE, [item({ number: 5, workItemState: 'Ready' }), item({ number: 6 })]);

  store.patchTicketState({ number: 5, state: 'In Review' });

  const rows = store.listTrackerItems();
  assert.equal(rows.find((r) => r.number === 5)?.workItemState, 'In Review');
  assert.equal(rows.find((r) => r.number === 6)?.workItemState, null, 'and nothing else moves');
  store.close();
});

test('a number the mirror does not hold is skipped — the mirror is a record of what was seen', () => {
  const store = new Store(':memory:');
  store.ensureTrackerSweep(30 * 24 * 60 * 60 * 1000);
  store.recordSweep(SINCE, [item({ number: 5 })]);
  store.patchTicketState({ number: 99, state: 'Doing' });
  assert.deepEqual(
    store.listTrackerItems().map((r) => r.number),
    [5],
  );
  store.close();
});
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
npx tsx --test test/issueState.test.ts
```

Expected: FAIL at compile — `patchWorldState` and `patchTicketState` do not exist on `Store`.

- [ ] **Step 3: Add `patchWorldState`**

In `src/store/world.ts`, immediately after `patchWorldLabels`:

```ts
  /**
   * Write a work-item state the provider has just accepted onto the stored baseline.
   *
   * `patchWorldLabels`' sibling, for its reasons: `/api/state` serves the baseline
   * and never a live read, and the pulse cannot be what makes the change visible —
   * `runCycle` coalesces while a cycle is in flight, so a drop that lands during one
   * is followed by no world read at all and the card snaps back to its old column
   * until the next beat.
   *
   * Only ever called for a write the provider confirmed, so this is observed fact
   * arriving early rather than a guess: the next cycle reads the same state back off
   * the tracker and writes the same baseline. An item the baseline does not carry is
   * skipped — the world it came from has aged out, and inventing a row for it would
   * put an issue in the cockpit that no snapshot described.
   */
  patchWorldState(patch: { number: number; state: string }): void {
    const world = this.getWorldBaseline();
    if (world === null) return;
    const issue = world.issues.find((i) => i.number === patch.number);
    if (issue === undefined) return;
    issue.workItemState = patch.state;
    this.setWorldBaseline(world);
  }
```

- [ ] **Step 4: Add `patchTicketState`**

In `src/store/tickets.ts`, immediately after `patchTicketLabels`:

```ts
  /**
   * Fold a work-item state the provider has just taken onto the mirrored row —
   * `WorldStore.patchWorldState`' half of the same drop, for the surface that reads
   * this table instead of the baseline.
   *
   * The card view groups its columns by `work_item_state` **here**, not in the world:
   * the board's rows come from `/api/tickets`. Nothing else writes this column between
   * sweeps, and `TicketSweep` runs last in a cycle that coalesces away — so without
   * this the card returns to the column it was dragged out of, which reads as a drop
   * that failed while the tracker has already taken it (`patchTicketLabels`, #417).
   *
   * A number the mirror does not hold is skipped: this is a record of what was
   * *seen*, and a row invented for it would be a ticket the tracker never handed us.
   */
  patchTicketState(patch: { number: number; state: string }): void {
    this.ctx.db
      .prepare(`UPDATE tracker_items SET work_item_state = ?, updated_at = ? WHERE number = ?`)
      .run(patch.state, this.ctx.now(), patch.number);
  }
```

- [ ] **Step 5: Delegate both from `Store`**

In `src/store/store.ts`, beside the existing `patchWorldLabels` delegation:

```ts
  patchWorldState(patch: { number: number; state: string }): void {
    this.world.patchWorldState(patch);
  }
```

and beside `patchTicketLabels`:

```ts
  patchTicketState(patch: { number: number; state: string }): void {
    this.tickets.patchTicketState(patch);
  }
```

- [ ] **Step 6: Run the tests and watch them pass**

```bash
npx tsx --test test/issueState.test.ts test/storeModules.test.ts
```

Expected: PASS. `test/storeModules.test.ts` asserts the delegation shape structurally.

- [ ] **Step 7: Update the specs**

In `docs/spec/14-persistence.md`: add `patchTicketState({number, state})` to the tickets-module method
prose near the existing `patchTicketLabels({numbers, label, present})` description, and add
`patchWorldState(patch)` to the world-store method list around line 825, with the same one-line "what
and why" treatment its label sibling gets.

In `docs/spec/04-harness-cycle.md`, at the sentence naming `Store.patchWorldLabels` as the baseline's
other writer, add `patchWorldState` beside it — the list is the point of that sentence, and a second
writer missing from it is exactly what it exists to prevent.

- [ ] **Step 8: Run the full check**

```bash
npm run check
```

- [ ] **Step 9: Commit**

```bash
git add src/store/world.ts src/store/tickets.ts src/store/store.ts test/issueState.test.ts docs/spec/14-persistence.md docs/spec/04-harness-cycle.md
git commit -m "Fold a confirmed work-item state onto the baseline and the mirror"
```

---

### Task 5: `POST /api/issues/:number/state`

The write itself. It does **not** validate the state word: the provider is the authority on its own
process template, so a refusal is quoted back rather than pre-empted by a guess that would also refuse
a legitimately configured but empty column.

**Files:**

- Modify: `src/server/routes/issues.ts` (a new route, immediately after the watch route's closing `);` at ~line 152)
- Test: `test/issueState.test.ts` (append)
- Docs: `docs/spec/16-http-api.md` — a new `### POST /api/issues/:number/state` section, placed after `### POST /api/issues/:number/watch`

**Interfaces:**

- Consumes: `Store.patchWorldState` and `Store.patchTicketState` (Task 4); `ActionSink.canSetWorkItemState()` (Task 3).
- Produces: `POST /api/issues/:number/state` with body `{ state: string }`, answering `{ ok: true; state: string }` on success and `400 { error: string }` on refusal.

- [ ] **Step 1: Write the failing test**

Append to `test/issueState.test.ts`. Add these imports to the top of the file:

```ts
import { buildSystem } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { AppState, TicketsPayload } from '../src/wire.js';
```

and append:

```ts
function boardSystem() {
  const config = loadConfig({
    auth: { enabled: false } as never,
    dbPath: ':memory:',
    labelPrefix: 'lubbdubb',
    agentMode: 'raw',
    heartbeatIntervalMs: 999_999,
    startPaused: true,
    issuePickupStates: ['Ready'],
    issueInReviewState: 'In Review',
  });
  return buildSystem(config, {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
}

test('POST /api/issues/:number/state writes the tracker and patches both readings', async () => {
  const system = boardSystem();
  system.connector.inject({ kind: 'new_issue', number: 30, title: 'Drag me' });
  await system.connector.setWorkItemState({ number: 30, state: 'Ready' });
  await system.harness.runCycle('manual');

  const { app } = await buildApp(system);
  const moved = await app.inject({
    method: 'POST',
    url: '/api/issues/30/state',
    payload: { state: 'In Review' },
  });
  assert.equal(moved.statusCode, 200);
  assert.deepEqual(moved.json(), { ok: true, state: 'In Review' });

  // The baseline, which is what `/api/state` serves and the cockpit redraws from.
  const state = (await app.inject({ method: 'GET', url: '/api/state' })).json() as AppState;
  assert.equal(state.world.issues.find((i) => i.number === 30)?.workItemState, 'In Review');

  // And the mirror, which is what the board's own columns are built from. Asserted
  // separately because they are two readings and patching one is the bug.
  const page = (await app.inject({ method: 'GET', url: '/api/tickets?tracking=any' })).json() as TicketsPayload;
  assert.equal(page.rows.find((r) => r.number === 30)?.workItemState, 'In Review');
});

test('a provider refusal is quoted back as a 400, and neither reading moves', async () => {
  const system = boardSystem();
  system.connector.inject({ kind: 'new_issue', number: 31, title: 'Refused' });
  await system.connector.setWorkItemState({ number: 31, state: 'Ready' });
  await system.harness.runCycle('manual');

  // The provider is the authority on its own process template, so the refusal is
  // the provider's sentence rather than a guess this route made first.
  system.connector.setWorkItemState = () => Promise.reject(new Error('TF401347: invalid transition'));

  const { app } = await buildApp(system);
  const refused = await app.inject({
    method: 'POST',
    url: '/api/issues/31/state',
    payload: { state: 'Nonsense' },
  });
  assert.equal(refused.statusCode, 400);
  assert.match((refused.json() as { error: string }).error, /invalid transition/);

  const page = (await app.inject({ method: 'GET', url: '/api/tickets?tracking=any' })).json() as TicketsPayload;
  assert.equal(page.rows.find((r) => r.number === 31)?.workItemState, 'Ready', 'the mirror is untouched');
  // A refusal is recorded, never swallowed.
  assert.ok(system.store.listErrors().some((e) => /invalid transition/.test(e.message)));
});

test('a provider that cannot write states refuses by saying so, and never calls the sink', async () => {
  const system = boardSystem();
  system.connector.inject({ kind: 'new_issue', number: 32, title: 'No capability' });
  await system.harness.runCycle('manual');

  let called = false;
  system.connector.canSetWorkItemState = () => false;
  system.connector.setWorkItemState = () => {
    called = true;
    return Promise.resolve({ ok: true });
  };

  const { app } = await buildApp(system);
  const refused = await app.inject({
    method: 'POST',
    url: '/api/issues/32/state',
    payload: { state: 'In Review' },
  });
  assert.equal(refused.statusCode, 400);
  assert.match((refused.json() as { error: string }).error, /cannot write/i);
  assert.equal(called, false, 'the throwing seam is never reached');
});

test('an empty state is refused by the schema, not sent to the provider as a blank', async () => {
  const system = boardSystem();
  await system.harness.runCycle('manual');
  const { app } = await buildApp(system);
  const refused = await app.inject({ method: 'POST', url: '/api/issues/33/state', payload: { state: '' } });
  assert.equal(refused.statusCode, 400);
});
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
npx tsx --test test/issueState.test.ts
```

Expected: FAIL — the route is not registered, so the injections come back 404.

- [ ] **Step 3: Add the route**

In `src/server/routes/issues.ts`, immediately after the watch route's closing `);`:

```ts
// Move a work item to one of the tracker's own states — the card view's drag, and
// the first thing in the cockpit that writes one.
//
// **The state word is not validated here.** The provider owns its process
// template: a check against the states the mirror has seen would refuse a
// legitimately configured but still-empty column, and a check against nothing at
// all is what lets the provider's own refusal reach the operator intact. The
// schema asks only that a state was named.
//
// The capability *is* checked, because `setWorkItemState` throws when no
// integration implements it — an exception the operator would read as the write
// failing rather than as the deployment not having the operation.
const StateBody = z.object({ state: z.string().trim().min(1, 'state must name a tracker state').max(80) });
app.post(
  '/api/issues/:number/state',
  checked({ params: IssueNumberParams, body: StateBody }, async ({ params, body, reply }) => {
    const { number } = params;
    const { state } = body;
    if (!connector.canSetWorkItemState()) {
      return reply
        .code(400)
        .send({ error: 'This tracker cannot write work item states, so nothing here can be moved.' });
    }

    try {
      const result = await connector.setWorkItemState({ number, state });
      if (!result.ok) {
        return reply.code(400).send({ error: `The tracker did not take "${state}" for #${number}.` });
      }
    } catch (err) {
      const message = (err as Error).message;
      errors.record({ source: 'server', message: `Failed to move #${number} to "${state}": ${message}` });
      return reply.code(400).send({ error: message });
    }

    // Both readings, and in this order, for the watch route's reasons: `/api/state`
    // serves the baseline, so a broadcast ahead of the write only makes the cockpit
    // redraw the old column; and the Tickets tab's own list is built from
    // `tracker_items`, which the sweep would carry only at the end of a cycle that
    // coalesces away while another is in flight.
    store.patchWorldState({ number, state });
    store.patchTicketState({ number, state });
    hub.broadcast({ type: 'world:changed' });
    await harness.runCycle('manual');
    return { ok: true, state };
  }),
);
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
npx tsx --test test/issueState.test.ts
```

Expected: PASS.

- [ ] **Step 5: Update the spec**

In `docs/spec/16-http-api.md`, add `### POST /api/issues/:number/state` after the watch route's
section. Cover: the body; that the state word is not validated and why; the capability refusal; the two
patches and the ordering, referring to the watch route's fuller account rather than repeating it; the
broadcast; the manual cycle; and that a provider refusal is a quoted 400 rather than a throw.

- [ ] **Step 6: Run the full check**

```bash
npm run check
```

- [ ] **Step 7: Commit**

```bash
git add src/server/routes/issues.ts test/issueState.test.ts docs/spec/16-http-api.md
git commit -m "Add the route that moves a work item to one of the tracker's own states"
```

---

### Task 6: `boardColumns` — which columns exist, and what has none

The first of three pure functions in a new `web/src/ticketBoard.ts`. knip treats
`test/**/*.test.ts` as an entry point, so a function exported here and consumed only by its test is
used — the file can land before the board renders anything.

**Files:**

- Create: `web/src/ticketBoard.ts`
- Test: `test/ticketBoard.test.ts` (new)
- Docs: none — Task 10 documents the board as a whole, and a function with no screen behind it yet has nothing an operator can read.

**Interfaces:**

- Consumes: `TicketStateFacet` from `web/src/types.js`; `CockpitConfig['stateRules']` shipped in Task 3, reached in the cockpit as `view.state.config.stateRules`.
- Produces:

  ```ts
  export interface BoardColumn {
    state: string;
    /** Every mirrored item in this state, before the rail's filters. */
    count: number;
    /** How many of those are still in the tracker's open set. */
    live: number;
    /** A state the dispatcher's effective gate lets through. */
    pickup: boolean;
    /** True for a column the config names that the mirror has nothing in. */
    empty: boolean;
  }
  export function boardColumns(
    boardStates: readonly string[],
    facets: readonly TicketStateFacet[],
    pickup: readonly string[],
  ): { columns: BoardColumn[]; unlisted: TicketStateFacet[] };
  ```

- [ ] **Step 1: Write the failing test**

Create `test/ticketBoard.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardColumns } from '../web/src/ticketBoard.js';
import type { TicketStateFacet } from '../web/src/types.js';

/**
 * Which columns the card view draws, in what order, and what it has to admit it is
 * not drawing.
 *
 * Pure over the facets the route already ships, because the whole question is a
 * statement about two inputs — an operator's order and the tracker's vocabulary —
 * and every way of getting it wrong is silent: a missing column hides work, an
 * invented order reads as the board reordering itself.
 */

const facet = (state: string, count: number, live = count): TicketStateFacet => ({
  state,
  count,
  live,
  pickup: false,
});

const FACETS = [facet('Closed', 218, 0), facet('Ready', 14), facet('In Review', 5), facet('Removed', 7, 0)];

test('with no configured order the columns are the facets, in the order they arrive', () => {
  // The route sorts facets by count descending, and that is the fallback: a fresh
  // deployment gets a working board with nothing configured, and the order is the
  // one the tab already shows in its State tier.
  const { columns, unlisted } = boardColumns([], FACETS, ['Ready']);
  assert.deepEqual(
    columns.map((c) => c.state),
    ['Closed', 'Ready', 'In Review', 'Removed'],
  );
  assert.deepEqual(unlisted, [], 'nothing can be unlisted when nothing was listed');
});

test('a configured order is honoured exactly, including states with nothing in them', () => {
  const { columns } = boardColumns(['Ready', 'Doing', 'In Review', 'Closed'], FACETS, ['Ready', 'Doing']);
  assert.deepEqual(
    columns.map((c) => c.state),
    ['Ready', 'Doing', 'In Review', 'Closed'],
    'the operator’s order, not the counts',
  );
  const doing = columns.find((c) => c.state === 'Doing');
  // Naming a column is the operator saying they expect work there. Dropping it
  // would hide a state that is merely quiet today, and the board would silently
  // differ from the config they are reading.
  assert.deepEqual(doing, { state: 'Doing', count: 0, live: 0, pickup: true, empty: true });
});

test('a state the mirror carries that the config omits is reported, never dropped in silence', () => {
  const { columns, unlisted } = boardColumns(['Ready', 'In Review'], FACETS, ['Ready']);
  assert.deepEqual(
    columns.map((c) => c.state),
    ['Ready', 'In Review'],
  );
  // Work vanishing off a board because a config list is short is the quiet loss
  // this reporting exists to refuse — and it is how a typo in the key becomes
  // visible rather than invisible.
  assert.deepEqual(
    unlisted.map((f) => [f.state, f.count]),
    [
      ['Closed', 218],
      ['Removed', 7],
    ],
    'in the facets’ own order, so the biggest omission reads first',
  );
});

test('the pickup mark on a column is the dispatcher’s effective set, for every column alike', () => {
  // Facet-backed and configured-but-empty columns resolve `pickup` the same way,
  // from one list. Preferring the facet's own flag where there is one and the list
  // where there is not is exactly the drift that would put two answers on a board.
  const { columns } = boardColumns(['Ready', 'Doing', 'Closed'], FACETS, ['Ready', 'Doing']);
  assert.deepEqual(
    columns.map((c) => [c.state, c.pickup]),
    [
      ['Ready', true],
      ['Doing', true],
      ['Closed', false],
    ],
  );
});

test('a configured state repeated or blank draws one column, and no blank one', () => {
  // The key is hand-editable, and a duplicate would give two columns one fetch and
  // one drop target each — two places to leave disagreeing about the same state.
  const { columns } = boardColumns(['Ready', 'Ready', '', '  '], FACETS, ['Ready']);
  assert.deepEqual(
    columns.map((c) => c.state),
    ['Ready'],
  );
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
npx tsx --test test/ticketBoard.test.ts
```

Expected: FAIL — `web/src/ticketBoard.ts` does not exist.

- [ ] **Step 3: Write the implementation**

Create `web/src/ticketBoard.ts`:

```ts
import type { TicketStateFacet } from './types.js';

/**
 * The card view's own pure decisions: which columns exist, what a card's reason
 * line says, and what a drop would cost.
 *
 * All three are here rather than in the components for the reason `cascadeNote` and
 * `watchReading` are pure — each is a statement about *which of several readings
 * wins*, and no render can show that. A board that drew the wrong column order, the
 * wrong sentence under a card, or the wrong warning on a header would look exactly
 * like one that drew the right one.
 *
 * → docs/spec/17-cockpit.md#the-tickets-tab
 */

/** One column of the board: a state, what is in it, and what the harness makes of it. */
export interface BoardColumn {
  state: string;
  /** Every mirrored item in this state, before the rail's filters. */
  count: number;
  /** How many of those are still in the tracker's open set. */
  live: number;
  /** A state the dispatcher's effective gate lets through. */
  pickup: boolean;
  /** True for a column the config names that the mirror has nothing in. */
  empty: boolean;
}

/**
 * The columns to draw, in order, and the states that get none.
 *
 * An **empty** `boardStates` falls back to the facets, which the route already sorts
 * by count — a deployment with nothing configured gets a working board, in the order
 * its State tier already shows. A configured order is taken exactly as written,
 * including a state nothing is in: naming a column is the operator saying they
 * expect work there, and quietly dropping it would make the board disagree with the
 * config file they are reading.
 *
 * `unlisted` is the other half of the same honesty. A state the mirror carries that
 * the config omits has no column, so its items are on no board at all — reported so
 * a short list reads as a choice and a typo reads as a mistake, rather than both
 * reading as an empty tracker.
 *
 * `pickup` is resolved from one list for every column, facet-backed or not: reading
 * the facet's own flag where there is one and the list where there is not would be
 * two answers to one question, on the control that decides whether a header warns
 * the fleet will stop.
 */
export function boardColumns(
  boardStates: readonly string[],
  facets: readonly TicketStateFacet[],
  pickup: readonly string[],
): { columns: BoardColumn[]; unlisted: TicketStateFacet[] } {
  const byState = new Map(facets.map((facet) => [facet.state, facet]));
  const gate = new Set(pickup);

  if (boardStates.length === 0) {
    return {
      columns: facets.map((facet) => ({
        state: facet.state,
        count: facet.count,
        live: facet.live,
        pickup: gate.has(facet.state),
        empty: false,
      })),
      unlisted: [],
    };
  }

  // Trimmed and deduplicated because the key is hand-editable: a repeat would give
  // two columns one fetch and one drop target each, which is two places to leave
  // disagreeing about one state.
  const wanted: string[] = [];
  const seen = new Set<string>();
  for (const raw of boardStates) {
    const state = raw.trim();
    if (state === '' || seen.has(state)) continue;
    seen.add(state);
    wanted.push(state);
  }

  return {
    columns: wanted.map((state) => {
      const facet = byState.get(state);
      return {
        state,
        count: facet?.count ?? 0,
        live: facet?.live ?? 0,
        pickup: gate.has(state),
        empty: facet === undefined,
      };
    }),
    // The facets' own order, so the largest omission reads first.
    unlisted: facets.filter((facet) => !seen.has(facet.state)),
  };
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
npx tsx --test test/ticketBoard.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the full check**

```bash
npm run check
```

- [ ] **Step 6: Commit**

```bash
git add web/src/ticketBoard.ts test/ticketBoard.test.ts
git commit -m "Decide the board's columns, and what the board has to admit it is not drawing"
```

---

### Task 7: `cardReason` — the sentence under every card

The reason lane is the board's whole advantage over the table: it answers "why is nothing on this?"
for every card on screen without a click. Five readings can supply it, so the function's subject is
which one wins.

**Files:**

- Modify: `web/src/ticketBoard.ts` (append)
- Test: `test/ticketBoard.test.ts` (append)

**Interfaces:**

- Consumes: `TicketRow` and `Issue` from `web/src/types.js`; `watchBucket` from `web/src/worldBuckets.js`; `relAge` — **not** used here, the frozen arm takes a pre-formatted age string so the function stays free of the clock.
- Produces:

  ```ts
  export type CardReasonTone = 'held' | 'outcome' | 'pickup' | 'frozen' | 'unwatched';
  export function cardReason(
    row: TicketRow,
    issue: Issue | null,
    watchLabel: string,
    frozenAge: string,
  ): { tone: CardReasonTone; words: string };
  ```

- [ ] **Step 1: Write the failing test**

Append to `test/ticketBoard.test.ts`. Extend the imports:

```ts
import { boardColumns, cardReason } from '../web/src/ticketBoard.js';
import type { Issue, TicketRow, TicketStateFacet } from '../web/src/types.js';
```

and append:

```ts
function row(over: Partial<TicketRow> & Pick<TicketRow, 'number'>): TicketRow {
  return {
    title: `Ticket ${over.number}`,
    state: 'open',
    watch: 'watched',
    labels: [],
    costUsd: null,
    outcome: null,
    addedAt: '2026-08-01T00:00:00.000Z',
    changedAt: '2026-08-01T00:00:00.000Z',
    tracking: 'live',
    workItemState: 'Ready',
    issueType: null,
    featureSlot: null,
    ...over,
  };
}

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: 'issue_1',
    number: 40,
    title: 'Forty',
    state: 'open',
    labels: ['lubbdubb-watch'],
    pickup: { eligible: false, status: 'blocked', reasons: [] },
    ...over,
  } as unknown as Issue;
}

test('an intake hold outranks everything — it is the reading that stops dispatch', () => {
  const held = cardReason(
    row({ number: 40, outcome: 'delivered' }),
    issue({ assay: { verdict: 'unclear', summary: 'no acceptance criteria' } } as Partial<Issue>),
    'lubbdubb-watch',
    '3d',
  );
  assert.equal(held.tone, 'held');
  assert.match(held.words, /held at intake/);
});

test('an unwatched item is never held, whatever a stale verdict says', () => {
  // Nothing assays a goal nobody opted in, so a verdict on one is left over from
  // before it was dropped — and the drop outranks it. The table's own rule.
  const dropped = cardReason(
    row({ number: 40, watch: 'unwatched' }),
    issue({ labels: [], assay: { verdict: 'unclear', summary: 'stale' } } as Partial<Issue>),
    'lubbdubb-watch',
    '3d',
  );
  assert.equal(dropped.tone, 'unwatched');
});

test('the outcome word wins over the dispatcher’s reason — the harness has finished deciding', () => {
  const done = cardReason(
    row({ number: 40, outcome: 'delivered' }),
    issue({ pickup: { eligible: false, status: 'blocked', reasons: ['a work agent is on this'] } } as Partial<Issue>),
    'lubbdubb-watch',
    '3d',
  );
  assert.equal(done.tone, 'outcome');
  assert.match(done.words, /delivered/);
});

test('otherwise the dispatcher’s own first sentence is quoted, never re-derived', () => {
  const blocked = cardReason(
    row({ number: 40 }),
    issue({ pickup: { eligible: false, status: 'blocked', reasons: ['a work agent is on this'] } } as Partial<Issue>),
    'lubbdubb-watch',
    '3d',
  );
  assert.equal(blocked.tone, 'pickup');
  assert.equal(
    blocked.words,
    'a work agent is on this',
    'quoted whole — a paraphrase would be the only account there is',
  );
});

test('a frozen row with nothing else to say names its age', () => {
  const frozen = cardReason(row({ number: 40, tracking: 'frozen' }), null, 'lubbdubb-watch', '3d');
  assert.equal(frozen.tone, 'frozen');
  assert.match(frozen.words, /frozen/);
  assert.match(frozen.words, /3d/);
});

test('a watched item the dispatcher has said nothing about says exactly that', () => {
  // The absence is a reading too. A blank lane would read as a card that failed to
  // draw, which is the one thing the always-drawn lane exists to avoid.
  const quiet = cardReason(
    row({ number: 40 }),
    issue({ pickup: { eligible: true, status: 'ready', reasons: [] } } as Partial<Issue>),
    'lubbdubb-watch',
    '3d',
  );
  assert.equal(quiet.tone, 'pickup');
  assert.match(quiet.words, /waiting to be picked up/);
});

test('the world wins over the mirror on the watch reading, as everywhere on this tab', () => {
  // `TicketRow.watch` is the mirror's, and the mirror is a record the tab does not
  // refetch on a click. Reading it first is a lane that goes on saying "not watched"
  // after the tag has landed (#417).
  const justWatched = cardReason(
    row({ number: 40, watch: 'unwatched' }),
    issue({ labels: ['lubbdubb-watch'], pickup: { eligible: true, status: 'ready', reasons: [] } } as Partial<Issue>),
    'lubbdubb-watch',
    '3d',
  );
  assert.equal(justWatched.tone, 'pickup');
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
npx tsx --test test/ticketBoard.test.ts
```

Expected: FAIL — `cardReason` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `web/src/ticketBoard.ts`:

```ts
/** Which of the five readings the lane is drawing, so the card can tint it. */
export type CardReasonTone = 'held' | 'outcome' | 'pickup' | 'frozen' | 'unwatched';

/**
 * The sentence under a card, and which of five readings supplied it.
 *
 * Precedence is the whole subject, and each step earns its place:
 *
 * 1. **Held at intake** — an unclear assay is the one reading that stops dispatch,
 *    so among a page of cards it must not read as a detail.
 * 2. **The outcome word** — the harness has finished deciding, which outranks its
 *    account of what it would do next.
 * 3. **The dispatcher's first reason**, quoted whole.
 * 4. **Frozen** — nothing in the tracker's open set has a next cycle to explain.
 * 5. **Unwatched** — nobody opted it in, which is why nothing has an opinion.
 *
 * An **unwatched** item is never held, whatever a stale verdict says: nothing assays
 * a goal nobody opted in, so a verdict on one is left over from before it was
 * dropped, and the drop outranks it. That is the table's rule, and reading it the
 * other way would light the intake lamp on work the harness has been told to leave.
 *
 * The watch reading comes from the **world** where the world holds the item and the
 * mirror only where it does not — `watchReading`'s rule, for its reason: the tab does
 * not refetch its page on a click, so believing the mirror first is a lane that goes
 * on saying "not watched" after the tag has landed.
 *
 * `frozenAge` is passed in already formatted, so this stays free of the clock and
 * every case is assertable without one.
 */
export function cardReason(
  row: TicketRow,
  issue: Issue | null,
  watchLabel: string,
  frozenAge: string,
): { tone: CardReasonTone; words: string } {
  const watched = (issue === null ? row.watch : watchBucket(issue.labels, watchLabel)) === 'watched';

  if (watched && issue?.assay?.verdict === 'unclear') {
    return { tone: 'held', words: 'held at intake — the assay is unclear, so nothing under it moves' };
  }
  if (row.outcome !== null) return { tone: 'outcome', words: row.outcome };

  const reason = issue?.pickup.reasons[0];
  if (reason !== undefined) return { tone: 'pickup', words: reason };

  if (row.tracking === 'frozen') {
    return { tone: 'frozen', words: `frozen${frozenAge === '' ? '' : ` · last change ${frozenAge}`}` };
  }
  if (!watched) return { tone: 'unwatched', words: 'not watched — nobody has opted this in' };
  // The absence is a reading too: a blank lane reads as a card that failed to draw,
  // which is the one thing an always-drawn lane exists to avoid.
  return { tone: 'pickup', words: 'waiting to be picked up' };
}
```

Extend the file's imports at the top:

```ts
import type { Issue, TicketRow, TicketStateFacet } from './types.js';
import { watchBucket } from './worldBuckets.js';
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
npx tsx --test test/ticketBoard.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the full check**

```bash
npm run check
```

- [ ] **Step 6: Commit**

```bash
git add web/src/ticketBoard.ts test/ticketBoard.test.ts
git commit -m "Say why nothing is on a card, from the reading that actually decided it"
```

---

### Task 8: `dropWarning` — what dropping on a column costs

Composed clauses rather than enumerated cases, because the facts are independent and an enumeration
would have to pick one to report.

**Files:**

- Modify: `web/src/ticketBoard.ts` (append)
- Test: `test/ticketBoard.test.ts` (append)

**Interfaces:**

- Consumes: `BoardColumn` (Task 6); `CockpitConfig['stateRules']` (Task 3).
- Produces:

  ```ts
  export type DropTone = 'none' | 'ok' | 'warn' | 'stop';
  export interface StateRules {
    pickup: string[];
    inProgress: string | null;
    inReview: string | null;
    returnsTo: string | null;
  }
  export function dropWarning(
    column: BoardColumn,
    from: string | null,
    rules: StateRules | null,
  ): { tone: DropTone; words: string };
  ```

- [ ] **Step 1: Write the failing test**

Append to `test/ticketBoard.test.ts`. Extend the imports:

```ts
import { boardColumns, cardReason, dropWarning, type StateRules } from '../web/src/ticketBoard.js';
```

and append:

```ts
const RULES: StateRules = {
  // The effective set: "Doing" is in it because `effectivePickupStates` folds the
  // in-progress state in, and src/config.ts says it should not be listed.
  pickup: ['Ready', 'Doing'],
  inProgress: 'Doing',
  inReview: 'In Review',
  returnsTo: 'Ready',
};

const column = (state: string, over: Partial<Parameters<typeof dropWarning>[0]> = {}) => ({
  state,
  count: 5,
  live: 5,
  pickup: RULES.pickup.includes(state),
  empty: false,
  ...over,
});

test('the column a card is already in offers nothing — there is no move to describe', () => {
  const same = dropWarning(column('Ready'), 'Ready', RULES);
  assert.equal(same.tone, 'none');
  assert.match(same.words, /where it is now/);
});

test('a pickup state says the fleet can work it', () => {
  const ready = dropWarning(column('Ready'), 'In Review', RULES);
  assert.equal(ready.tone, 'ok');
  assert.match(ready.words, /a pickup state/);
});

test('the in-progress state reads as a pickup state, because the dispatcher folds it in', () => {
  // Built from the raw `issuePickupStates` this would say the fleet stops, which is
  // the opposite of true and the single wording most likely to get this wrong.
  const doing = dropWarning(column('Doing'), 'Ready', RULES);
  assert.equal(doing.tone, 'ok');
  assert.match(doing.words, /a pickup state/);
  assert.match(doing.words, /a rule moves items here itself/, 'and it says the rule will do this on its own');
});

test('leaving the pickup states says the fleet stops', () => {
  const parked = dropWarning(column('Blocked'), 'Ready', RULES);
  assert.equal(parked.tone, 'stop');
  assert.match(parked.words, /the fleet stops picking this up/);
});

test('the review state names the condition on the bounce, and never promises one', () => {
  // `work-item-back-to-pickup` fires only on an explicit `more_work` verdict, never
  // on the mere absence of a PR — that was changed deliberately, because a merged PR
  // used to bounce its ticket to "Ready" and put a fresh agent on merged work.
  const review = dropWarning(column('In Review'), 'Ready', RULES);
  assert.equal(review.tone, 'warn');
  assert.match(review.words, /the fleet stops picking this up/);
  assert.match(review.words, /"Ready"/, 'and where it would come back to');
  assert.match(review.words, /work outstanding|more work/i, 'stated as a condition, not a certainty');
});

test('a column with nothing live states that fact, and claims nothing about closing', () => {
  // Whether a state maps to closed is the tracker's workflow, which the harness has
  // no reading of. Saying "closes it" would be a guess dressed as a warning.
  const closed = dropWarning(column('Closed', { live: 0, count: 218 }), 'Ready', RULES);
  assert.match(closed.words, /still in the tracker’s open set/);
  assert.doesNotMatch(closed.words, /closes it/i);
});

test('with no state gate configured a drop disturbs nothing the harness reads', () => {
  // All three work-item rules are switched out without `issuePickupStates`, so
  // implying otherwise would warn about a mechanism that is not running.
  const bare = dropWarning(column('Anything', { pickup: false }), 'Ready', null);
  assert.equal(bare.tone, 'none');
  assert.match(bare.words, /no state gate/);
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
npx tsx --test test/ticketBoard.test.ts
```

Expected: FAIL — `dropWarning` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `web/src/ticketBoard.ts`:

```ts
/** How loudly a column's header speaks while a card is in the air. */
export type DropTone = 'none' | 'ok' | 'warn' | 'stop';

/**
 * The state words the work-item rules act on — `CockpitConfig.stateRules`, named here
 * so the pure function does not import a wire type it only reads three fields of.
 */
export interface StateRules {
  /** The dispatcher's *effective* pickup set, `inProgress` folded in. */
  pickup: string[];
  inProgress: string | null;
  inReview: string | null;
  /** Where `work-item-back-to-pickup` returns an item: the first configured pickup state. */
  returnsTo: string | null;
}

/**
 * What dropping a card on this column would cost, said before the drop rather than
 * discovered after it — the habit `stateWhy` and `cascadeNote` already keep.
 *
 * **Clauses, not cases.** The facts are independent: a column can be outside the
 * pickup gate *and* the one a rule writes *and* hold nothing live. An enumeration
 * would have to choose which of the three to report, and whichever it chose would be
 * the one the operator needed the other time.
 *
 * Three points where the obvious wording is wrong, each checked against the rules
 * themselves:
 *
 * - **The in-progress state is a pickup state**, even when `issuePickupStates` does
 *   not name it — `effectivePickupStates` folds it in and `src/config.ts` says it
 *   should not be listed. Reading the raw key would tell the operator that moving a
 *   card to "Doing" stops the fleet.
 * - **`work-item-back-to-pickup` fires only on an explicit `more_work` verdict**,
 *   never on a missing PR. "A rule may move this back" overstates it; the words name
 *   the condition.
 * - **A state with nothing live does not mean dropping there closes the item.**
 *   Whether a state maps to closed is the tracker's workflow, which the harness has
 *   no reading of, so the clause states only the fact the State tier already states.
 *
 * A null `rules` is the deployment with no state gate at all, where all three rules
 * are switched out — so the drop is a tracker fact and nothing else, and saying more
 * would warn about a mechanism that is not running.
 */
export function dropWarning(
  column: BoardColumn,
  from: string | null,
  rules: StateRules | null,
): { tone: DropTone; words: string } {
  if (from !== null && column.state === from) return { tone: 'none', words: 'where it is now' };
  if (rules === null) {
    return { tone: 'none', words: 'no state gate is configured — this changes the tracker and nothing else' };
  }

  const parts: string[] = [];
  let tone: DropTone = column.pickup ? 'ok' : 'stop';
  parts.push(
    column.pickup
      ? 'a pickup state — the fleet can work this'
      : 'leaves the pickup states — the fleet stops picking this up',
  );

  if (column.state === rules.inProgress) {
    parts.push('a rule moves items here itself once an agent starts');
  }
  if (column.state === rules.inReview && rules.returnsTo !== null) {
    tone = 'warn';
    parts.push(`work-item-back-to-pickup returns it to "${rules.returnsTo}" if a verdict reports work outstanding`);
  }
  if (column.live === 0 && column.count > 0) {
    if (tone !== 'stop') tone = 'warn';
    parts.push('nothing under this state is still in the tracker’s open set');
  }

  return { tone, words: parts.join(' · ') };
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
npx tsx --test test/ticketBoard.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the full check**

```bash
npm run check
```

- [ ] **Step 6: Commit**

```bash
git add web/src/ticketBoard.ts test/ticketBoard.test.ts
git commit -m "Say what a drop costs before the drop, from what the rules actually do"
```

---

### Task 9: `ticketView` and `ticketColumns` on `Place`

Two new pieces of "where am I": which view the tab is in, and which columns are hidden. Both go on
`Place`, because a view held in a `useState` works until the back button steps over it or a reload
drops it — and both are silent.

Nothing renders them yet. `Place` is a type, so an unread field breaks no knip rule, and
`test/cockpitPlace.test.ts` round-trips it.

**Files:**

- Modify: `web/src/cockpit/place.ts` (the `Place` interface, `NOWHERE`, `readPlace`, `placeQuery`, and a new `readStrings` helper beside `readNumbers`)
- Modify: `web/src/view/viewModel.ts` (the view fields at ~line 97, the input fields at ~line 254, the defaults at ~line 313)
- Modify: `web/src/cockpit/useCockpit.ts` (~line 307, the pass-through)
- Modify: `web/src/cockpit/actions.ts` (~line 219, `setTicketQuery`'s `Pick`)
- Test: `test/cockpitPlace.test.ts` (append, and extend the round-trip list)
- Docs: `docs/spec/17-cockpit.md` — `## The address bar`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces:

  - `Place['ticketView']: 'table' | 'card'`, default `'table'`, query parameter `view`
  - `Place['ticketColumns']: string[]` — the **hidden** columns, default `[]`, query parameter `hide`
  - The same two fields on `CockpitView`, and both accepted by `actions.setTicketQuery`

- [ ] **Step 1: Write the failing test**

In `test/cockpitPlace.test.ts`, add to the `places` array in the round-trip test:

```ts
    at({ tab: 'tickets', ticketView: 'card' }),
    at({ tab: 'tickets', ticketView: 'card', ticketColumns: ['Closed', 'Removed'] }),
    at({ tab: 'tickets', ticketColumns: ['Removed'] }),
```

and append these tests:

```ts
test('the table is the default view, so it costs no query parameter', () => {
  assert.equal(placeQuery(at({ tab: 'tickets' })), '?tab=tickets');
  assert.equal(readPlace('?tab=tickets').ticketView, 'table');
  // And an unknown view resolves to the default rather than to nothing, like every
  // other validated parameter here.
  assert.equal(readPlace('?tab=tickets&view=kanban').ticketView, 'table');
});

test('hidden columns are the exception, so an untouched board is a bare URL', () => {
  // Hidden rather than shown, for `collapsed`'s reason: the default is the empty
  // list, and a state that appears in the tracker later shows up on its own rather
  // than being invisibly excluded by a list written before it existed.
  assert.equal(placeQuery(at({ tab: 'tickets', ticketView: 'card' })), '?tab=tickets&view=card');
  assert.deepEqual(readPlace('?tab=tickets').ticketColumns, []);
});

test('hidden columns have one spelling, so hiding A then B is not a second place', () => {
  const one = placeQuery(at({ tab: 'tickets', ticketColumns: ['Removed', 'Closed'] }));
  const other = placeQuery(at({ tab: 'tickets', ticketColumns: ['Closed', 'Removed'] }));
  assert.equal(one, other, 'sorted on the way out, or the two would push a history entry going nowhere');
  assert.deepEqual(readPlace(one).ticketColumns, ['Closed', 'Removed']);
});

test('a state word with a comma in it cannot be hidden, and does not corrupt the list', () => {
  // The separator is the one character a tracker's state word may not contain here.
  // Encoding it would be a second grammar in the address bar; dropping the part is
  // the same treatment every other junk value gets.
  assert.deepEqual(readPlace('?tab=tickets&hide=Closed,,%20%20,Removed').ticketColumns, ['Closed', 'Removed']);
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
npx tsx --test test/cockpitPlace.test.ts
```

Expected: FAIL at compile — `ticketView` is not a `Place` field.

- [ ] **Step 3: Add the fields to `Place` and `NOWHERE`**

In `web/src/cockpit/place.ts`, in the `Place` interface immediately after `ticketOrder`:

```ts
  /**
   * The table, or the board of state columns.
   *
   * A place rather than a `useState` for the reason every field here is one: a view
   * switched and then stepped back out of has to come back, and a link someone sends
   * has to open on the view they were looking at. Defaults to the table, which is
   * what the tab has always been.
   */
  ticketView: 'table' | 'card';
  /**
   * The board columns hidden from view — the **hidden** ones, not the shown ones.
   *
   * Inverted for `collapsed`'s reason: the default is the empty list and so a bare
   * URL, and a state the tracker starts reporting later appears on its own instead
   * of being excluded by a list written before it existed.
   */
  ticketColumns: string[];
```

In `NOWHERE`, after `ticketOrder: 'added',`:

```ts
  ticketView: 'table',
  ticketColumns: [],
```

Beside the existing `TICKET_GROUP` / `TICKET_ORDER` whitelists, add:

```ts
const TICKET_VIEW: readonly Place['ticketView'][] = ['table', 'card'];
```

- [ ] **Step 4: Read and write them**

In `readPlace`, after the `ticketOrder` line:

```ts
    ticketView: TICKET_VIEW.find((v) => v === param(query, 'view')) ?? 'table',
    ticketColumns: readStrings(param(query, 'hide')),
```

Beside `readNumbers`, add:

```ts
/**
 * A comma-separated list of tracker state words, validated the way every parameter
 * here is: blanks are dropped rather than carried, because a hand-edited `?hide=`
 * is an input an operator can type and an empty entry would hide a column that does
 * not exist. Deduplicated and sorted so one set of hidden columns has one spelling.
 *
 * A comma is therefore the one character a state word cannot contain here. Encoding
 * one would be a second grammar in the address bar for a case no tracker produces.
 */
function readStrings(value: string | null): string[] {
  if (value === null) return [];
  const seen = new Set<string>();
  for (const part of value.split(',')) {
    const state = part.trim();
    if (state !== '') seen.add(state);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}
```

In `placeQuery`, after the `ticketOrder` line:

```ts
if (place.ticketView !== 'table') query.set('view', place.ticketView);
// Sorted on the way out as on the way in, so hiding A then B and B then A are one
// place rather than two history entries.
if (place.ticketColumns.length > 0) {
  query.set('hide', [...place.ticketColumns].sort((a, b) => a.localeCompare(b)).join(','));
}
```

- [ ] **Step 5: Thread them through the view model and the actions**

In `web/src/view/viewModel.ts`, add to the view fields beside `ticketOrder`:

```ts
  ticketView: 'table' | 'card';
  ticketColumns: string[];
```

to the input fields:

```ts
  ticketView?: 'table' | 'card';
  ticketColumns?: string[];
```

and to the defaults:

```ts
    ticketView: input.ticketView ?? 'table',
    ticketColumns: input.ticketColumns ?? [],
```

In `web/src/cockpit/useCockpit.ts`, beside `ticketOrder: place.ticketOrder,`:

```ts
      ticketView: place.ticketView,
      ticketColumns: place.ticketColumns,
```

In `web/src/cockpit/actions.ts`, widen `setTicketQuery`'s `Pick` to include the two new fields:

```ts
  setTicketQuery(
    next: Partial<
      Pick<
        Place,
        | 'ticketWatch'
        | 'ticketTracking'
        | 'ticketState'
        | 'ticketFeature'
        | 'ticketGroup'
        | 'ticketOrder'
        | 'ticketView'
        | 'ticketColumns'
      >
    >,
  ): void;
```

- [ ] **Step 6: Run the tests and watch them pass**

```bash
npx tsx --test test/cockpitPlace.test.ts test/cockpitViewModel.test.ts
```

Expected: PASS.

- [ ] **Step 7: Update the spec**

In `docs/spec/17-cockpit.md`, in `## The address bar`, add the two parameters to the list of what the
query string carries — `view` and `hide` — including why the hidden columns are the ones written down
rather than the shown ones.

- [ ] **Step 8: Run the full check**

```bash
npm run check
```

- [ ] **Step 9: Commit**

```bash
git add web/src/cockpit/place.ts web/src/view/viewModel.ts web/src/cockpit/useCockpit.ts web/src/cockpit/actions.ts test/cockpitPlace.test.ts docs/spec/17-cockpit.md
git commit -m "Put the tickets view and its hidden columns in the address bar"
```

---

### Task 10: The board and the card, read-only

The board renders. No drag yet — this task is the columns, their independent scrolling and paging, the
card with its reason lane and its clickable watch dot, the toggle, and the rail changes.

**Both new files must land in this commit**: knip's `files: "error"` fails a source file nothing
imports.

**Files:**

- Create: `web/src/components/TicketCard.tsx`
- Create: `web/src/components/TicketsBoard.tsx`
- Modify: `web/src/components/TicketsPanel.tsx` (the toggle in the rail, the rail's card-view behaviour, and rendering the board instead of the table)
- Modify: `web/src/console/ConsoleRoot.tsx` (~line 125, pass the two new fields through `query`/`onQuery`)
- Modify: `web/src/styles.css` (board and card rules, and the new tokens on **both** `:root` blocks)
- Modify: `web/src/cockpit/tokens.ts` (register every new token)
- Docs: `docs/spec/17-cockpit.md` — a new `### The board, and what a card says` subsection under `## The tickets tab`

**Interfaces:**

- Consumes: `boardColumns`, `cardReason` and `BoardColumn` (Tasks 6–7); `view.state.config.boardStates` and `view.state.config.stateRules` (Tasks 2–3); `Place['ticketView'] | ['ticketColumns']` (Task 9); the existing `api.getTickets` and `actions.setIssueWatched`.
- Produces: `TicketsBoard` and `TicketCard` components, and the `dragged`/`onDrop` props Task 11 fills in.

- [ ] **Step 1: Add the tokens, as mixes so no preset owes them an answer**

In `web/src/styles.css`, in **both** `:root` blocks (the light one and the dark one), add — every value a
`color-mix` of an existing core token, because a bare literal would have to be answered by all five
presets in `theme.css` **and** the print block:

```css
--board-col: color-mix(in srgb, var(--well) 80%, var(--panel) 20%);
--board-head: color-mix(in srgb, var(--panel) 88%, var(--text) 12%);
--board-drop-ok: color-mix(in srgb, var(--green) 78%, var(--panel) 22%);
--board-drop-warn: color-mix(in srgb, var(--amber) 78%, var(--panel) 22%);
--board-drop-stop: color-mix(in srgb, var(--red) 78%, var(--panel) 22%);
```

Those five core tokens all exist in both `:root` blocks (`--well`, `--panel`, `--text`, `--green`,
`--amber`, `--red` — `styles.css:19-33` and the light block at `:983`), so each mix follows the theme
and no preset owes it a line.

In `web/src/cockpit/tokens.ts`, add one `THEME_TOKENS` entry per new property, in the same order the
sheet declares them, each in the `tints` group with `kind: 'colour'` and a `why` that says what moves
on screen — e.g. `'The board columns behind the cards.'`

- [ ] **Step 2: Run the theme test and watch it pass on the tokens alone**

```bash
npx tsx --test test/cockpitTheme.test.ts
```

Expected: PASS. If it fails on "declared on :root but not in the registry" or the reverse, the two
lists disagree — fix that before writing any markup. If it fails on preset coverage, a value is a
literal rather than a mix.

- [ ] **Step 3: Write the card**

Create `web/src/components/TicketCard.tsx`. It draws one card: the stripe, the header line, the title
button, the meta line and the reason lane, and it takes a `draggable` prop it does not yet act on.

```tsx
import type { JSX } from 'react';
import type { CockpitActions } from '../cockpit/actions.js';
import { cardReason } from '../ticketBoard.js';
import { cascadeNote, issueTypeTone, watchReading } from '../issueGroups.js';
import type { Issue, TicketRow } from '../types.js';
import type { CockpitView } from '../view/viewModel.js';
import { AsyncButton } from './AsyncButton.js';
import { Ref } from './refs.js';
import { fmtUsd, relAge } from './util.js';

/**
 * One card on the board: what it is, what the harness makes of it, and the two
 * things a click can do.
 *
 * **The reason lane is always drawn**, and it is the board's whole advantage over
 * the table — a column of cards answers "why is nothing on this?" without a click on
 * any of them. `cardReason` decides which of five readings supplies it, because that
 * is a statement about precedence and no render can show one.
 *
 * **The title opens the goal**, through the same `selectGoal` every other surface
 * that lists one calls. The `<Ref>` sits beside it rather than inside it: one click
 * cannot have two destinations.
 *
 * **The watch dot is the control.** The table's Watch/Unwatch pair does not fit here
 * and the lane has the space it would take, so the dot both reports the tag and
 * writes it — with `cascadeNote`'s phrase in the title, so a click that writes eight
 * tags says eight. It is refused in the three cases the table refuses it, each with
 * its reason in the title.
 */
export function TicketCard({
  row,
  issue,
  view,
  actions,
  now,
  draggable,
}: {
  row: TicketRow;
  /** The live world's own row where it still holds one — the source of every live reading. */
  issue: Issue | null;
  view: CockpitView;
  actions: CockpitActions;
  now: number;
  draggable: boolean;
}): JSX.Element {
  const { watchLabel, containerTypes } = view.state.config;
  const frozen = row.tracking === 'frozen';
  const age = row.changedAt ? relAge(row.changedAt, now) : '';
  const reason = cardReason(row, issue, watchLabel, age);
  const watched = watchReading(issue, row, watchLabel) === 'watched';
  const off =
    watchLabel === ''
      ? 'No watch label configured — the watch gate is off'
      : frozen
        ? 'Closed in the tracker — there is nothing here to tag'
        : issue === null
          ? 'The world no longer holds this item, so there is nothing to tag'
          : null;
  const also = issue === null ? '' : cascadeNote(issue, containerTypes);

  return (
    <article className={`tb-card ${frozen ? 'frozen' : ''}`} draggable={draggable} data-number={row.number}>
      <i className={`tb-stripe f${row.featureSlot ?? 0}`} />
      <div className="tb-top">
        <span className="tb-id">#{row.number}</span>
        {row.issueType !== null && <i className={`tickets-type ${issueTypeTone(row.issueType)}`}>{row.issueType}</i>}
        {reason.tone === 'held' && <i className="tickets-lamp" />}
        <AsyncButton
          className={`tb-dot ${watched ? 'on' : ''}`}
          disabled={off !== null}
          onClick={() => actions.setIssueWatched(row.number, !watched)}
          title={
            off ??
            (watched
              ? `Take "${watchLabel}" off #${row.number}${also}, so the harness leaves it alone`
              : `Tag #${row.number}${also} "${watchLabel}" so the harness picks it up`)
          }
        >
          <span aria-hidden="true" />
        </AsyncButton>
        <span className="tb-gap" />
        {/* The card names the ticket and this is the way to it — drawn with `<Ref>`,
            never as text, and never inside the button above. */}
        <span className="cn-refs">
          <Ref to={`issue:${row.number}`} />
        </span>
      </div>
      <button
        type="button"
        className="tb-name"
        onClick={() => actions.selectGoal(`issue:${row.number}`)}
        title="Open this goal — its plan, its ticket, its pull requests and anything it is asking you"
      >
        {row.title}
      </button>
      <div className="tb-meta">
        {/* An em dash, not `$0.00`: never worked and worked for free are different
            facts, and a zero would state the wrong one. */}
        <span className={row.costUsd === null ? 'none' : 'money'}>
          {row.costUsd === null ? '—' : fmtUsd(row.costUsd)}
        </span>
        {age !== '' && <span>{age}</span>}
        {row.parent && (
          <span className="tb-feat">
            <i className={`tickets-sw f${row.featureSlot ?? 0}`} />
            {row.parent.title}
          </span>
        )}
      </div>
      <p className={`tb-why ${reason.tone}`}>{reason.words}</p>
    </article>
  );
}
```

- [ ] **Step 4: Write the board**

Create `web/src/components/TicketsBoard.tsx`. One `Column` component owning its own page state, its
own cursor and its own observer; the board owning the column list and the unlisted foot line.

```tsx
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { api } from '../api.js';
import type { CockpitActions } from '../cockpit/actions.js';
import { boardColumns, type BoardColumn } from '../ticketBoard.js';
import type {
  Issue,
  TicketOrder,
  TicketRow,
  TicketStateFacet,
  TicketTrackingFilter,
  TicketWatchFilter,
} from '../types.js';
import type { CockpitView } from '../view/viewModel.js';
import { stateColour } from '../stateColour.js';
import { RefLinksExtended } from './refs.js';
import { TicketCard } from './TicketCard.js';

/** What every column's fetch is narrowed by, minus the state that makes it a column. */
export interface BoardQuery {
  watch: TicketWatchFilter;
  tracking: TicketTrackingFilter;
  feature: number | 'none' | null;
  order: TicketOrder;
}

/**
 * The card view: one column per tracker state, each scrolling and paging on its own.
 *
 * **A column is a `/api/tickets` request pinned to its own state.** No new route and
 * no new payload: the list route already filters `state` as an exact match on
 * `work_item_state`, which is a column's definition. Bucketing one shared page
 * client-side was the alternative, and it makes a column's contents depend on how far
 * somebody scrolled a list that is not on screen.
 *
 * **The board scrolls sideways and each column scrolls inside itself**, so a column
 * running off the right edge hides nothing in the others.
 *
 * **A state the config omits gets no column, and the foot says so.** Items on no
 * board at all, unreported, is how a typo in `issueBoardStates` looks exactly like a
 * quiet tracker.
 */
export function TicketsBoard({
  query,
  facets,
  hidden,
  view,
  actions,
  now,
}: {
  query: BoardQuery;
  facets: readonly TicketStateFacet[];
  /** The columns the operator has hidden, from `Place.ticketColumns`. */
  hidden: readonly string[];
  view: CockpitView;
  actions: CockpitActions;
  now: number;
}): JSX.Element {
  const { boardStates, stateRules } = view.state.config;
  const { columns, unlisted } = boardColumns(boardStates, facets, stateRules?.pickup ?? []);
  const shown = columns.filter((column) => !hidden.includes(column.state));

  if (!view.state.config.canSetWorkItemState) {
    // Said once, above the columns, rather than discovered one failed drag at a
    // time — five identical failures teach nothing five times over.
    // (The note is drawn; the drag itself arrives with the next change.)
  }

  return (
    <div className="tb">
      {!view.state.config.canSetWorkItemState && (
        <p className="tb-note">This tracker cannot write work item states, so cards here cannot be moved.</p>
      )}
      <div className="tb-cols">
        {shown.map((column) => (
          <Column key={column.state} column={column} query={query} view={view} actions={actions} now={now} />
        ))}
      </div>
      {unlisted.length > 0 && (
        <p className="tb-unlisted">
          No column for{' '}
          {unlisted.map((facet, i) => (
            <span key={facet.state}>
              {i > 0 ? ', ' : ''}
              <b>{facet.state}</b> · {facet.count.toLocaleString()} item{facet.count === 1 ? '' : 's'}
            </span>
          ))}
          {' — '}
          <code>issueBoardStates</code> does not list {unlisted.length === 1 ? 'it' : 'them'}, so nothing here shows{' '}
          {unlisted.length === 1 ? 'that work' : 'that work'}.
        </p>
      )}
    </div>
  );
}

/**
 * One column: its own page, its own cursor, its own observer.
 *
 * The observer is rooted on **this** column's scroll box rather than on `.cn-sit`.
 * Rooted on the situation area a column's foot would intersect as soon as the board
 * was on screen, and every column would fetch its whole history at once.
 *
 * The header count is this column's own `total` once its first page lands, and the
 * whole-mirror facet before that — so the two numbers in "12 of 218" are about one set.
 */
function Column({
  column,
  query,
  view,
  actions,
  now,
}: {
  column: BoardColumn;
  query: BoardQuery;
  view: CockpitView;
  actions: CockpitActions;
  now: number;
}): JSX.Element {
  const [rows, setRows] = useState<TicketRow[]>([]);
  const [refUrls, setRefUrls] = useState<Record<string, string>>({});
  const [total, setTotal] = useState<number | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(false);

  const { watch, tracking, feature, order } = query;
  const state = column.state;

  const read = useCallback(
    async (from: string | null) => {
      setLoading(true);
      const page = await api.getTickets({
        watch,
        tracking,
        state,
        feature: feature === null ? null : String(feature),
        order,
        cursor: from,
      });
      setRows((prev) => (from === null ? page.rows : [...prev, ...page.rows]));
      setRefUrls((prev) => (from === null ? page.refUrls : { ...prev, ...page.refUrls }));
      setTotal(page.total);
      setCursor(page.nextCursor);
      setDone(page.nextCursor === null);
      setLoading(false);
    },
    [watch, tracking, state, feature, order],
  );

  useEffect(() => {
    // Cleared first, for the table's reason: a filter change must never show the
    // previous page while its own first one is in flight, or the cards read as
    // matching a filter they do not.
    setRows([]);
    setCursor(null);
    setDone(false);
    void read(null);
  }, [read]);

  const foot = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const sentinel = foot.current;
    if (sentinel === null || done || loading) return;
    const root = sentinel.closest('.tb-body');
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void read(cursor);
      },
      { root, rootMargin: '300px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [cursor, done, loading, read]);

  const worldIssues = view.state.world.issues;
  const live = new Map<number, Issue>(worldIssues.map((issue) => [issue.number, issue]));
  const colour = stateColour(view.state.config.stateColours, column.state);

  return (
    <section className="tb-col">
      <header className="tb-head" style={colour === null ? undefined : { borderTopColor: colour }}>
        <b>{column.state}</b>
        {column.pickup && <i className="tickets-gate">▲</i>}
        <i className="tb-k">
          {rows.length} of {(total ?? column.count).toLocaleString()}
        </i>
      </header>
      <div className="tb-body">
        <RefLinksExtended refUrls={refUrls}>
          {rows.map((row) => (
            <TicketCard
              key={row.number}
              row={row}
              issue={live.get(row.number) ?? null}
              view={view}
              actions={actions}
              now={now}
              draggable={false}
            />
          ))}
        </RefLinksExtended>
        <div className="tb-foot" ref={foot}>
          {loading && <span className="tickets-spin" aria-hidden="true" />}
          {columnFoot({ loading, done, empty: rows.length === 0, column, tracking })}
        </div>
      </div>
    </section>
  );
}

/**
 * What the foot of a column says, in each state it has.
 *
 * Three different emptinesses, because they are three different facts — and a column
 * that simply stops reads as one that failed to load, which is the table's `footWords`
 * lesson applied per column.
 */
function columnFoot(state: {
  loading: boolean;
  done: boolean;
  empty: boolean;
  column: BoardColumn;
  tracking: TicketTrackingFilter;
}): string {
  if (state.loading) return '';
  if (!state.empty) return '';
  if (state.column.empty) return 'Nothing has ever been in this state.';
  if (state.tracking === 'live' && state.column.live === 0) {
    return `Nothing under ${state.column.state} is still in the tracker’s open set — widen Tracking to see it.`;
  }
  return 'Nothing here matches these filters.';
}
```

- [ ] **Step 5: Style the board**

In `web/src/styles.css`, add a `/* Tickets — the card view */` block using only `var(--…)` for colour.
The rules that carry behaviour rather than taste:

```css
.tb-cols {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  overflow-x: auto;
}
.tb-col {
  flex: 0 0 300px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--board-col);
  border: 1px solid var(--border);
  border-radius: 6px;
  /* The board is as tall as the situation area and a column scrolls inside it, so a
     column running long never pushes the others off the bottom. */
  max-height: calc(100vh - 320px);
}
.tb-head {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--board-head);
  border-top: 2px solid transparent;
}
.tb-body {
  overflow-y: auto;
  padding: 8px;
}
```

Add the card rules (`.tb-card`, `.tb-stripe`, `.tb-top`, `.tb-id`, `.tb-dot`, `.tb-gap`, `.tb-name`,
`.tb-meta`, `.tb-feat`, `.tb-why`, `.tb-foot`, `.tb-note`, `.tb-unlisted`) in the sheet's existing
voice, reusing `.tickets-sw`, `.tickets-type`, `.tickets-lamp`, `.tickets-gate` and `.f0`–`.fN` rather
than redeclaring them. `.tb-card.frozen` gets `border-style: dashed`.

- [ ] **Step 6: Add the toggle and switch views in the panel**

In `web/src/components/TicketsPanel.tsx`:

Extend `TicketQueryPlace` with the two new fields:

```ts
  /** The table, or the board of state columns. */
  view: 'table' | 'card';
  /** The board columns the operator has hidden. */
  columns: string[];
```

Add the options list beside `GROUP_OPTIONS`:

```ts
const VIEW_OPTIONS: ReadonlyArray<{ value: 'table' | 'card'; label: string; title: string }> = [
  { value: 'table', label: 'Table', title: 'One list, sortable, with a row per item' },
  { value: 'card', label: 'Cards', title: 'A column per tracker state, with the work as cards' },
];

const ORDER_OPTIONS: ReadonlyArray<{ value: TicketOrder; label: string; title: string }> = [
  { value: 'added', label: 'Added', title: 'Newest tracker id first' },
  { value: 'changed', label: 'Changed', title: 'Order by when the tracker last saw it change' },
  { value: 'cost', label: 'Cost', title: 'Order by what the fleet has spent under each ticket' },
];
```

In the rail, after the `Group` segment, add the view toggle. It is **disabled** where the tracker has
no native states, with the reason in the title — a control that vanishes on some deployments is one
nobody can ask about:

```tsx
        <i className="tickets-fdiv" />
        <div className="tickets-fgroup">
          <span className="tickets-flabel" title="How the work is laid out">
            View
          </span>
          <div className="tickets-seg">
            {VIEW_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={option.value === query.view ? 'on' : ''}
                disabled={states.length === 0 && option.value === 'card'}
                aria-pressed={option.value === query.view}
                title={
                  states.length === 0 && option.value === 'card'
                    ? 'This tracker reports no native states, so there are no columns to draw'
                    : option.title
                }
                onClick={() => onQuery(option.value === 'card' ? { view: 'card', state: 'any' } : { view: 'table' })}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
```

Note the `state: 'any'` on the way into card view: `ticketState` stops meaning anything once every
state is a column. Add the notice that says so, beside the existing `tickets-widened` block:

```tsx
{
  query.view === 'card' && clearedState !== '' && (
    <div className="tickets-widened">
      <span>
        Cards draw every state as a column, so the <b>State</b> narrowing to <b>{clearedState}</b> was cleared.
      </span>
      <button type="button" onClick={() => onQuery({ view: 'table', state: clearedState })}>
        Back to the table
      </button>
    </div>
  );
}
```

`clearedState` is a `useState<string>('')` set in the toggle's `onClick` when leaving a narrowed table
for the board, and cleared on the way back. A control silently ignored is worse than one that moved and
said so — which is the argument the `tickets-widened` notice already makes, pointed the other way.

In card view, hide the **Group** segment and render **Order** as a segment instead (the table's sort
lives in column headers the board does not have). Render the `StateTier` in both views, but in card
view have its `onPick` toggle membership of `query.columns` rather than set `query.state` — same chips,
same counts, `aria-pressed` now meaning "this column is drawn".

Finally, swap the body:

```tsx
      {query.view === 'card' ? (
        <TicketsBoard
          query={{ watch: query.watch, tracking: query.tracking, feature: query.feature, order: query.order }}
          facets={states}
          hidden={query.columns}
          view={view}
          actions={actions}
          now={now}
        />
      ) : (
        /* the existing <RefLinksExtended><section className="tickets-card">…</section></RefLinksExtended> block, unchanged */
      )}
```

The intake call-out stays above both — an unclear assay holds work whichever way it is drawn.

- [ ] **Step 7: Pass the fields through `ConsoleRoot`**

In `web/src/console/ConsoleRoot.tsx`, add to the `query` object:

```tsx
            view: view.ticketView,
            columns: view.ticketColumns,
```

and to `onQuery`:

```tsx
              ...(next.view !== undefined ? { ticketView: next.view } : {}),
              ...(next.columns !== undefined ? { ticketColumns: next.columns } : {}),
```

- [ ] **Step 8: Verify it renders**

```bash
npm run typecheck:web && npx tsx --test test/cockpitTheme.test.ts test/appShell.test.ts
```

Then start the preview and look at it: with a `fake` provider the mirror has no native states, so the
Cards button is correctly disabled. To see the board, set `issuePickupStates` and
`issueInProgressState` in a scratch `lubbdubb.config.json` and drive states in through the fake, or use
the demo build (`DEMO`), whose fixtures carry `workItemState`.

Check: columns in the configured order; each column scrolls inside itself while the board scrolls
sideways; a column's header count reads `n of N`; the unlisted foot line appears when a state has no
column; a card's reason lane is never blank; the watch dot toggles and the card's dot follows.

- [ ] **Step 9: Update the spec**

In `docs/spec/17-cockpit.md`, add `### The board, and what a card says` under `## The tickets tab`,
covering: the two views and where the toggle is disabled; where columns come from and the fallback; one
fetch per column and why not one shared list; the per-column scroll and the sticky header; the
always-drawn reason lane and its precedence; the watch dot as the control; the unlisted-states line;
and what the rail does differently in card view, including the cleared `State` narrowing.

- [ ] **Step 10: Run the full check**

```bash
npm run check
```

- [ ] **Step 11: Commit**

```bash
git add web/src/components/TicketCard.tsx web/src/components/TicketsBoard.tsx web/src/components/TicketsPanel.tsx web/src/console/ConsoleRoot.tsx web/src/styles.css web/src/cockpit/tokens.ts docs/spec/17-cockpit.md
git commit -m "Draw the tickets board: a column per state, each scrolling on its own"
```

---

### Task 11: Drag a card to another column

The write, from the board. Every column is a drop target and every header says what dropping there
costs, because the operator is the one deciding and a dead drop target is one nobody can explain.

**Files:**

- Modify: `web/src/api.ts` (~line 276, beside `setIssueWatched`)
- Modify: `web/src/demo/demoBackend.ts` (the server class beside `setIssueWatched` ~line 623, and the `demoApi` object ~line 2772)
- Modify: `web/src/cockpit/actions.ts` (~line 291, beside `setIssueWatched`)
- Modify: `web/src/cockpit/useCockpit.ts` (~line 244, beside `setIssueWatched`)
- Modify: `web/src/components/TicketsBoard.tsx` (drag state, drop targets, header warnings, the optimistic move)
- Modify: `web/src/components/TicketCard.tsx` (act on `draggable`, and draw the in-flight and refused states)
- Modify: `web/src/styles.css` (drag and drop-target rules, using the three `--board-drop-*` tokens from Task 10)
- Docs: `docs/spec/17-cockpit.md` — extend `### The board, and what a card says`

**Interfaces:**

- Consumes: `dropWarning` and `StateRules` (Task 8); `POST /api/issues/:number/state` (Task 5); `view.state.config.canSetWorkItemState` and `.stateRules` (Task 3).
- Produces:

  - `api.setIssueState(issueNumber: number, state: string): Promise<{ ok: true; state: string }>`
  - `CockpitActions.setIssueState(issueNumber: number, state: string): Promise<void>`

- [ ] **Step 1: Add the client call, in all three places it must exist**

`web/src/api.ts` exports `api = DEMO ? demoApi : realApi`, a ternary — so a method on one and not the
other is a `typecheck:web` failure. All three land together.

In `web/src/api.ts`, beside `setIssueWatched`:

```ts
  // Move a work item to one of the tracker's own states — the board's drag. The
  // route validates no state word: the provider owns its process template, and its
  // refusal is what reaches the card.
  setIssueState: (issueNumber: number, state: string) =>
    post<{ ok: true; state: string }>(`/api/issues/${issueNumber}/state`, { state }),
```

In `web/src/demo/demoBackend.ts`, on the demo server class beside its `setIssueWatched`:

```ts
  async setIssueState(issueNumber: number, state: string): Promise<{ ok: true; state: string }> {
    // The demo's board drags for real, because a board that looks draggable and is
    // not is the demo teaching the wrong thing about the product.
    const issue = this.world.issues.find((i) => i.number === issueNumber);
    if (issue) issue.workItemState = state;
    this.touch();
    return { ok: true, state };
  }
```

Use whatever the surrounding methods use to mark the world dirty and re-publish (the demo's own
equivalent of `touch()` — read a neighbouring mutator first and match it).

In the `demoApi` object, beside `setIssueWatched`:

```ts
  setIssueState: (issueNumber: number, state: string) => getServer().setIssueState(issueNumber, state),
```

In `web/src/cockpit/actions.ts`, beside `setIssueWatched`:

```ts
  /**
   * Move a work item to one of the tracker's own states — the board's drag, and the
   * only thing in the cockpit that writes one. Rejects with the provider's own
   * sentence, which the card quotes: a snap-back with no words attached reads as the
   * board being broken.
   */
  setIssueState(issueNumber: number, state: string): Promise<void>;
```

In `web/src/cockpit/useCockpit.ts`, beside its `setIssueWatched` binding:

```ts
      setIssueState: (n, state) => then(api.setIssueState(n, state)),
```

- [ ] **Step 2: Make cards draggable and draw their two write states**

In `web/src/components/TicketCard.tsx`, add three props and act on them:

```tsx
  /** Set while this card's write is in flight, so the card says it is still writing. */
  writing?: string | null;
  /** The provider's own sentence, after a refusal put the card back. */
  refused?: string | null;
  onDragStart?: () => void;
```

Put `onDragStart={onDragStart}` on the `<article>` alongside the existing `draggable`, and below the
reason lane:

```tsx
{
  writing != null && (
    <p className="tb-writing">
      <span className="tickets-spin" aria-hidden="true" />
      writing “{writing}” to the tracker…
    </p>
  );
}
{
  /* Quoted, never paraphrased: it is the only account of why the card came back,
          and a snap-back with no sentence reads as the board being broken. */
}
{
  refused != null && <p className="tb-refused">{refused}</p>;
}
```

- [ ] **Step 3: Drag and drop in the board**

In `web/src/components/TicketsBoard.tsx`:

Hold the drag in the board rather than in a column, because the warnings are about **every** header at
once:

```tsx
const [drag, setDrag] = useState<{ number: number; from: string } | null>(null);
const [writing, setWriting] = useState<{ number: number; state: string } | null>(null);
const [refused, setRefused] = useState<{ number: number; message: string } | null>(null);
```

Pass `drag`, `writing`, `refused`, `setDrag` and an `onDrop` down to each `Column`. The drop handler:

```tsx
const drop = async (column: BoardColumn): Promise<void> => {
  const moving = drag;
  setDrag(null);
  if (moving === null || moving.from === column.state) return;
  // Optimistic, because the write is a round trip to the tracker and a card that
  // sits still for a second reads as a drop that missed. The card is moved and
  // says it is still writing.
  setRefused(null);
  setWriting({ number: moving.number, state: column.state });
  try {
    await actions.setIssueState(moving.number, column.state);
  } catch (err) {
    // Back where it came from, with the provider's own words on it.
    setRefused({ number: moving.number, message: (err as Error).message });
  } finally {
    setWriting(null);
  }
};
```

A column becomes a drop target only where a write is possible at all:

```tsx
const droppable = view.state.config.canSetWorkItemState && drag !== null;
```

and on the column's `<section>`:

```tsx
      onDragOver={(e) => {
        if (droppable) e.preventDefault();
      }}
      onDrop={() => void onDrop(column)}
```

The header speaks the moment a card is lifted:

```tsx
{
  drag !== null && view.state.config.canSetWorkItemState && (
    <span className={`tb-say ${warning.tone}`}>{warning.words}</span>
  );
}
```

with `const warning = dropWarning(column, drag?.from ?? null, view.state.config.stateRules);` computed
in the column. Every header, all at once, so the whole board's consequences are readable before a
choice is made rather than after it — the habit `stateWhy` and `cascadeNote` already keep.

Each column shows the moving card in its own list while the write is in flight: filter the moving
number out of its origin column's rows and append it to the target's, keyed off `writing`. Pass
`writing={writing?.number === row.number ? writing.state : null}` and
`refused={refused?.number === row.number ? refused.message : null}` into `TicketCard`, and
`onDragStart={() => setDrag({ number: row.number, from: column.state })}`.

Where the provider cannot write states, `draggable` stays `false` on every card and the note added in
Task 10 is the whole explanation.

- [ ] **Step 4: Style the drag**

In `web/src/styles.css`, add rules using the three tokens from Task 10 — nothing new to register:

```css
.tb-say.ok {
  color: var(--board-drop-ok);
}
.tb-say.warn {
  color: var(--board-drop-warn);
}
.tb-say.stop {
  color: var(--board-drop-stop);
}
.tb-col.target {
  border-color: var(--board-drop-ok);
}
.tb-card[draggable='true'] {
  cursor: grab;
}
.tb-card.writing {
  opacity: 0.6;
}
.tb-card.refused {
  border-color: var(--board-drop-stop);
}
```

- [ ] **Step 5: Verify the whole path**

```bash
npm run typecheck:web && npx tsx --test test/cockpitTheme.test.ts test/issueState.test.ts
```

Then drive it in the preview, against a config with `issuePickupStates`, `issueInProgressState` and
`issueInReviewState` set. Check every one of these, because each is a decision this plan made:

- Lifting a card makes **every** header speak, and the in-progress column says _pickup_, not _stops_.
- The review column names where it would come back to and states it as a condition.
- A column with nothing live says so and claims nothing about closing.
- The card moves on release, says it is writing, then settles.
- A refusal returns the card and quotes the provider — force one by pointing the config at a state the
  process template rejects.
- With a `github` provider, no card is draggable and the note above the columns says why.

- [ ] **Step 6: Update the spec**

Extend `### The board, and what a card says` in `docs/spec/17-cockpit.md` with the drag: that every
column is a target and why a dead target was rejected; that the headers all speak at once; the three
wordings and what each is quoting; the optimistic move and the quoted refusal; and that a provider
without the capability turns the whole affordance off with one sentence rather than five failures.

- [ ] **Step 7: Run the full check**

```bash
npm run check
```

- [ ] **Step 8: Commit**

```bash
git add web/src/api.ts web/src/demo/demoBackend.ts web/src/cockpit/actions.ts web/src/cockpit/useCockpit.ts web/src/components/TicketsBoard.tsx web/src/components/TicketCard.tsx web/src/styles.css docs/spec/17-cockpit.md
git commit -m "Drag a card between columns, and say what the drop costs before it lands"
```

---

## Self-Review

**Spec coverage** — every section of the design doc maps to a task:

| Spec section                            | Task                                                                                                                                                                        |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §1 The two views and the toggle         | 9 (Place), 10 (toggle, disabled arm)                                                                                                                                        |
| §2 Where the columns come from          | 2 (config key), 6 (`boardColumns`, fallback, empty column, unlisted)                                                                                                        |
| §3 Loading                              | 10 (one fetch per column, own observer, header counts, three empty states)                                                                                                  |
| §4 The card                             | 7 (`cardReason`), 10 (markup, watch dot)                                                                                                                                    |
| §5 Dragging and the write               | 3 (capability + rules), 4 (store patches), 5 (route), 8 (`dropWarning`), 11 (the drag)                                                                                      |
| §5 "One existing inaccuracy this fixes" | 1                                                                                                                                                                           |
| §6 The filter rail in card view         | 9 (`ticketColumns`), 10 (Group hidden, Order segment, State→columns, cleared narrowing)                                                                                     |
| §7 Styling                              | 10 (tokens as mixes, registry)                                                                                                                                              |
| §8 Testing                              | every task's own steps                                                                                                                                                      |
| §9 Specs to update                      | 1, 2, 3, 4, 5, 9, 10, 11 — folded into each task's commit, per the repo's rule                                                                                              |
| §10 Files this touches                  | covered, plus three the spec missed: `src/sink/actionSink.ts` + both connectors (Task 3), `web/src/demo/demoBackend.ts` (Task 11), `docs/spec/04-harness-cycle.md` (Task 4) |

**Two refinements the plan makes to the spec**, both from reading the code:

1. **`canSetWorkItemState` is a connector method, not `isWorkItemStateCapable(connector)`.** That
   predicate tests an _integration_; the route holds a connector, whose `setWorkItemState` throws when
   nothing implements it. Task 3 adds the predicate at the seam that can answer it. Called out in the
   task.
2. **`boardColumns` takes the effective pickup list rather than reading `facet.pickup`.** A configured
   column the mirror has nothing in has no facet, so it would have no answer — and preferring the facet
   where one exists and the list where it does not is two answers to the question that decides whether
   a header warns the fleet will stop. One list, every column. Both come from `effectivePickupStates`
   after Task 1, so they cannot disagree.

**Placeholder scan:** no TBDs, no "add error handling", no "similar to Task N", no "write tests for the
above". One place names a judgement rather than a literal, deliberately, because the answer is in a
file the executor must read: the demo's own world-dirty call in Task 11 Step 1. It says to read a
neighbouring mutator and match it, and `typecheck:web` catches getting it wrong.

**One dependency worth stating**, since Task 11's drop handler relies on it: `useCockpit`'s `then`
helper is `p => p.then(() => refresh())` — it does not catch, so `actions.setIssueState` rejects to
the caller and the `try`/`catch` around it receives the provider's sentence. `AsyncButton` is the
component that swallows a rejection into its own `title`; the watch dot in Task 10 uses it deliberately,
and the drop handler deliberately does not.

**Type consistency:** `BoardColumn`, `CardReasonTone`, `DropTone`, `StateRules`, `BoardQuery`,
`boardColumns`, `cardReason`, `dropWarning`, `patchWorldState`, `patchTicketState`,
`canSetWorkItemState`, `setIssueState`, `boardStates`, `stateRules`, `ticketView`, `ticketColumns` —
each is spelled the same in the task that defines it and every task that consumes it. `StateRules` is
declared in `web/src/ticketBoard.ts` and structurally matches `CockpitConfig['stateRules']`
non-null, so Task 11 passes the wire value straight in.
