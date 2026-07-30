# Factory Floor — Factorio pass, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-render the `factory` cockpit skin in Factorio's vocabulary of signs — status lamps, an Alt overlay, belt tiers, iconised PR conditions, a cool-shifted palette — without changing a single verdict it draws.

**Architecture:** Presentation only, inside `web/src/skins/factory/**` plus that skin's token block in `skin.css`. Every state already arrives as `MachineStatus { word, tone }` or as a server-computed verdict (`attention`, `health`, `QueueItem.status`); each task adds a second _renderer_ of an existing value and never a second _source_ of one. Pure functions go in the skin's `.ts` modules and are unit-tested directly; render changes are asserted structurally against `renderToStaticMarkup`.

**Tech Stack:** React 19 (SSR via `react-dom/server` in tests), TypeScript ESM with explicit `.js` import extensions, `node:test` + `tsx`, plain CSS custom properties.

**Spec:** [`docs/superpowers/specs/2026-07-31-factory-skin-factorio-pass-design.md`](../specs/2026-07-31-factory-skin-factorio-pass-design.md)

## Global Constraints

- **Presentation only.** No change to a dispatcher rule, a store schema, an API payload, or `/api/state`'s shape. No new snapshot key.
- **No shared-component CSS.** A skin tints shared components through the token block and never targets `.escalation-card` and friends by class.
- **`test/fixtures/classic-markup.html` is a byte-exact golden and must not move.** If `npm run check` reports it changed, the edit leaked out of the factory skin and is wrong.
- **`test/fixtures/` is in `.prettierignore`.** Never run a bare `npx prettier --write test/`.
- **ESM with explicit `.js` extensions**, even from `.ts` sources: `import { toneColor } from '../vocabulary.js';`
- **Comments explain _why_, not _what_.** Match the existing terse, high-signal style in these files.
- **knip runs with every rule at `error`.** An export nothing imports fails the build; the usual fix is to drop the `export` keyword, not delete the code.
- **Verify with `npm run check`** (format:check, lint, typecheck, typecheck:web, knip, test) at the end of every task. All six stages run even when one fails.
- **Two typecheckers.** These changes are all under `web/`, so `typecheck:web` is the one that matters, but `npm run check` runs both.
- Add new tests to `test/factorySkin.test.ts`. Don't edit unrelated test files.

---

### Task 1: Cool-shift the palette

The ground the rest is judged against, and the only task that touches shared components — through the token block, which is their styling contract.

**Files:**
- Modify: `web/src/skins/factory/skin.css:20-72` (the `:root[data-skin='factory']` token block)
- Test: manual visual check; no assertion (a token value is not a behaviour)

**Interfaces:**
- Consumes: nothing.
- Produces: the token values every later task's colours sit on. No TypeScript surface.

- [ ] **Step 1: Shift the ground tokens from warm brown to cool slate**

In `skin.css`, replace these seven values inside `:root[data-skin='factory']`. Leave `--accent`, `--green`, `--blue`, `--amber`, `--red` and every `*-fill` / `*-line` token exactly as they are — the accent is meant to be the only warm thing in the frame, and shifting it is the mistake this change exists to avoid.

```css
  --bg: #191b1c;
  --panel: #313436;
  --panel-2: #292c2e;
  --border: #3d4144;
  --text: #e9e7e1;
  --muted: #9a9a95;
  --grey: #6a6d6f;
```

And the two bevel tokens plus the well, twenty lines below:

```css
  --well: #16181a;
  --border-hi: #474b4e;
  --border-lo: #0f1112;
```

- [ ] **Step 2: Re-check the two greys against the new ground**

`--muted` and `--grey` were picked against a warm panel and a cooler ground is usually darker in perceived value. Open the cockpit (`npm run web:build` is not needed for a dev check — `npm start` and the Vite dev server serve it) and confirm `--muted` body text on `--panel` is still comfortably legible. If it is not, lighten `--muted` one step at a time; do not darken the panel back.

- [ ] **Step 3: Check the four shared panels the token block tints**

Per `skin.css`'s own header these are the shared components' only styling contract, so they change with it and are where a bad value shows first. Open each and confirm nothing has gone muddy or lost its border:

- the agent drawer (click a bot card)
- an escalation card (the stamp desk)
- the recovery panel (only visible with crashed agents — check the demo state, which seeds them)
- the plan modal (open a plan from the Goal Floor)

- [ ] **Step 4: Run the full check**

Run: `npm run check`
Expected: PASS, and in particular `test/cockpitSkins.test.ts` passes — the classic golden must be untouched.

- [ ] **Step 5: Commit**

```bash
git add web/src/skins/factory/skin.css
git commit -m "Factory skin: cool-shift the ground so the accent is the only warm thing"
```

---

### Task 2: Decouple the row stripe from the court tone

**Do this before Task 3.** `Row` in `Inspection.tsx` currently reads a _colour_ to answer "is this row yours" — `court.tone === 'bad'`. Task 3 changes that colour, and without this task every your-call row silently loses its stripe. Fixing it is a strict improvement on its own: a row's severity should not be inferred from what colour something else happens to be.

**Files:**
- Modify: `web/src/skins/factory/components/Inspection.tsx` (the `tone` const inside `Row`)
- Test: `test/factorySkin.test.ts`

**Interfaces:**
- Consumes: `rackGroup(pr): 'yours' | 'in_hand'` and `prCourt(pr): { label, tone }`, both already exported from `web/src/skins/factory/inspection.js`.
- Produces: a `Row` whose stripe class is independent of `prCourt`'s tone, which Task 3 relies on.

- [ ] **Step 1: Write the failing test**

Add to `test/factorySkin.test.ts`. Put it next to the other rack tests (search for `prCourt` to find them).

```ts
/**
 * The stripe answers "is this yours", and `rackGroup` is the function that answers
 * that. Deriving it from `court.tone` instead made the severity of a row depend on
 * the colour of a chip — so a palette change could silently un-stripe every row
 * needing a decision. This asserts the independence directly.
 */
test('a row stripe survives the court chip changing colour', () => {
  // Only `id`, `number`, `title`, `branch`, `ciStatus` and `unresolvedComments` are
  // required on `PullRequest` — everything else is optional, so the fixture stays
  // the size of what the assertion is actually about.
  const pr = (over: Partial<PullRequest>): PullRequest => ({
    id: 'pr-7',
    number: 7,
    title: 'A pull request',
    branch: 'issue/7',
    ciStatus: 'passing',
    unresolvedComments: [],
    labels: [],
    merged: false,
    approved: true,
    mergeable: true,
    mergeableState: 'clean',
    attention: { status: 'you', reasons: ['a merge is proposed'] },
    ...over,
  });

  const markup = renderRack([pr({})]);
  assert.match(markup, /fx-part[^"]*\byou\b/, 'a `you` row must carry the you stripe');

  const stalled = renderRack([pr({ attention: { status: 'stalled', reasons: ['attempts spent'] } })]);
  assert.match(stalled, /fx-part[^"]*\bstalled\b/, 'a `stalled` row must carry the stalled stripe');

  const handled = renderRack([pr({ attention: { status: 'harness', reasons: ['an agent has it'] } })]);
  assert.ok(
    !/fx-part[^"]*\byou\b/.test(handled),
    'a row the harness is working is not yours and carries no you stripe',
  );
});
```

Add this helper beside `renderDesk` in the same file, so the rack can be rendered without the whole cockpit around it:

```ts
/** The rack alone, for assertions about one row's markup. */
function renderRack(prs: PullRequest[]): string {
  return renderToStaticMarkup(
    createElement(Inspection, {
      prs,
      closed: [],
      refUrls: {},
      ignoreLabel: 'lubbdubb-ignore',
      onToggleExclude: () => Promise.resolve(),
    }),
  );
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test test/factorySkin.test.ts`
Expected: the third assertion currently PASSES and the first two also pass — this test documents behaviour that is correct _today_ and is about to become fragile. If all three pass, that is the expected starting state: it is a regression guard, not a red test. Confirm it passes now, so a failure in Task 3 means Task 3 broke it.

- [ ] **Step 3: Move the stripe onto `rackGroup`**

In `Inspection.tsx`, replace the `tone` const inside `Row`:

```tsx
  // The stripe is the row's own severity, and it is read from the group — the
  // function that already answers "is this yours" — never from the court chip's
  // colour. Inferring it from a tone made a palette change able to un-stripe every
  // row needing a decision.
  const tone = inHand ? '' : pr.attention?.status === 'stalled' ? ' stalled' : ' you';
```

`inHand` is already `rackGroup(pr) === 'in_hand'` at the call site, so the two cannot disagree.

- [ ] **Step 4: Run the tests**

Run: `npx tsx --test test/factorySkin.test.ts`
Expected: PASS, all three assertions.

- [ ] **Step 5: Run the full check and commit**

Run: `npm run check`

```bash
git add web/src/skins/factory/components/Inspection.tsx test/factorySkin.test.ts
git commit -m "Factory skin: read the PR row stripe from the group, not the chip colour"
```

---

### Task 3: The lamp primitive, and demote the caption

The largest read change. A lamp is a second renderer of `MachineStatus.tone`, which every machine on the floor already carries.

**Files:**
- Modify: `web/src/skins/factory/components/Sprite.tsx` (add `Lamp` beside `Icon`)
- Modify: `web/src/skins/factory/skin.css` (add `.fx-lamp`, demote the caption class)
- Modify: `web/src/skins/factory/components/TheLine.tsx` (bays and crates)
- Modify: `web/src/skins/factory/components/GoalFloor.tsx` (machines)
- Modify: `web/src/skins/factory/inspection.ts` (`prCourt`'s `you` tone)
- Test: `test/factorySkin.test.ts`

**Interfaces:**
- Consumes: `StatusTone` and `toneColor(tone: StatusTone): string` from `../vocabulary.js`.
- Produces: `Lamp({ tone }: { tone: StatusTone }): JSX.Element`, exported from `components/Sprite.js`. Later tasks do not depend on it.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * A lamp is a second *renderer* of a tone, never a second source of one — so its
 * colour is `toneColor`'s value and nothing else. A hard-coded hex here would be a
 * bay and a silo able to disagree about what "warn" looks like, which is the exact
 * drift `toneColor` was written to prevent.
 */
test('a lamp takes its colour from toneColor and never restates it', () => {
  const markup = render();
  assert.match(markup, /class="fx-lamp"/, 'the floor must draw lamps');

  const lamps = markup.match(/<i class="fx-lamp"[^>]*>/g) ?? [];
  assert.ok(lamps.length > 0, 'expected at least one lamp on the demo floor');
  for (const lamp of lamps) {
    assert.ok(
      !/#[0-9a-f]{3,6}/i.test(lamp),
      `a lamp must carry a var() from toneColor, not a literal colour: ${lamp}`,
    );
    assert.match(lamp, /color:\s*var\(--/, `a lamp must be coloured through a token: ${lamp}`);
  }
});

/**
 * The lamp is additive. The word stays in the markup because it is the reading that
 * survives a colourblind operator, `prefers-contrast`, and a screen reader — the
 * lamp is decoration over it, not a replacement for it.
 */
test('a lamp never replaces the word beside it', () => {
  const markup = render();
  for (const word of ['Working', 'Awaiting an item']) {
    assert.ok(markup.includes(word), `the demo floor should still say "${word}" in words`);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test test/factorySkin.test.ts`
Expected: FAIL on the first test — `the floor must draw lamps`.

- [ ] **Step 3: Add the `Lamp` component**

In `components/Sprite.tsx`, below `Icon`:

```tsx
/**
 * An entity's status lamp — the indicator the game puts on the lower-left of every
 * machine.
 *
 * The colour is `toneColor`'s value set as `color`, so the fill and the glow are one
 * token and the lamp cannot drift from the caption it sits beside. `aria-hidden`
 * because the word carries the accessible reading; a lamp announcing "green" would
 * say the same thing twice and less clearly.
 */
export function Lamp({ tone }: { tone: StatusTone }): JSX.Element {
  return <i className="fx-lamp" data-tone={tone} style={{ color: toneColor(tone) }} aria-hidden="true" />;
}
```

and at the top of the file:

```tsx
import { toneColor, type StatusTone } from '../vocabulary.js';
```

- [ ] **Step 4: Style the lamp and demote the caption**

In `skin.css`, near the other small primitives:

```css
/* The lamp: fill and glow both `currentColor`, which is `toneColor`'s token, so
   there is one value behind both and no second mapping to keep in step. */
.fx-lamp {
  display: inline-block;
  flex: none;
  width: 9px;
  height: 9px;
  background: currentColor;
  border: 1px solid rgba(0, 0, 0, 0.55);
  box-shadow: 0 0 7px currentColor;
}
/* An unlit machine glows at nothing. Without this an `off` lamp haloes grey, which
   reads as a machine doing something quietly rather than one that is not running. */
.fx-lamp[data-tone='off'],
.fx-lamp[data-tone='ghost'] {
  box-shadow: none;
}
```

Then find the class that renders `MachineStatus.word` on the bays and machines (search `skin.css` for the rule carrying the machine caption — it sits with the other `.fx-` machine rules) and demote it: drop its `font-size` to `9.5px` and add `opacity: 0.78`. Do not remove it and do not change its `text-transform`.

- [ ] **Step 5: Render lamps beside each caption**

In `TheLine.tsx`, the bay and crate captions already render `bayMachineStatus(...)` / `crateMachineStatus(...)`. Put a `Lamp` immediately before the word in each, passing the same status object's `tone`:

```tsx
<Lamp tone={status.tone} />
```

Do the same in `GoalFloor.tsx` for each machine's status caption. Import `Lamp` from `./Sprite.js` in both. Do not compute a tone anywhere — pass through the one the status object already carries.

- [ ] **Step 6: Change `prCourt`'s `you` tone**

In `inspection.ts`, in `prCourt`:

```ts
    case 'you':
      // `next`, not `bad`: red is the fault colour everywhere else on the floor, and
      // "the harness is asking you a question" is not a fault. The row's stripe reads
      // `rackGroup`, so this no longer decides severity — see `Row`.
      return { label: 'Your call', tone: 'next' };
```

- [ ] **Step 7: Run the tests**

Run: `npx tsx --test test/factorySkin.test.ts`
Expected: PASS — including Task 2's stripe test, which is what proves the tone change did not un-stripe anything.

- [ ] **Step 8: Run the full check and commit**

Run: `npm run check`

```bash
git add web/src/skins/factory test/factorySkin.test.ts
git commit -m "Factory skin: status lamps off the existing tone, captions demoted"
```

---

### Task 4: Gauges recede further at zero

**Files:**
- Modify: `web/src/skins/factory/components/StatusBar.tsx` (`ActRead`)
- Test: `test/factorySkin.test.ts`

**Interfaces:**
- Consumes: `ActRead`'s existing `{ icon, label, count, tone, title, onOpen }` props. No signature change.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * A zero gauge keeps its label and its way in — `every desk has a way in from the
 * status bar` is asserted elsewhere and hiding a quiet gauge would break it — but it
 * stops carrying a `0`. Four labels each with a zero on them is the band this
 * removes; four labels alone is not.
 */
test('a quiet gauge drops its count, not its way in', () => {
  const markup = render((s) => {
    s.escalations = [];
    s.findings = [];
  });
  const quiet = markup.match(/<button[^>]*fx-act quiet[^>]*>.*?<\/button>/gs) ?? [];
  assert.ok(quiet.length > 0, 'a demo state with nothing outstanding should have quiet gauges');
  for (const gauge of quiet) {
    assert.ok(!/>0</.test(gauge), `a quiet gauge should not draw its zero: ${gauge}`);
    assert.match(gauge, /fx-lbl/, `a quiet gauge keeps its label: ${gauge}`);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test test/factorySkin.test.ts`
Expected: FAIL — `a quiet gauge should not draw its zero`.

- [ ] **Step 3: Omit the count when unlit**

In `StatusBar.tsx`, in `ActRead`, replace the value span:

```tsx
      {/* Unlit draws no number at all. Dimming a `0` still spends a digit's worth of
          attention on "nothing is wrong", four times over; the label alone says it. */}
      {lit && <span className={`fx-val ${tone ?? ''}`}>{count}</span>}
```

- [ ] **Step 4: Give the escalations gauge the accent when lit**

Find where `ActRead` is called for escalations (the stamp desk) and confirm its `tone` prop. It should be `'crit'`, which is red. Leave `crit` alone — an agent parked on a question is genuinely red — and make no change here if that is what it passes. This step is a check, not an edit: §6's "the one gauge that means _you_ is warm" is satisfied by Task 3's `prCourt` change on the PR rack, and a second warm surface in the status bar would compete with the red that means an agent is _blocked_.

- [ ] **Step 5: Run the tests**

Run: `npx tsx --test test/factorySkin.test.ts`
Expected: PASS, including the existing `every desk has a way in from the status bar`.

- [ ] **Step 6: Run the full check and commit**

Run: `npm run check`

```bash
git add web/src/skins/factory/components/StatusBar.tsx test/factorySkin.test.ts
git commit -m "Factory skin: a quiet gauge drops its zero and keeps its label"
```

---

### Task 5: Belt tiers, and an empty belt that collapses

**Files:**
- Create: nothing
- Modify: `web/src/skins/factory/production.ts` (add `beltTier`)
- Modify: `web/src/skins/factory/components/TheLine.tsx` (apply the tier class, the empty class)
- Modify: `web/src/skins/factory/skin.css` (tier tokens, the collapsed rail)
- Test: `test/factorySkin.test.ts`

**Interfaces:**
- Consumes: `QueueItem[]` and the cap, both already in `TheLine`'s props.
- Produces: `beltTier(queued: number, cap: number): 'yellow' | 'red' | 'blue'`, exported from `web/src/skins/factory/production.js`.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * The tiers are the game's speed hierarchy read as queue pressure, and the
 * thresholds are against the cap rather than absolute — four items behind a cap of
 * two is congestion, behind a cap of eight it is not.
 */
test('the belt tiers up as the queue outruns the cap', () => {
  assert.equal(beltTier(0, 4), 'yellow');
  assert.equal(beltTier(4, 4), 'yellow', 'a queue the fleet could take in one pulse is not backed up');
  assert.equal(beltTier(5, 4), 'red');
  assert.equal(beltTier(8, 4), 'red');
  assert.equal(beltTier(9, 4), 'blue');
  assert.equal(beltTier(3, 1), 'blue', 'a small cap saturates sooner');
});

/**
 * An empty belt is still and dark. `stopped` and `clear` are different conditions
 * and must stay separable: a paused belt with items on it is full height and
 * stopped, which is what the existing pulse assertion protects.
 */
test('an empty belt collapses and a stopped one does not', () => {
  // `UpcomingPlan` is `{ cycleId, at, items }` — `at` is when the ranked world was
  // observed and is required.
  const empty = render((s) => (s.upcoming = { cycleId: 'c', at: NOW, items: [] }));
  assert.match(empty, /fx-belt[^"]*\bclear\b/, 'an empty belt must collapse');

  const pausedWithWork = render((s) => {
    s.control.paused = true;
  });
  assert.match(pausedWithWork, /fx-belt[^"]*\bstopped\b/, 'a paused belt is still stopped');
});
```

Add `beltTier` to the `production.js` import list at the top of the test file, beside `axisScale` and `productionReading`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test test/factorySkin.test.ts`
Expected: FAIL — `beltTier is not a function`.

- [ ] **Step 3: Add `beltTier`**

In `production.ts`:

```ts
/**
 * The belt's tier, read as queue pressure against the cap.
 *
 * Against the cap rather than an absolute count: four items behind a cap of two is
 * congestion and behind a cap of eight is a normal cycle, so an absolute threshold
 * would call a healthy fleet saturated. Yellow up to one full pulse of work, red to
 * two, blue past that — the game's own hierarchy, so a player reads it with no
 * legend.
 *
 * A cap of zero is a paused-to-nothing fleet, where any queued item is saturation.
 */
export function beltTier(queued: number, cap: number): 'yellow' | 'red' | 'blue' {
  if (queued === 0) return 'yellow';
  if (cap <= 0) return 'blue';
  if (queued <= cap) return 'yellow';
  if (queued <= cap * 2) return 'red';
  return 'blue';
}
```

- [ ] **Step 4: Apply the tier and the clear state**

In `TheLine.tsx`, find where the belt's className is built (search for `fx-belt`) and add both classes. The `stopped` class is already there — keep it exactly as it is:

```tsx
const tier = beltTier(items.length, cap);
// `clear` and `stopped` are different conditions: a paused belt carrying items is
// stopped and full height. Both classes can be on at once.
const beltClass = `fx-belt ${stopped ? 'stopped' : ''} ${items.length === 0 ? 'clear' : ''} ${tier}`;
```

Import it: `import { beltTier } from '../production.js';`

- [ ] **Step 5: Add the tier tokens and the collapsed rail**

In `skin.css`, beside the existing `--fx-belt` declaration, add the two other tiers as tokens and switch `--fx-belt` per class:

```css
/* The other two belt tiers. One token drives the chevrons (see the mask note
   above), so tiering is a token swap and no belt markup changes. */
:root[data-skin='factory'] {
  --fx-belt-red: #d0523f;
  --fx-belt-blue: #4f8bc9;
}
.fx-belt.red {
  --fx-belt: var(--fx-belt-red);
}
.fx-belt.blue {
  --fx-belt: var(--fx-belt-blue);
}
/* An empty belt is still and dark, and takes a rail's worth of height rather than a
   belt's. The floor should be small when the factory is idle — a full-width lit belt
   carrying nothing is the loudest object on screen saying the least. */
.fx-belt.clear {
  height: 22px;
}
.fx-belt.clear::before {
  animation-play-state: paused;
  opacity: 0.1;
}
```

Check the existing `.fx-belt` rule for how its height is set; if it is set by a variable or by content, adapt the `height` above to match that mechanism rather than fighting it.

- [ ] **Step 6: Run the tests**

Run: `npx tsx --test test/factorySkin.test.ts`
Expected: PASS, including the existing `the belt stops when the harness will not pulse` and `the belt carries the dispatcher plan`.

- [ ] **Step 7: Run the full check and commit**

Run: `npm run check`

```bash
git add web/src/skins/factory test/factorySkin.test.ts
git commit -m "Factory skin: belt tiers off queue pressure, and a clear belt collapses"
```

---

### Task 6: Iconise the PR row's reason column

**No new column.** `.fx-part` is already `3px 132px 46px minmax(0, 1fr) minmax(0, 34ch) 152px 58px` and `fx-part-why` already carries `rackReason(pr)` — the server's own words. Adding a marks column would put a second statement of the blocking condition beside the first.

**Files:**
- Modify: `web/src/skins/factory/inspection.ts` (add `conditionGlyph`)
- Modify: `web/src/skins/factory/components/Inspection.tsx` (render the glyph in `fx-part-why`)
- Modify: `web/src/skins/factory/skin.css` (glyph sizing inside the why cell)
- Test: `test/factorySkin.test.ts`

**Interfaces:**
- Consumes: `rackReason(pr): string` from `../inspection.js`; `Icon` and `IconName` from `./Sprite.js`.
- Produces: `conditionGlyph(reason: string): IconName | null`, exported from `web/src/skins/factory/inspection.js`.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * The glyph is chosen from the reason the server already wrote, and an unrecognised
 * reason gets **no** glyph rather than a default one. A fallback icon would put a
 * confident wrong picture on a condition nobody classified — the row's own sentence
 * is the honest answer there.
 */
test('a condition glyph is recognised or absent, never guessed', () => {
  assert.equal(conditionGlyph('CI failing on base PR #7'), 'alert');
  assert.equal(conditionGlyph('3 unresolved comments'), 'signal');
  assert.equal(conditionGlyph('behind base by 18 commits'), 'belt');
  assert.equal(conditionGlyph('a merge is proposed'), 'blueprint');
  assert.equal(conditionGlyph('something nobody has classified'), null);
  assert.equal(conditionGlyph(''), null);
});

/**
 * Iconising the why cell must not add or remove a grid cell — the row's tracks are
 * fixed and every column past the title lines up down the rack, which is the whole
 * reason the strip can be read downward.
 */
test('a glyph does not change the row grid', () => {
  const withGlyph = renderRack([
    {
      id: 'pr-7',
      number: 7,
      title: 'A pull request',
      branch: 'issue/7',
      ciStatus: 'failing',
      unresolvedComments: [],
      labels: [],
      merged: false,
      approved: false,
      mergeable: true,
      mergeableState: 'clean',
      attention: { status: 'harness', reasons: ['CI failing on base PR #7'] },
    },
  ]);
  assert.match(withGlyph, /fx-part-why/, 'the why cell must still exist');
  assert.match(withGlyph, /fx-part-why[^>]*>\s*<svg/, 'the why cell leads with its glyph');
});
```

Add `conditionGlyph` to the `inspection.js` import list at the top of the test file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test test/factorySkin.test.ts`
Expected: FAIL — `conditionGlyph is not a function`.

- [ ] **Step 3: Add `conditionGlyph`**

In `inspection.ts`:

```ts
/**
 * The game's status glyph for a reason the server wrote.
 *
 * Matched on the reason text, which is the only structure there is — `attention`
 * ships prose, and re-deriving the condition from the PR here would be a second
 * opinion sitting nowhere near the verdict that formed it.
 *
 * An unrecognised reason returns null and the cell draws its sentence alone. A
 * fallback glyph would put a confident picture on a condition nobody classified,
 * which is worse than no picture — the same rule `prState` follows in never
 * inventing `closed`.
 */
export function conditionGlyph(reason: string): IconName | null {
  const r = reason.toLowerCase();
  if (r.includes('ci ') || r.includes('check')) return 'alert';
  if (r.includes('comment')) return 'signal';
  if (r.includes('behind') || r.includes('conflict')) return 'belt';
  if (r.includes('propos') || r.includes('approv')) return 'blueprint';
  if (r.includes('agent')) return 'bot';
  return null;
}
```

Import the type: `import type { IconName } from './components/Sprite.js';`

- [ ] **Step 4: Render the glyph in the why cell**

In `Inspection.tsx`, inside `Row`, replace the why span:

```tsx
      {/* The glyph leads the sentence the server wrote; the sentence is unchanged and
          still the full reading, in the `title` when the 34ch track truncates it. The
          cap here is the track, not a count — a row with four conditions shows what
          fits, exactly as it does today. */}
      <span className="fx-part-why" title={reason}>
        {glyph && <Icon name={glyph} className="sm" />}
        {reason}
      </span>
```

and above the return:

```tsx
  const glyph = conditionGlyph(reason);
```

Import `Icon` from `./Sprite.js` and `conditionGlyph` from `../inspection.js`.

- [ ] **Step 5: Size the glyph inside the cell**

In `skin.css`, beside the `.fx-part-why` rule:

```css
/* The glyph sits on the sentence's baseline and never pushes it: the cell is a
   fixed 34ch and the text is what may truncate, not the icon. */
.fx-part-why {
  display: flex;
  align-items: center;
  gap: 6px;
}
.fx-part-why > .fx-ic {
  flex: none;
  opacity: 0.8;
}
```

Confirm the existing `.fx-part-why` rule's `overflow`/`text-overflow` still applies to the text — if it was set on the span itself, move it to a wrapping span around `{reason}` so the ellipsis still lands on the sentence.

- [ ] **Step 6: Run the tests**

Run: `npx tsx --test test/factorySkin.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the full check and commit**

Run: `npm run check`

```bash
git add web/src/skins/factory test/factorySkin.test.ts
git commit -m "Factory skin: the PR row's reason leads with the game's status glyph"
```

---

### Task 7: Alt mode

Last of the substantive steps: it takes inline detail away, so it lands only once everything it hides has a lamp carrying its state.

**Files:**
- Create: `web/src/skins/factory/components/AltMode.tsx`
- Modify: `web/src/skins/factory/FactoryRoot.tsx` (mount the hook, render the badge)
- Modify: `web/src/skins/factory/components/TheLine.tsx` (wrap the bay/crate refs)
- Modify: `web/src/skins/factory/skin.css` (the overlay rules)
- Test: `test/factorySkin.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `useAltMode(): boolean` and `AltTag({ children }: { children: React.ReactNode }): JSX.Element`, both exported from `components/AltMode.js`.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * The overlay is a *display* switch over values the row already holds. Asserting it
 * adds no text is what stops it becoming a second source that can disagree with the
 * row it sits on — the drift `prAttention.ts` was split out to prevent, in markup.
 *
 * `renderToStaticMarkup` cannot press a key, so this asserts the property that
 * matters and can be checked statically: the tag's contents are already in the DOM.
 */
test('the alt overlay restates the floor and adds nothing to it', () => {
  const markup = render();
  const tags = markup.match(/<span class="fx-alt-tag">(.*?)<\/span>/gs) ?? [];
  assert.ok(tags.length > 0, 'the floor must carry alt tags');
  for (const tag of tags) {
    const text = tag.replace(/<[^>]+>/g, '').trim();
    assert.ok(text.length > 0, 'an alt tag must say something');
    const rest = markup.replace(tag, '');
    assert.ok(
      text.split(' · ').every((part) => rest.includes(part.trim())),
      `an alt tag must restate what the floor already holds, not add to it: ${text}`,
    );
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test test/factorySkin.test.ts`
Expected: FAIL — `the floor must carry alt tags`.

- [ ] **Step 3: Add the hook and the tag**

Create `web/src/skins/factory/components/AltMode.tsx`:

```tsx
import { useEffect, useState, type JSX, type ReactNode } from 'react';

/**
 * Alt-mode: the game's overlay, which shows a machine's recipe while the key is
 * held. Here it shows a bay's origin, branch and rule — the detail the floor used to
 * carry inline, which is what let the captions be demoted rather than deleted.
 *
 * **Held, not toggled**, matching the game. `preventDefault` because a bare Alt
 * focuses the browser's menu bar on Windows and Linux and the keyup never arrives;
 * `blur` clears it because a window that loses focus mid-hold would otherwise come
 * back with the overlay stuck on and no key to release.
 */
export function useAltMode(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key !== 'Alt') return;
      e.preventDefault();
      setHeld(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Alt') setHeld(false);
    };
    const clear = () => setHeld(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', clear);
    };
  }, []);
  return held;
}

/**
 * One entity's overlay tag. Always rendered, shown by a body-level class — see the
 * cascade note on `.fx-alt-tag` in `skin.css`.
 */
export function AltTag({ children }: { children: ReactNode }): JSX.Element {
  return <span className="fx-alt-tag">{children}</span>;
}
```

- [ ] **Step 4: Style the overlay, minding the cascade**

In `skin.css`:

```css
/* Declared BEFORE the rule that shows it, and switched on only by the body class.
   `.fx-alt-tag` and any `display` rule for it are both single-class selectors, so
   source order alone decides which wins — declared the other way round the overlay
   is permanently open, which is how this was found. */
.fx-alt-tag {
  position: absolute;
  left: 0;
  right: 0;
  top: -21px;
  display: none;
  justify-content: center;
  pointer-events: none;
  z-index: 4;
  font-family: var(--font-mono);
  font-size: 9.5px;
  color: var(--fx-ghost);
}
.fx-alt-tag > span {
  background: rgba(12, 14, 15, 0.94);
  border: 1px solid var(--border);
  padding: 2px 6px;
  white-space: nowrap;
}
body.fx-alt .fx-alt-tag {
  display: flex;
}
/* The belt clips its chevrons, which would clip a crate's tag with them — so it
   stops clipping for exactly as long as the key is held. */
body.fx-alt .fx-belt {
  overflow: visible;
}
```

- [ ] **Step 5: Mount it and tag the bays and crates**

In `FactoryRoot.tsx`:

```tsx
  const alt = useAltMode();
  useEffect(() => {
    document.body.classList.toggle('fx-alt', alt);
    return () => document.body.classList.remove('fx-alt');
  }, [alt]);
```

In `TheLine.tsx`, add an `AltTag` inside each bay and crate (they are already `position: relative` for their existing absolute children — confirm in `skin.css` and add `position: relative` if not), carrying the values the bay already has:

```tsx
<AltTag>
  <span>
    {task?.originRef ?? 'free bay'}
    {task?.branch ? ` · ${task.branch}` : ''}
  </span>
</AltTag>
```

- [ ] **Step 6: Add the corner badge**

In `FactoryRoot.tsx`, render a fixed badge so the overlay is discoverable and reachable without the key:

```tsx
<button
  type="button"
  className={`fx-altbadge ${alt ? 'on' : ''}`}
  onClick={() => document.body.classList.toggle('fx-alt')}
  title="Hold Alt to show every machine's origin, branch and rule"
>
  Hold <kbd>Alt</kbd> for detail
</button>
```

Style it in `skin.css` as a fixed bottom-right chip using the existing `fx-bev` bevel treatment.

- [ ] **Step 7: Run the tests**

Run: `npx tsx --test test/factorySkin.test.ts`
Expected: PASS.

- [ ] **Step 8: Run the full check and commit**

Run: `npm run check`

```bash
git add web/src/skins/factory test/factorySkin.test.ts
git commit -m "Factory skin: hold Alt for every machine's origin, branch and rule"
```

---

### Task 8: Bot flight on dispatch

Pure decoration over a transition that has already happened. Safe to land or drop.

**Files:**
- Modify: `web/src/skins/factory/components/TheLine.tsx`
- Modify: `web/src/skins/factory/skin.css`
- Test: `test/factorySkin.test.ts`

**Interfaces:**
- Consumes: `inserterPhase(agent, now, intervalMs): InserterPhase` from `../vocabulary.js`, already imported by `TheLine`.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * The flight rides the existing dispatch window rather than a timer of its own, so a
 * dispatch that happened between polls draws no bot — correct, because there is
 * nothing to narrate by then. `inserterPhase` already decides that window and a
 * second one would be able to disagree with the inserter beside it.
 */
test('a bot flies only while a dispatch is in its window', () => {
  const flying = render();
  const stopped = render((s) => {
    s.control.paused = true;
  });
  assert.ok(
    (stopped.match(/fx-flight/g) ?? []).length === 0,
    'a paused floor dispatches nothing and flies nothing',
  );
  assert.ok(typeof flying === 'string');
});
```

- [ ] **Step 2: Run the test to verify it fails or passes**

Run: `npx tsx --test test/factorySkin.test.ts`
Expected: PASS trivially before the change (no `fx-flight` anywhere). This is a guard for the paused case; the positive case is verified by eye in step 5.

- [ ] **Step 3: Render the flight**

In `TheLine.tsx`, for each bay whose `inserterPhase(...)` is `'transfer'`, render a bot element positioned at the roboport and animated toward that bay's x:

```tsx
{phase === 'transfer' && (
  <span className="fx-flight" style={{ '--fx-fly-x': `${bayX(index)}px` } as CSSProperties} aria-hidden="true">
    <i />
  </span>
)}
```

- [ ] **Step 4: Animate it**

In `skin.css`:

```css
/* A logistic bot carrying the item from the port to the bay. Decoration over a
   transition already recorded — nothing waits on it, so it is the first thing
   `prefers-reduced-motion` drops. */
.fx-flight {
  position: absolute;
  left: 66px;
  top: 34px;
  pointer-events: none;
  animation: fx-fly 1.4s cubic-bezier(0.4, 0.05, 0.5, 0.95) forwards;
}
.fx-flight > i {
  display: block;
  width: 12px;
  height: 12px;
  background: var(--text);
  border: 1px solid var(--border-lo);
}
@keyframes fx-fly {
  0% {
    opacity: 0;
    transform: translate(0, 80px) scale(0.7);
  }
  15% {
    opacity: 1;
  }
  100% {
    opacity: 0;
    transform: translate(var(--fx-fly-x), 40px) scale(0.85);
  }
}
```

Add `.fx-flight` to the existing `@media (prefers-reduced-motion: reduce)` block at `skin.css:1755`, beside `.fx-sweep`, with `animation: none; display: none;`.

- [ ] **Step 5: Verify by eye**

Run the cockpit against the demo state and queue a job so a dispatch happens, or watch a real pulse. Confirm: one bot per dispatch, it arrives at the bay that filled, and nothing flies while paused.

- [ ] **Step 6: Run the full check and commit**

Run: `npm run check`

```bash
git add web/src/skins/factory test/factorySkin.test.ts
git commit -m "Factory skin: a bot carries the item from the port to the bay"
```

---

### Task 9: Update the cockpit spec

`CLAUDE.md`: when you change behaviour, update the spec document that owns it in the same change. Eight tasks of visual change is one spec update, done once at the end rather than eight partial ones.

**Files:**
- Modify: `docs/spec/17-cockpit.md`

- [ ] **Step 1: Read the factory-skin section**

Run: `grep -n "factory" docs/spec/17-cockpit.md`

- [ ] **Step 2: Write the changes in as fact**

The spec is written as fact, not as a changelog. Describe, in the document's existing voice and in the section that owns the skin: the lamp as a second renderer of `MachineStatus.tone`; the demoted caption and why it is never removed; Alt-mode as a display switch that adds nothing; belt tiers as queue pressure against the cap and the collapsed clear belt; the reason column's glyph and the never-guess rule; the row stripe reading `rackGroup` rather than a chip's colour; the quiet gauge dropping its zero while keeping its way in.

Do not describe the radar sweep as new — it already shipped and the spec may already cover it.

- [ ] **Step 3: Run the full check and commit**

Run: `npm run check`

```bash
git add docs/spec/17-cockpit.md
git commit -m "Spec: the factory skin's Factorio vocabulary"
```

---

## Notes for the implementer

- **`render()` in `test/factorySkin.test.ts` pins `Date.now`** to `2026-01-01T12:00:00Z` and renders the whole skin from the demo state. Most assertions here are regex over that markup. That is the established idiom in this file — follow it rather than introducing a DOM library.
- **`renderToStaticMarkup` cannot click**, which is why desks that open from a status-bar gauge are rendered through the separate `renderDesk` helper. If a change is only reachable behind a modal, render its component directly.
- **A skin draws its own tree and decides nothing.** If a task tempts you to compute a verdict in `web/src/skins/factory/**`, it is the wrong place — every value these tasks render already arrives on the snapshot.
- **The demo state is the fixture.** `buildDemoState()` seeds a world with agents, PRs, plans and crashed agents. Prefer mutating it in a `render((s) => …)` callback over hand-building a whole state.
